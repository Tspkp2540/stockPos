const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { requireRoles } = require('../middleware/auth');
const { addInventoryLot, restoreOrderLots } = require('../utils/inventoryLots');

// POST /api/orders - รับออเดอร์ใหม่
router.post('/orders', requireRoles('ADMIN', 'STAFF'), async (req, res) => {
  const { order_no, channel_id, items } = req.body;
  // items ตัวอย่าง: [ { product_id: 1, qty: 2, price: 50.00 } ]

  const client = await pool.connect();

  try {
    // 1. เริ่ม Transaction
    await client.query('BEGIN');

    // 2. ดึง % GP ของช่องทางขาย
    const channelRes = await client.query('SELECT gp_percent FROM channels WHERE id = $1', [channel_id]);
    const gpPercent = channelRes.rows[0]?.gp_percent || 0;

    let grossAmount = 0;
    let totalCogs = 0;

    // 3. สร้าง Order เริ่มต้น
    const orderRes = await client.query(
      `INSERT INTO orders (order_no, channel_id, gross_amount, net_revenue, status)
       VALUES ($1, $2, 0, 0, 'COOKING') RETURNING id`,
      [order_no, channel_id]
    );
    const orderId = orderRes.rows[0].id;

    // 4. วนลูปประมวลผลสินค้าแต่ละรายการ
    for (const item of items) {
      const subtotal = item.qty * item.price;
      grossAmount += subtotal;

      const recipeRes = await client.query(
        `SELECT r.ingredient_id, r.quantity_used, i.name, i.stock_qty
         FROM recipes r
         JOIN ingredients i ON i.id = r.ingredient_id
         WHERE r.product_id = $1
         FOR UPDATE`,
        [item.product_id]
      );
      for (const recipeItem of recipeRes.rows) {
        const requiredQty = Number(recipeItem.quantity_used) * Number(item.qty);
        if (Number(recipeItem.stock_qty) < requiredQty) {
          throw new Error(`Insufficient stock for ${recipeItem.name}: required ${requiredQty}, available ${recipeItem.stock_qty}`);
        }
      }

      // 4.1 บันทึกรายการลง order_items
      await client.query(
        `INSERT INTO order_items (order_id, product_id, quantity, unit_price, subtotal)
         VALUES ($1, $2, $3, $4, $5)`,
        [orderId, item.product_id, item.qty, item.price, subtotal]
      );

      // 4.2 ตัดสต็อควัตถุดิบตามสูตร (BOM)
      await client.query(
        `UPDATE ingredients ing
         SET stock_qty = ing.stock_qty - (r.quantity_used * $1),
             updated_at = CURRENT_TIMESTAMP
         FROM recipes r
         WHERE ing.id = r.ingredient_id AND r.product_id = $2`,
        [item.qty, item.product_id]
      );

      // 4.3 คำนวณต้นทุนวัตถุดิบ (COGS) ของรายการนี้
      const cogsRes = await client.query(
        `SELECT COALESCE(SUM(r.quantity_used * i.cost_per_unit * $1), 0) AS item_cogs
         FROM recipes r
         JOIN ingredients i ON r.ingredient_id = i.id
         WHERE r.product_id = $2`,
        [item.qty, item.product_id]
      );
      totalCogs += parseFloat(cogsRes.rows[0].item_cogs);
    }

    // 5. คำนวณสรุปยอดการเงิน
    const gpAmount = grossAmount * (gpPercent / 100);
    const netRevenue = grossAmount - gpAmount;
    const netProfit = netRevenue - totalCogs;

    // 6. อัปเดตตัวเลขสรุปกลับเข้า order
    const updatedOrderRes = await client.query(
      `UPDATE orders 
       SET gross_amount = $1, gp_amount = $2, net_revenue = $3, total_cogs = $4, net_profit = $5
       WHERE id = $6 RETURNING *`,
      [grossAmount, gpAmount, netRevenue, totalCogs, netProfit, orderId]
    );

    // 7. ยืนยัน บันทึกข้อมูลลง DB ทั้งหมด
    await client.query('COMMIT');

    const createdOrder = updatedOrderRes.rows[0];

    // 8. ยิง Real-time Event ผ่าน Socket.io ไปอัปเดตหน้าจอ 3D
    const io = req.app.get('socketio');
    if (io) {
      io.to('operations').emit('new_order_created', {
        order: createdOrder,
        message: `มีออเดอร์ใหม่ #${order_no} เข้ามาแล้ว!`
      });
    }

    res.status(201).json({ success: true, data: createdOrder });

  } catch (error) {
    // ถ้ามีปัญหาอะไรเกิดขึ้น ให้ Rollback ยกเลิกการตัดสต็อคทั้งหมด
    await client.query('ROLLBACK');
    console.error('Error processing order:', error);
    res.status(500).json({ success: false, error: error.message });
  } finally {
    client.release();
  }
});

