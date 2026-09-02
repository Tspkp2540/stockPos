const express = require('express');
const pool = require('../config/db');
const { createStockReceipt, normalizeReceiptItems } = require('../utils/stockReceiving');

const router = express.Router();
const text = (value, maxLength = 1000) => String(value || '').trim().slice(0, maxLength);
const newPurchaseOrderNo = () => `PO-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
const validDate = (value) => !value || (/^\d{4}-\d{2}-\d{2}$/.test(String(value)) && !Number.isNaN(new Date(`${value}T00:00:00`).getTime()));

const normalizeOrderItems = (items) => {
  if (!Array.isArray(items) || !items.length) throw new Error('ต้องมีรายการสั่งซื้ออย่างน้อย 1 รายการ');
  return items.map((item) => {
    const ingredientId = Number(item?.ingredient_id);
    const quantity = Number(item?.quantity);
    const unitCost = Number(item?.unit_cost ?? 0);
    if (!Number.isInteger(ingredientId) || ingredientId <= 0 || !Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(unitCost) || unitCost < 0) {
      throw new Error('ข้อมูลรายการสั่งซื้อไม่ถูกต้อง');
    }
    return { ingredient_id: ingredientId, quantity, unit_cost: unitCost };
  });
};

const supplierIdFrom = (value) => value === '' || value === null || value === undefined ? null : Number(value);
const purchaseOrderSelect = `
  SELECT po.id, po.po_no, po.supplier_id, po.status, po.expected_date, po.note,
         po.created_at, po.sent_at, po.received_at, po.cancelled_at,
         s.name AS supplier_name, u.full_name AS created_by_name,
         (SELECT sr.id FROM stock_receipts sr WHERE sr.purchase_order_id = po.id ORDER BY sr.id DESC LIMIT 1) AS receipt_id,
         (SELECT sr.receipt_no FROM stock_receipts sr WHERE sr.purchase_order_id = po.id ORDER BY sr.id DESC LIMIT 1) AS receipt_no,
         COALESCE((
           SELECT json_agg(json_build_object(
             'id', poi.id, 'ingredient_id', poi.ingredient_id, 'ingredient_name', i.name,
             'unit', i.unit, 'quantity', poi.quantity, 'unit_cost', poi.unit_cost, 'line_total', poi.line_total
           ) ORDER BY poi.id)
           FROM purchase_order_items poi
           JOIN ingredients i ON i.id = poi.ingredient_id
           WHERE poi.purchase_order_id = po.id
         ), '[]'::json) AS items
  FROM purchase_orders po
  LEFT JOIN suppliers s ON s.id = po.supplier_id
  LEFT JOIN users u ON u.id = po.created_by
`;

const getPurchaseOrder = async (client, id) => {
  const result = await client.query(`${purchaseOrderSelect} WHERE po.id = $1`, [id]);
  return result.rows[0] || null;
};

router.get('/', async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query?.limit) || 30, 1), 100);
  try {
    const result = await pool.query(`${purchaseOrderSelect} ORDER BY po.created_at DESC, po.id DESC LIMIT $1`, [limit]);
    res.json({ success: true, data: result.rows });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/', async (req, res) => {
  let items;
  try {
    items = normalizeOrderItems(req.body?.items);
  } catch (error) {
    return res.status(400).json({ success: false, error: error.message });
  }
  const supplierId = supplierIdFrom(req.body?.supplier_id);
  const expectedDate = req.body?.expected_date ? String(req.body.expected_date).slice(0, 10) : null;
  if ((supplierId !== null && (!Number.isInteger(supplierId) || supplierId <= 0)) || !validDate(expectedDate)) {
    return res.status(400).json({ success: false, error: 'ผู้ขายหรือวันที่คาดว่าจะได้รับไม่ถูกต้อง' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (supplierId !== null) {
      const supplier = await client.query('SELECT id FROM suppliers WHERE id = $1 AND is_active = TRUE', [supplierId]);
      if (!supplier.rows.length) throw new Error('ไม่พบผู้ขายหรือผู้ขายถูกปิดใช้งาน');
    }
    const created = await client.query(
      `INSERT INTO purchase_orders (po_no, supplier_id, expected_date, note, created_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [newPurchaseOrderNo(), supplierId, expectedDate, text(req.body?.note), req.user?.sub || null]
    );
    const purchaseOrderId = created.rows[0].id;
    for (const item of items) {
      const ingredient = await client.query('SELECT id FROM ingredients WHERE id = $1', [item.ingredient_id]);
      if (!ingredient.rows.length) throw new Error(`ไม่พบวัตถุดิบ #${item.ingredient_id}`);
      const lineTotal = Number((item.quantity * item.unit_cost).toFixed(2));
      await client.query(
        `INSERT INTO purchase_order_items (purchase_order_id, ingredient_id, quantity, unit_cost, line_total)
         VALUES ($1, $2, $3, $4, $5)`,
        [purchaseOrderId, item.ingredient_id, item.quantity, item.unit_cost, lineTotal]
      );
    }
    const order = await getPurchaseOrder(client, purchaseOrderId);
    await client.query('COMMIT');
    res.status(201).json({ success: true, data: order });
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(400).json({ success: false, error: error.message });
  } finally {
    client.release();
  }
});

