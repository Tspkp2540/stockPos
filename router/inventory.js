const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { addInventoryLot, applyLotAdjustment, automaticLotNo } = require('../utils/inventoryLots');

const numeric = (value) => Number(value);
const text = (value, maxLength = 500) => String(value || '').trim().slice(0, maxLength);
const newReceiptNo = () => `RCV-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
const validDate = (value) => !value || (/^\d{4}-\d{2}-\d{2}$/.test(String(value)) && !Number.isNaN(new Date(`${value}T00:00:00`).getTime()));
const normalizeReceiptItems = (items) => {
  if (!Array.isArray(items) || !items.length) throw new Error('ต้องมีรายการวัตถุดิบอย่างน้อย 1 รายการ');
  return items.map((item) => {
    const ingredientId = Number(item?.ingredient_id);
    const quantity = numeric(item?.quantity);
    const unitCost = numeric(item?.unit_cost);
    const expiryDate = item?.expiry_date ? String(item.expiry_date).slice(0, 10) : null;
    if (!Number.isInteger(ingredientId) || ingredientId <= 0 || !Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(unitCost) || unitCost < 0 || !validDate(expiryDate)) {
      throw new Error('ข้อมูลรายการรับวัตถุดิบไม่ถูกต้อง');
    }
    return {
      ingredient_id: ingredientId,
      quantity,
      unit_cost: unitCost,
      lot_no: text(item?.lot_no, 100),
      expiry_date: expiryDate,
    };
  });
};

// 📌 GET /api/inventory - ดึงรายการวัตถุดิบทั้งหมด
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT i.*,
        CASE 
          WHEN i.stock_qty <= i.min_stock_alert THEN true
          ELSE false 
        END AS is_low_stock,
        (SELECT MIN(il.expiry_date)
         FROM inventory_lots il
         WHERE il.ingredient_id = i.id AND il.remaining_quantity > 0 AND il.expiry_date IS NOT NULL) AS next_expiry_date,
        (SELECT COUNT(*) FROM inventory_lots il WHERE il.ingredient_id = i.id AND il.remaining_quantity > 0) AS active_lot_count
       FROM ingredients i
       ORDER BY i.id ASC`
    );
    res.json({ success: true, data: result.rows });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ล็อตที่ยังเหลือสำหรับตรวจสอบอายุและย้อนกลับการรับของ