// 📌 PUT /api/orders/:id/cancel - ยกเลิกออเดอร์ และ คืนสต็อควัตถุดิบ (Rollback Stock)
router.put('/:id/cancel', requireRoles('ADMIN', 'STAFF'), async (req, res) => {
  const { id } = req.params;
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 1. ตรวจสอบสถานะออเดอร์
    const orderRes = await client.query('SELECT status FROM orders WHERE id = $1', [id]);
    if (orderRes.rows.length === 0) {
      throw new Error('Order not found');
    }

    if (orderRes.rows[0].status === 'CANCELLED') {
      throw new Error('Order is already cancelled');
    }

    const previousIngredients = await client.query(
      `SELECT r.ingredient_id, SUM(r.quantity_used * oi.quantity) AS quantity_to_restore,
              MAX(i.cost_per_unit) AS unit_cost
       FROM order_items oi
       JOIN recipes r ON r.product_id = oi.product_id
       JOIN ingredients i ON i.id = r.ingredient_id
       WHERE oi.order_id = $1
       GROUP BY r.ingredient_id`,
      [id]
    );
    const restoredLotCount = await restoreOrderLots(client, id);

    // 2. คืนสต็อควัตถุดิบตามรายการใน Order Items และ Recipes
    await client.query(
      `UPDATE ingredients ing
       SET stock_qty = ing.stock_qty + (r.quantity_used * oi.quantity),
           updated_at = CURRENT_TIMESTAMP
       FROM order_items oi
       JOIN recipes r ON oi.product_id = r.product_id
       WHERE oi.order_id = $1 AND ing.id = r.ingredient_id`,
      [id]
    );

    // 3. อัปเดตสถานะออเดอร์เป็น CANCELLED และล้างยอดเงินกำไรเป็น 0
    const updatedOrder = await client.query(
      `UPDATE orders 
       SET status = 'CANCELLED', net_profit = 0, net_revenue = 0, gp_amount = 0 
       WHERE id = $1 RETURNING *`,
      [id]
    );
    if (!restoredLotCount) {
      for (const row of previousIngredients.rows) {
        await addInventoryLot(client, {
          ingredientId: row.ingredient_id,
          quantity: row.quantity_to_restore,
          unitCost: row.unit_cost,
          lotNo: `LEGACY-CANCEL-${id}-${row.ingredient_id}`,
        });
      }
    }
    await client.query(
      `UPDATE order_payments
       SET status = 'VOIDED'
       WHERE order_id = $1 AND status = 'PAID'`,
      [id]
    );

    await client.query('COMMIT');

    // ดึง Socket.io จาก app instance มายิงแจ้งเตือน Real-time
    const io = req.app.get('socketio');
    if (io) {
      io.to('operations').emit('order_cancelled', { orderId: id, message: `ออเดอร์ #${updatedOrder.rows[0].order_no} ถูกยกเลิกและคืนสต็อคแล้ว` });
    }

    res.json({
      success: true,
      message: 'Order cancelled and stock restored successfully',
      data: updatedOrder.rows[0]
    });

  } catch (error) {
    await client.query('ROLLBACK');
    res.status(400).json({ success: false, error: error.message });
  } finally {
    client.release();
  }
});

module.exports = router;