router.patch('/:id/status', async (req, res) => {
  const nextStatus = String(req.body?.status || '').trim().toUpperCase();
  if (!['SENT', 'CANCELLED'].includes(nextStatus)) {
    return res.status(400).json({ success: false, error: 'สถานะใบสั่งซื้อไม่ถูกต้อง' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = await client.query('SELECT id, status FROM purchase_orders WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (!current.rows.length) throw new Error('ไม่พบใบสั่งซื้อ');
    const status = current.rows[0].status;
    if (nextStatus === 'SENT' && status !== 'DRAFT') throw new Error('ส่งใบสั่งซื้อได้เฉพาะฉบับร่าง');
    if (nextStatus === 'CANCELLED' && !['DRAFT', 'SENT'].includes(status)) throw new Error('ไม่สามารถยกเลิกใบสั่งซื้อนี้ได้');
    await client.query(
      `UPDATE purchase_orders
       SET status = $1,
           sent_at = CASE WHEN $1 = 'SENT' THEN CURRENT_TIMESTAMP ELSE sent_at END,
           cancelled_at = CASE WHEN $1 = 'CANCELLED' THEN CURRENT_TIMESTAMP ELSE cancelled_at END
       WHERE id = $2`,
      [nextStatus, req.params.id]
    );
    const order = await getPurchaseOrder(client, req.params.id);
    await client.query('COMMIT');
    res.json({ success: true, data: order });
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(error.message === 'ไม่พบใบสั่งซื้อ' ? 404 : 400).json({ success: false, error: error.message });
  } finally {
    client.release();
  }
});

router.post('/:id/receive', async (req, res) => {
  const receivedAt = req.body?.received_at ? new Date(req.body.received_at) : new Date();
  if (Number.isNaN(receivedAt.getTime())) return res.status(400).json({ success: false, error: 'วันเวลารับของไม่ถูกต้อง' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = await client.query(
      'SELECT id, po_no, supplier_id, status FROM purchase_orders WHERE id = $1 FOR UPDATE',
      [req.params.id]
    );
    if (!current.rows.length) throw new Error('ไม่พบใบสั่งซื้อ');
    const purchaseOrder = current.rows[0];
    if (!['DRAFT', 'SENT'].includes(purchaseOrder.status)) throw new Error('ใบสั่งซื้อนี้ไม่สามารถรับของซ้ำได้');
    let items;
    if (Array.isArray(req.body?.items) && req.body.items.length) {
      items = normalizeReceiptItems(req.body.items);
    } else {
      const orderItems = await client.query(
        'SELECT ingredient_id, quantity, unit_cost FROM purchase_order_items WHERE purchase_order_id = $1 ORDER BY id',
        [purchaseOrder.id]
      );
      items = normalizeReceiptItems(orderItems.rows);
    }
    const receipt = await createStockReceipt({
      client,
      items,
      supplierId: purchaseOrder.supplier_id,
      receivedAt,
      note: `รับของตาม ${purchaseOrder.po_no}${text(req.body?.note) ? ` · ${text(req.body.note)}` : ''}`,
      createdBy: req.user?.sub || null,
      purchaseOrderId: purchaseOrder.id,
      verifySupplier: false,
    });
    await client.query(
      `UPDATE purchase_orders
       SET status = 'RECEIVED', received_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [purchaseOrder.id]
    );
    const order = await getPurchaseOrder(client, purchaseOrder.id);
    await client.query('COMMIT');
    res.json({ success: true, data: { purchase_order: order, receipt } });
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(error.message === 'ไม่พบใบสั่งซื้อ' ? 404 : 400).json({ success: false, error: error.message });
  } finally {
    client.release();
  }
});

module.exports = router;
