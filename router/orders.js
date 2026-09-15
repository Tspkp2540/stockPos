const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { requireRoles } = require('../middleware/auth');
const { addInventoryLot, restoreOrderLots } = require('../utils/inventoryLots');

const assertBusinessDateOpen = async (client, businessDate) => {
  const result = await client.query(
    `SELECT id FROM daily_closings
     WHERE business_date = COALESCE($1::date, (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Bangkok')::date)
     LIMIT 1`,
    [businessDate]
  );
  if (result.rows.length) {
    throw Object.assign(new Error('วันทำการนี้ถูกปิดยอดแล้ว ไม่สามารถแก้ไขได้'), { statusCode: 409 });
  }
};

const roundMoney = (value) => Number((Number(value) || 0).toFixed(2));
const roundQuantity = (value) => Number((Number(value) || 0).toFixed(3));

// คืนสินค้าได้ทั้งบางรายการและทั้งหมด โดยใช้ล็อตเดิมที่ถูกตัดออกจากออเดอร์
// เพื่อให้สต็อกและต้นทุนกลับไปยังล็อตที่ถูกต้องเสมอ
router.post('/:id/returns', requireRoles('ADMIN', 'STAFF'), async (req, res) => {
  const orderId = Number(req.params.id);
  const reason = String(req.body?.reason || '').trim().slice(0, 500);
  const requestedItems = Array.isArray(req.body?.items) ? req.body.items : [];
  if (!Number.isInteger(orderId) || orderId <= 0 || !requestedItems.length) {
    return res.status(400).json({ success: false, error: 'กรุณาเลือกรายการที่ต้องการคืนสินค้า' });
  }

  const quantities = new Map();
  for (const input of requestedItems) {
    const orderItemId = Number(input?.order_item_id);
    const quantity = Number(input?.quantity);
    if (!Number.isInteger(orderItemId) || !Number.isFinite(quantity) || quantity <= 0) {
      return res.status(400).json({ success: false, error: 'จำนวนสินค้าเพื่อคืนไม่ถูกต้อง' });
    }
    quantities.set(orderItemId, roundQuantity((quantities.get(orderItemId) || 0) + quantity));
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const orderResult = await client.query(
      `SELECT o.id, o.order_no, o.status, o.subtotal_amount, o.gross_amount, o.loyalty_account_id,
              o.loyalty_points_earned, o.loyalty_points_redeemed, o.coupon_id, o.created_at,
              DATE(o.created_at AT TIME ZONE 'Asia/Bangkok')::text AS business_date,
              op.payment_method, op.status AS payment_status
       FROM orders o
       JOIN order_payments op ON op.order_id = o.id
       WHERE o.id = $1
       FOR UPDATE OF o, op`,
      [orderId]
    );
    const order = orderResult.rows[0];
    if (!order) throw Object.assign(new Error('ไม่พบคำสั่งซื้อหรือข้อมูลการชำระเงิน'), { statusCode: 404 });
    await assertBusinessDateOpen(client, order.business_date);
    if (['CANCELLED', 'RETURNED'].includes(order.status)) {
      throw Object.assign(new Error('คำสั่งซื้อนี้ไม่สามารถคืนสินค้าได้'), { statusCode: 409 });
    }
    if (order.payment_status !== 'PAID') {
      throw Object.assign(new Error('คำสั่งซื้อนี้ยังไม่ได้ชำระเงิน จึงไม่สามารถคืนเงินได้'), { statusCode: 409 });
    }

    const itemResult = await client.query(
      `SELECT oi.id, oi.product_id, oi.quantity, oi.unit_price, oi.subtotal, COALESCE(p.name, 'เมนูที่ถูกลบ') AS product_name,
              COALESCE((
                SELECT SUM(ori.quantity)
                FROM order_return_items ori
                JOIN order_returns previous_return ON previous_return.id = ori.return_id
                WHERE ori.order_item_id = oi.id
              ), 0) AS returned_quantity
       FROM order_items oi
       LEFT JOIN products p ON p.id = oi.product_id
       WHERE oi.order_id = $1
       FOR UPDATE OF oi`,
      [orderId]
    );
    const itemsById = new Map(itemResult.rows.map((item) => [Number(item.id), item]));
    let returnSubtotal = 0;
    for (const [orderItemId, quantity] of quantities) {
      const item = itemsById.get(orderItemId);
      if (!item) throw Object.assign(new Error('พบรายการสินค้าที่ไม่อยู่ในคำสั่งซื้อนี้'), { statusCode: 400 });
      const available = roundQuantity(Number(item.quantity) - Number(item.returned_quantity || 0));
      if (quantity > available + 0.000001) {
        throw Object.assign(new Error(`${item.product_name} คืนได้อีกไม่เกิน ${available}`), { statusCode: 409 });
      }
      returnSubtotal += quantity * Number(item.unit_price || 0);
    }
    if (returnSubtotal <= 0 || Number(order.gross_amount || 0) <= 0) {
      throw Object.assign(new Error('ยอดคืนเงินต้องมากกว่า 0'), { statusCode: 400 });
    }

    const previousReturnsResult = await client.query(
      `SELECT COALESCE(SUM(refund_amount), 0) AS refund_amount,
              COALESCE(SUM(points_earned_reversed), 0) AS points_earned_reversed,
              COALESCE(SUM(points_redeemed_restored), 0) AS points_redeemed_restored
       FROM order_returns WHERE order_id = $1`,
      [orderId]
    );
    const previousReturns = previousReturnsResult.rows[0];
    const priorRefundAmount = Number(previousReturns.refund_amount || 0);
    const remainingRefundAmount = roundMoney(Number(order.gross_amount) - priorRefundAmount);
    const allItemsFullyReturned = itemResult.rows.every((item) =>
      roundQuantity(Number(item.returned_quantity || 0) + Number(quantities.get(Number(item.id)) || 0)) >= Number(item.quantity) - 0.000001
    );
    const ratio = Number(order.subtotal_amount || 0) > 0
      ? Math.min(1, returnSubtotal / Number(order.subtotal_amount))
      : 0;
    let refundAmount = roundMoney(Number(order.gross_amount) * ratio);
    refundAmount = allItemsFullyReturned ? remainingRefundAmount : Math.min(refundAmount, remainingRefundAmount);
    if (refundAmount <= 0 || refundAmount > remainingRefundAmount + 0.005) {
      throw Object.assign(new Error('ยอดคืนเงินเกินกว่ายอดที่ชำระไว้'), { statusCode: 409 });
    }

    let cashShiftId = null;
    if (order.payment_method === 'CASH') {
      const activeShift = await client.query(
        `SELECT id FROM cash_shifts WHERE opened_by = $1 AND status = 'OPEN' FOR UPDATE`,
        [req.user.sub]
      );
      cashShiftId = activeShift.rows[0]?.id || null;
    }
    const returnNo = `RET-${order.id}-${Date.now().toString(36).toUpperCase()}`;
    const returnResult = await client.query(
      `INSERT INTO order_returns (return_no, order_id, cash_shift_id, returned_by, refund_method, refund_amount, reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [returnNo, orderId, cashShiftId, req.user.sub, order.payment_method, refundAmount, reason]
    );
    const returnRecord = returnResult.rows[0];
    let allocatedRefund = 0;
    let restoredCogs = 0;
    const returnedDetails = [];
    const quantityEntries = [...quantities.entries()];

    for (let index = 0; index < quantityEntries.length; index += 1) {
      const [orderItemId, quantity] = quantityEntries[index];
      const item = itemsById.get(orderItemId);
      const itemSubtotal = quantity * Number(item.unit_price || 0);
      const itemRefund = index === quantityEntries.length - 1
        ? roundMoney(refundAmount - allocatedRefund)
        : roundMoney(refundAmount * (itemSubtotal / returnSubtotal));
      allocatedRefund += itemRefund;
      const returnItemResult = await client.query(
        `INSERT INTO order_return_items (return_id, order_item_id, product_id, product_name, quantity, unit_price, refund_amount)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [returnRecord.id, item.id, item.product_id, item.product_name, quantity, item.unit_price, itemRefund]
      );
      const returnItem = returnItemResult.rows[0];
      const priorReturnedQuantity = Number(item.returned_quantity || 0);
      const cumulativeReturnedQuantity = roundQuantity(priorReturnedQuantity + quantity);
      const allocations = await client.query(
        `SELECT oila.id, oila.inventory_lot_id, oila.quantity, oila.unit_cost, il.ingredient_id
         FROM order_item_lot_allocations oila
         JOIN inventory_lots il ON il.id = oila.inventory_lot_id
         WHERE oila.order_item_id = $1
         FOR UPDATE OF il`,
        [item.id]
      );
      for (const allocation of allocations.rows) {
        const previouslyRestored = await client.query(
          `SELECT COALESCE(SUM(quantity), 0) AS quantity
           FROM order_return_lot_restorations WHERE order_item_lot_allocation_id = $1`,
          [allocation.id]
        );
        const targetRestore = roundQuantity(
          Number(allocation.quantity) * cumulativeReturnedQuantity / Number(item.quantity)
        );
        const restoreQuantity = roundQuantity(targetRestore - Number(previouslyRestored.rows[0].quantity || 0));
        if (restoreQuantity <= 0) continue;
        await client.query(
          `UPDATE inventory_lots
           SET remaining_quantity = remaining_quantity + $1, updated_at = CURRENT_TIMESTAMP
           WHERE id = $2`,
          [restoreQuantity, allocation.inventory_lot_id]
        );
        await client.query(
          `UPDATE ingredients SET stock_qty = stock_qty + $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
          [restoreQuantity, allocation.ingredient_id]
        );
        await client.query(
          `INSERT INTO order_return_lot_restorations
           (return_item_id, order_item_lot_allocation_id, inventory_lot_id, quantity, unit_cost)
           VALUES ($1, $2, $3, $4, $5)`,
          [returnItem.id, allocation.id, allocation.inventory_lot_id, restoreQuantity, allocation.unit_cost]
        );
        restoredCogs += restoreQuantity * Number(allocation.unit_cost || 0);
      }
      returnedDetails.push({ ...returnItem, product_name: item.product_name });
    }

    const cumulativeRefund = roundMoney(priorRefundAmount + refundAmount);
    const originalGross = Number(order.gross_amount || 0);
    const isFullyReturned = allItemsFullyReturned || cumulativeRefund >= originalGross - 0.005;
    const targetEarnedReversal = isFullyReturned
      ? Number(order.loyalty_points_earned || 0)
      : Math.floor(Number(order.loyalty_points_earned || 0) * cumulativeRefund / originalGross);
    const targetRedeemedRestore = isFullyReturned
      ? Number(order.loyalty_points_redeemed || 0)
      : Math.floor(Number(order.loyalty_points_redeemed || 0) * cumulativeRefund / originalGross);
    const earnedReversal = Math.max(0, targetEarnedReversal - Number(previousReturns.points_earned_reversed || 0));
    const redeemedRestoration = Math.max(0, targetRedeemedRestore - Number(previousReturns.points_redeemed_restored || 0));
    let couponUsageRestored = false;
    if (order.loyalty_account_id && (earnedReversal || redeemedRestoration)) {
      await client.query(
        `UPDATE loyalty_accounts
         SET points_balance = points_balance + $1 - $2, updated_at = CURRENT_TIMESTAMP
         WHERE id = $3`,
        [redeemedRestoration, earnedReversal, order.loyalty_account_id]
      );
      if (earnedReversal) {
        await client.query(
          `INSERT INTO loyalty_transactions (loyalty_account_id, order_id, transaction_type, points_delta, amount, note)
           VALUES ($1, $2, 'CANCEL_EARN_REVERSAL', $3, $4, $5)`,
          [order.loyalty_account_id, orderId, -earnedReversal, refundAmount, `Points reversed for return ${returnNo}`]
        );
      }
      if (redeemedRestoration) {
        await client.query(
          `INSERT INTO loyalty_transactions (loyalty_account_id, order_id, transaction_type, points_delta, amount, note)
           VALUES ($1, $2, 'CANCEL_REDEEM_REVERSAL', $3, $4, $5)`,
          [order.loyalty_account_id, orderId, redeemedRestoration, refundAmount, `Points restored for return ${returnNo}`]
        );
      }
    }
    if (isFullyReturned && order.coupon_id) {
      await client.query('UPDATE coupons SET used_count = GREATEST(used_count - 1, 0) WHERE id = $1', [order.coupon_id]);
      couponUsageRestored = true;
    }
    await client.query(
      `UPDATE order_returns
       SET points_earned_reversed = $1, points_redeemed_restored = $2, coupon_usage_restored = $3
       WHERE id = $4`,
      [earnedReversal, redeemedRestoration, couponUsageRestored, returnRecord.id]
    );
    if (isFullyReturned) {
      await client.query("UPDATE orders SET status = 'RETURNED' WHERE id = $1", [orderId]);
    }
    await client.query('COMMIT');
    req.auditSummary = {
      return_no: returnNo,
      order_no: order.order_no,
      refund_amount: refundAmount,
      refund_method: order.payment_method,
      item_count: returnedDetails.length,
      fully_returned: isFullyReturned,
    };
    const io = req.app.get('socketio');
    if (io) io.to('operations').emit('order_returned', { orderId, returnNo, refundAmount, fullyReturned: isFullyReturned });
    res.status(201).json({
      success: true,
      data: {
        return: { ...returnRecord, refund_amount: refundAmount, restored_cogs: roundMoney(restoredCogs), points_earned_reversed: earnedReversal, points_redeemed_restored: redeemedRestoration, coupon_usage_restored: couponUsageRestored },
        order: { id: orderId, status: isFullyReturned ? 'RETURNED' : order.status, refunded_amount: cumulativeRefund },
        items: returnedDetails,
      },
    });
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(error.statusCode || 400).json({ success: false, error: error.message });
  } finally {
    client.release();
  }
});

// POST /api/orders - รับออเดอร์ใหม่
router.post('/orders', requireRoles('ADMIN', 'STAFF'), async (req, res) => {
  const { order_no, channel_id, items } = req.body;
  // items ตัวอย่าง: [ { product_id: 1, qty: 2, price: 50.00 } ]

  const client = await pool.connect();

  try {
    // 1. เริ่ม Transaction
    await client.query('BEGIN');
    await assertBusinessDateOpen(client);

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
    const orderRes = await client.query(
      `SELECT id, status, DATE(created_at AT TIME ZONE 'Asia/Bangkok')::text AS business_date,
              loyalty_account_id, loyalty_points_earned, loyalty_points_redeemed,
              loyalty_discount_amount
       FROM orders WHERE id = $1 FOR UPDATE`,
      [id]
    );
    if (orderRes.rows.length === 0) {
      throw new Error('Order not found');
    }
    await assertBusinessDateOpen(client, orderRes.rows[0].business_date);

    if (orderRes.rows[0].status === 'CANCELLED') {
      throw new Error('Order is already cancelled');
    }
    const returnCheck = await client.query(
      'SELECT id FROM order_returns WHERE order_id = $1 LIMIT 1',
      [id]
    );
    if (returnCheck.rows.length) {
      throw Object.assign(new Error('คำสั่งซื้อนี้มีรายการคืนแล้ว จึงไม่สามารถยกเลิกซ้ำได้'), { statusCode: 409 });
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
    const loyaltyOrder = orderRes.rows[0];
    if (loyaltyOrder.loyalty_account_id) {
      const earnedPoints = Number(loyaltyOrder.loyalty_points_earned || 0);
      const redeemedPoints = Number(loyaltyOrder.loyalty_points_redeemed || 0);
      await client.query(
        `UPDATE loyalty_accounts
         SET points_balance = points_balance + $1 - $2, updated_at = CURRENT_TIMESTAMP
         WHERE id = $3`,
        [redeemedPoints, earnedPoints, loyaltyOrder.loyalty_account_id]
      );
      if (earnedPoints) {
        await client.query(
          `INSERT INTO loyalty_transactions (loyalty_account_id, order_id, transaction_type, points_delta, amount, note)
           VALUES ($1, $2, 'CANCEL_EARN_REVERSAL', $3, 0, 'Points reversed after order cancellation')`,
          [loyaltyOrder.loyalty_account_id, id, -earnedPoints]
        );
      }
      if (redeemedPoints) {
        await client.query(
          `INSERT INTO loyalty_transactions (loyalty_account_id, order_id, transaction_type, points_delta, amount, note)
           VALUES ($1, $2, 'CANCEL_REDEEM_REVERSAL', $3, $4, 'Redeemed points returned after order cancellation')`,
          [loyaltyOrder.loyalty_account_id, id, redeemedPoints, Number(loyaltyOrder.loyalty_discount_amount || 0)]
        );
      }
    }

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
    res.status(error.statusCode || 400).json({ success: false, error: error.message });
  } finally {
    client.release();
  }
});

module.exports = router;