router.get('/lots', async (req, res) => {
  const ingredientId = req.query?.ingredient_id ? Number(req.query.ingredient_id) : null;
  const activeOnly = String(req.query?.active || 'true') !== 'false';
  const limit = Math.min(Math.max(Number(req.query?.limit) || 300, 1), 1000);
  if (ingredientId !== null && (!Number.isInteger(ingredientId) || ingredientId <= 0)) {
    return res.status(400).json({ success: false, error: 'รหัสวัตถุดิบไม่ถูกต้อง' });
  }
  try {
    const result = await pool.query(
      `SELECT il.id, il.ingredient_id, i.name AS ingredient_name, i.unit, il.lot_no,
              il.received_at, il.expiry_date, il.initial_quantity, il.remaining_quantity, il.unit_cost,
              sr.receipt_no, s.name AS supplier_name
       FROM inventory_lots il
       JOIN ingredients i ON i.id = il.ingredient_id
       LEFT JOIN stock_receipt_items sri ON sri.id = il.stock_receipt_item_id
       LEFT JOIN stock_receipts sr ON sr.id = sri.receipt_id
       LEFT JOIN suppliers s ON s.id = sr.supplier_id
       WHERE ($1::bigint IS NULL OR il.ingredient_id = $1)
         AND ($2::boolean = FALSE OR il.remaining_quantity > 0)
       ORDER BY il.expiry_date ASC NULLS LAST, il.received_at ASC, il.id ASC
       LIMIT $3`,
      [ingredientId, activeOnly, limit]
    );
    res.json({ success: true, data: result.rows });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ผู้ขายวัตถุดิบ
router.get('/suppliers', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, contact_name, phone, email, address, is_active, created_at, updated_at
       FROM suppliers ORDER BY is_active DESC, name ASC`
    );
    res.json({ success: true, data: result.rows });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/suppliers', async (req, res) => {
  const name = text(req.body?.name, 160);
  if (!name) return res.status(400).json({ success: false, error: 'กรุณาระบุชื่อผู้ขาย' });
  try {
    const result = await pool.query(
      `INSERT INTO suppliers (name, contact_name, phone, email, address)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name, contact_name, phone, email, address, is_active, created_at, updated_at`,
      [name, text(req.body?.contact_name, 120), text(req.body?.phone, 30), text(req.body?.email, 160), text(req.body?.address, 1000)]
    );
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ success: false, error: 'มีผู้ขายชื่อนี้แล้ว' });
    res.status(500).json({ success: false, error: error.message });
  }
});

router.put('/suppliers/:id', async (req, res) => {
  const name = text(req.body?.name, 160);
  if (!name) return res.status(400).json({ success: false, error: 'กรุณาระบุชื่อผู้ขาย' });
  try {
    const result = await pool.query(
      `UPDATE suppliers
       SET name = $1, contact_name = $2, phone = $3, email = $4, address = $5,
           is_active = COALESCE($6, is_active), updated_at = CURRENT_TIMESTAMP
       WHERE id = $7
       RETURNING id, name, contact_name, phone, email, address, is_active, created_at, updated_at`,
      [
        name,
        text(req.body?.contact_name, 120),
        text(req.body?.phone, 30),
        text(req.body?.email, 160),
        text(req.body?.address, 1000),
        typeof req.body?.is_active === 'boolean' ? req.body.is_active : null,
        req.params.id,
      ]
    );
    if (!result.rows.length) return res.status(404).json({ success: false, error: 'ไม่พบผู้ขาย' });
    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ success: false, error: 'มีผู้ขายชื่อนี้แล้ว' });
    res.status(500).json({ success: false, error: error.message });
  }
});

// ใบรับวัตถุดิบ: บันทึกประวัติผู้ขาย ต้นทุน และปรับต้นทุนเฉลี่ยของวัตถุดิบใน transaction เดียว
router.get('/receipts', async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query?.limit) || 20, 1), 100);
  try {
    const result = await pool.query(
      `SELECT sr.id, sr.receipt_no, sr.received_at, sr.note, sr.total_amount, sr.created_at,
              s.id AS supplier_id, s.name AS supplier_name, u.full_name AS created_by_name,
              COALESCE((
                SELECT json_agg(json_build_object(
                  'id', sri.id, 'ingredient_id', sri.ingredient_id, 'ingredient_name', i.name,
                  'unit', i.unit, 'quantity', sri.quantity, 'unit_cost', sri.unit_cost, 'line_total', sri.line_total,
                  'lot_no', il.lot_no, 'expiry_date', il.expiry_date
                ) ORDER BY sri.id)
                FROM stock_receipt_items sri
                JOIN ingredients i ON i.id = sri.ingredient_id
                LEFT JOIN inventory_lots il ON il.stock_receipt_item_id = sri.id
                WHERE sri.receipt_id = sr.id
              ), '[]'::json) AS items
       FROM stock_receipts sr
       LEFT JOIN suppliers s ON s.id = sr.supplier_id
       LEFT JOIN users u ON u.id = sr.created_by
       ORDER BY sr.received_at DESC, sr.id DESC
       LIMIT $1`,
      [limit]
    );
    res.json({ success: true, data: result.rows });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/receipts', async (req, res) => {
  let items;
  try {
    items = normalizeReceiptItems(req.body?.items);
  } catch (error) {
    return res.status(400).json({ success: false, error: error.message });
  }
  const supplierId = req.body?.supplier_id === '' || req.body?.supplier_id === null || req.body?.supplier_id === undefined
    ? null
    : Number(req.body.supplier_id);
  if (supplierId !== null && (!Number.isInteger(supplierId) || supplierId <= 0)) {
    return res.status(400).json({ success: false, error: 'ผู้ขายไม่ถูกต้อง' });
  }
  const receivedAt = req.body?.received_at ? new Date(req.body.received_at) : new Date();
  if (Number.isNaN(receivedAt.getTime())) return res.status(400).json({ success: false, error: 'วันเวลารับของไม่ถูกต้อง' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (supplierId !== null) {
      const supplier = await client.query('SELECT id FROM suppliers WHERE id = $1 AND is_active = TRUE', [supplierId]);
      if (!supplier.rows.length) throw new Error('ไม่พบผู้ขายหรือผู้ขายถูกปิดใช้งาน');
    }
    const receipt = await client.query(
      `INSERT INTO stock_receipts (receipt_no, supplier_id, received_at, note, total_amount, created_by)
       VALUES ($1, $2, $3, $4, 0, $5) RETURNING id, receipt_no`,
      [newReceiptNo(), supplierId, receivedAt.toISOString(), text(req.body?.note, 1000), req.user?.sub || null]
    );
    const receiptId = receipt.rows[0].id;
    const updatedIngredients = [];
    const createdLots = [];
    let totalAmount = 0;
    for (const item of items) {
      const ingredient = await client.query(
        'SELECT id, name, unit, stock_qty, cost_per_unit FROM ingredients WHERE id = $1 FOR UPDATE',
        [item.ingredient_id]
      );
      if (!ingredient.rows.length) throw new Error(`ไม่พบวัตถุดิบ #${item.ingredient_id}`);
      const current = ingredient.rows[0];
      const previousQty = Math.max(0, Number(current.stock_qty || 0));
      const nextQty = previousQty + item.quantity;
      const nextCost = ((previousQty * Number(current.cost_per_unit || 0)) + (item.quantity * item.unit_cost)) / nextQty;
      const lineTotal = Number((item.quantity * item.unit_cost).toFixed(2));
      const updated = await client.query(
        `UPDATE ingredients
         SET stock_qty = $1, cost_per_unit = $2, updated_at = CURRENT_TIMESTAMP
         WHERE id = $3
         RETURNING *, CASE WHEN stock_qty <= min_stock_alert THEN true ELSE false END AS is_low_stock`,
        [nextQty, Number(nextCost.toFixed(4)), item.ingredient_id]
      );
      const receiptItem = await client.query(
        `INSERT INTO stock_receipt_items (receipt_id, ingredient_id, quantity, unit_cost, line_total)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [receiptId, item.ingredient_id, item.quantity, item.unit_cost, lineTotal]
      );
      const lot = await addInventoryLot(client, {
        ingredientId: item.ingredient_id,
        receiptItemId: receiptItem.rows[0].id,
        quantity: item.quantity,
        unitCost: item.unit_cost,
        lotNo: item.lot_no || automaticLotNo('RCV'),
        receivedAt,
        expiryDate: item.expiry_date,
      });
      await client.query(
        `INSERT INTO inventory_movements
         (ingredient_id, movement_type, quantity_change, unit_cost, reference_type, reference_id, note, created_by)
         VALUES ($1, 'PURCHASE', $2, $3, 'STOCK_RECEIPT', $4, $5, $6)`,
        [item.ingredient_id, item.quantity, item.unit_cost, receiptId, text(req.body?.note, 1000), req.user?.sub || null]
      );
      totalAmount += lineTotal;
      updatedIngredients.push(updated.rows[0]);
      createdLots.push(lot);
    }
    const finalized = await client.query(
      `UPDATE stock_receipts SET total_amount = $1 WHERE id = $2
       RETURNING id, receipt_no, supplier_id, received_at, note, total_amount, created_at`,
      [Number(totalAmount.toFixed(2)), receiptId]
    );
    await client.query('COMMIT');
    res.status(201).json({ success: true, data: { ...finalized.rows[0], updated_ingredients: updatedIngredients, created_lots: createdLots } });
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(400).json({ success: false, error: error.message });
  } finally {
    client.release();
  }
});

router.get('/movements', async (req, res) => {
  const ingredientId = req.query?.ingredient_id ? Number(req.query.ingredient_id) : null;
  const limit = Math.min(Math.max(Number(req.query?.limit) || 50, 1), 200);
  if (ingredientId !== null && (!Number.isInteger(ingredientId) || ingredientId <= 0)) {
    return res.status(400).json({ success: false, error: 'รหัสวัตถุดิบไม่ถูกต้อง' });
  }
  try {
    const result = await pool.query(
      `SELECT im.id, im.ingredient_id, i.name AS ingredient_name, i.unit, im.movement_type,
              im.quantity_change, im.unit_cost, im.reference_type, im.reference_id, im.note, im.created_at,
              u.full_name AS created_by_name
       FROM inventory_movements im
       JOIN ingredients i ON i.id = im.ingredient_id
       LEFT JOIN users u ON u.id = im.created_by
       WHERE ($1::bigint IS NULL OR im.ingredient_id = $1)
       ORDER BY im.created_at DESC, im.id DESC
       LIMIT $2`,
      [ingredientId, limit]
    );
    res.json({ success: true, data: result.rows });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ตรวจนับยอดจริงหรือบันทึกของเสีย โดยเก็บส่วนต่างในประวัติการเคลื่อนไหวสต็อก
router.post('/adjustments', async (req, res) => {
  const ingredientId = Number(req.body?.ingredient_id);
  const adjustmentType = String(req.body?.adjustment_type || '').trim().toUpperCase();
  const note = text(req.body?.note, 1000);
  if (!Number.isInteger(ingredientId) || ingredientId <= 0 || !['STOCK_COUNT', 'WASTE'].includes(adjustmentType)) {
    return res.status(400).json({ success: false, error: 'ข้อมูลการปรับยอดไม่ถูกต้อง' });
  }
  const actualQuantity = numeric(req.body?.actual_quantity);
  const wasteQuantity = numeric(req.body?.waste_quantity);
  if (
    (adjustmentType === 'STOCK_COUNT' && (!Number.isFinite(actualQuantity) || actualQuantity < 0)) ||
    (adjustmentType === 'WASTE' && (!Number.isFinite(wasteQuantity) || wasteQuantity <= 0))
  ) {
    return res.status(400).json({ success: false, error: 'จำนวนที่ระบุไม่ถูกต้อง' });
  }
  if (adjustmentType === 'WASTE' && !note) {
    return res.status(400).json({ success: false, error: 'กรุณาระบุเหตุผลของของเสีย' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = await client.query(
      'SELECT id, name, stock_qty, cost_per_unit FROM ingredients WHERE id = $1 FOR UPDATE',
      [ingredientId]
    );
    if (!current.rows.length) throw new Error('Ingredient not found');
    const ingredient = current.rows[0];
    const currentQty = Number(ingredient.stock_qty || 0);
    const nextQty = adjustmentType === 'STOCK_COUNT' ? actualQuantity : currentQty - wasteQuantity;
    if (nextQty < 0) throw new Error('ยอดของเสียมากกว่าสต็อกคงเหลือ');
    const difference = Number((nextQty - currentQty).toFixed(3));
    const affectedLots = await applyLotAdjustment(client, {
      ingredientId,
      difference,
      unitCost: ingredient.cost_per_unit,
      note: note || 'ตรวจนับสต็อก',
    });
    const updated = await client.query(
      `UPDATE ingredients
       SET stock_qty = $1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2
       RETURNING *, CASE WHEN stock_qty <= min_stock_alert THEN true ELSE false END AS is_low_stock`,
      [nextQty, ingredientId]
    );
    await client.query(
      `INSERT INTO inventory_movements
       (ingredient_id, movement_type, quantity_change, unit_cost, reference_type, note, created_by)
       VALUES ($1, 'ADJUSTMENT', $2, $3, $4, $5, $6)`,
      [ingredientId, difference, ingredient.cost_per_unit, adjustmentType, note || 'ตรวจนับสต็อก', req.user?.sub || null]
    );
    await client.query('COMMIT');
    res.json({
      success: true,
      data: { ingredient: updated.rows[0], difference, adjustment_type: adjustmentType, affected_lots: affectedLots },
    });
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(error.message === 'Ingredient not found' ? 404 : 400).json({ success: false, error: error.message });
  } finally {
    client.release();
  }
});

// POST /api/inventory - เพิ่มวัตถุดิบใหม่
router.post('/', async (req, res) => {
  const { name, unit, stock_qty, cost_per_unit, min_stock_alert, expiry_date } = req.body;
  const stock = Number(stock_qty || 0);

  if (!name || !unit || !Number.isFinite(stock) || stock < 0) {
    return res.status(400).json({ success: false, error: 'Invalid inventory payload' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `INSERT INTO ingredients (name, unit, stock_qty, cost_per_unit, min_stock_alert, expiry_date)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *,
       CASE WHEN stock_qty <= min_stock_alert THEN true ELSE false END AS is_low_stock`,
      [name, unit, stock, Number(cost_per_unit || 0), Number(min_stock_alert || 0), expiry_date || null]
    );
    if (stock > 0) {
      await addInventoryLot(client, {
        ingredientId: result.rows[0].id,
        quantity: stock,
        unitCost: Number(cost_per_unit || 0),
        lotNo: automaticLotNo('OPENING'),
        expiryDate: expiry_date || null,
      });
    }
    await client.query('COMMIT');
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(500).json({ success: false, error: error.message });
  } finally {
    client.release();
  }
});

// PUT /api/inventory/:id - แก้ไขวัตถุดิบ
router.put('/:id', async (req, res) => {
  const { name, unit, stock_qty, cost_per_unit, min_stock_alert, expiry_date } = req.body;
  const stock = Number(stock_qty);

  if (!name || !unit || !Number.isFinite(stock) || stock < 0) {
    return res.status(400).json({ success: false, error: 'Invalid inventory payload' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = await client.query('SELECT id, stock_qty, cost_per_unit FROM ingredients WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (!current.rows.length) throw new Error('Ingredient not found');
    const difference = Number((stock - Number(current.rows[0].stock_qty || 0)).toFixed(3));
    await applyLotAdjustment(client, {
      ingredientId: Number(req.params.id),
      difference,
      unitCost: Number(cost_per_unit || current.rows[0].cost_per_unit || 0),
      note: 'แก้ไขยอดคงเหลือจากหน้าวัตถุดิบ',
    });
    const result = await client.query(
      `UPDATE ingredients
       SET name = $1, unit = $2, stock_qty = $3, cost_per_unit = $4,
           min_stock_alert = $5, expiry_date = $6, updated_at = CURRENT_TIMESTAMP
       WHERE id = $7
       RETURNING *, CASE WHEN stock_qty <= min_stock_alert THEN true ELSE false END AS is_low_stock`,
      [name, unit, stock, Number(cost_per_unit || 0), Number(min_stock_alert || 0), expiry_date || null, req.params.id]
    );

    if (!result.rows.length) throw new Error('Ingredient not found');
    await client.query('COMMIT');
    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(error.message === 'Ingredient not found' ? 404 : 400).json({ success: false, error: error.message });
  } finally {
    client.release();
  }
});

// DELETE /api/inventory/:id - ลบวัตถุดิบ
router.delete('/:id', async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM ingredients WHERE id = $1 RETURNING id', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ success: false, error: 'Ingredient not found' });
    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 📌 POST /api/inventory/restock - เติมสต็อควัตถุดิบ
router.post('/restock', async (req, res) => {
  const { ingredient_id, qty_to_add, new_cost_per_unit } = req.body;
  const quantity = numeric(qty_to_add);
  const hasNewCost = new_cost_per_unit !== undefined && new_cost_per_unit !== null && new_cost_per_unit !== '';
  const unitCost = hasNewCost ? numeric(new_cost_per_unit) : null;

  if (!Number.isInteger(Number(ingredient_id)) || !Number.isFinite(quantity) || quantity <= 0 || (hasNewCost && (!Number.isFinite(unitCost) || unitCost < 0))) {
    return res.status(400).json({ success: false, error: 'Invalid payload' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = await client.query(
      'SELECT id, stock_qty, cost_per_unit FROM ingredients WHERE id = $1 FOR UPDATE',
      [ingredient_id]
    );
    if (!current.rows.length) throw new Error('Ingredient not found');
    const existing = current.rows[0];
    const nextQty = Number(existing.stock_qty || 0) + quantity;
    const nextCost = hasNewCost
      ? ((Math.max(0, Number(existing.stock_qty || 0)) * Number(existing.cost_per_unit || 0)) + (quantity * unitCost)) / nextQty
      : Number(existing.cost_per_unit || 0);
    const result = await client.query(
      `UPDATE ingredients
       SET stock_qty = $1, cost_per_unit = $2, updated_at = CURRENT_TIMESTAMP
       WHERE id = $3
       RETURNING *, CASE WHEN stock_qty <= min_stock_alert THEN true ELSE false END AS is_low_stock`,
      [nextQty, Number(nextCost.toFixed(4)), ingredient_id]
    );
    const lot = await addInventoryLot(client, {
      ingredientId: Number(ingredient_id),
      quantity,
      unitCost: hasNewCost ? unitCost : Number(existing.cost_per_unit || 0),
      lotNo: text(req.body?.lot_no, 100) || automaticLotNo('RESTOCK'),
      expiryDate: req.body?.expiry_date && validDate(String(req.body.expiry_date).slice(0, 10))
        ? String(req.body.expiry_date).slice(0, 10)
        : null,
    });
    await client.query(
      `INSERT INTO inventory_movements
       (ingredient_id, movement_type, quantity_change, unit_cost, reference_type, note, created_by)
       VALUES ($1, 'MANUAL_RESTOCK', $2, $3, 'MANUAL_RESTOCK', $4, $5)`,
      [ingredient_id, quantity, hasNewCost ? unitCost : null, text(req.body?.note || 'เติมสต็อกด่วนจากหน้าวัตถุดิบ', 1000), req.user?.sub || null]
    );
    await client.query('COMMIT');

    res.json({
      success: true,
      message: 'Restocked successfully',
      data: { ...result.rows[0], created_lot: lot }
    });
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(error.message === 'Ingredient not found' ? 404 : 500).json({ success: false, error: error.message });
  } finally {
    client.release();
  }
});

module.exports = router;
