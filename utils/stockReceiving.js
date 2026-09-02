const { addInventoryLot, automaticLotNo } = require('./inventoryLots');

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

const createStockReceipt = async ({
  client,
  items,
  supplierId = null,
  receivedAt = new Date(),
  note = '',
  createdBy = null,
  purchaseOrderId = null,
  verifySupplier = true,
}) => {
  if (supplierId !== null && verifySupplier) {
    const supplier = await client.query('SELECT id FROM suppliers WHERE id = $1 AND is_active = TRUE', [supplierId]);
    if (!supplier.rows.length) throw new Error('ไม่พบผู้ขายหรือผู้ขายถูกปิดใช้งาน');
  }
  const receipt = await client.query(
    `INSERT INTO stock_receipts (receipt_no, supplier_id, purchase_order_id, received_at, note, total_amount, created_by)
     VALUES ($1, $2, $3, $4, $5, 0, $6) RETURNING id, receipt_no`,
    [newReceiptNo(), supplierId, purchaseOrderId, receivedAt.toISOString(), text(note, 1000), createdBy]
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
      [item.ingredient_id, item.quantity, item.unit_cost, receiptId, text(note, 1000), createdBy]
    );
    totalAmount += lineTotal;
    updatedIngredients.push(updated.rows[0]);
    createdLots.push(lot);
  }
  const finalized = await client.query(
    `UPDATE stock_receipts SET total_amount = $1 WHERE id = $2
     RETURNING id, receipt_no, supplier_id, purchase_order_id, received_at, note, total_amount, created_at`,
    [Number(totalAmount.toFixed(2)), receiptId]
  );
  return { ...finalized.rows[0], updated_ingredients: updatedIngredients, created_lots: createdLots };
};

module.exports = { createStockReceipt, normalizeReceiptItems };
