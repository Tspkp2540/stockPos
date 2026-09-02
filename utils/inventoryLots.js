const roundQuantity = (value) => Number(Number(value || 0).toFixed(3));
const roundCost = (value) => Number(Number(value || 0).toFixed(4));

const automaticLotNo = (prefix = 'LOT') =>
  `${prefix}-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

const addInventoryLot = async (client, {
  ingredientId,
  quantity,
  unitCost = 0,
  lotNo = '',
  receivedAt = new Date(),
  expiryDate = null,
  receiptItemId = null,
}) => {
  const amount = roundQuantity(quantity);
  if (amount <= 0) return null;
  const result = await client.query(
    `INSERT INTO inventory_lots
     (ingredient_id, stock_receipt_item_id, lot_no, received_at, expiry_date, initial_quantity, remaining_quantity, unit_cost)
     VALUES ($1, $2, $3, $4, $5, $6, $6, $7)
     RETURNING *`,
    [
      ingredientId,
      receiptItemId,
      String(lotNo || automaticLotNo()).trim().slice(0, 100),
      receivedAt instanceof Date ? receivedAt.toISOString() : receivedAt,
      expiryDate || null,
      amount,
      roundCost(unitCost),
    ]
  );
  return result.rows[0];
};

const consumeLots = async (client, ingredientId, quantity, { orderItemId = null, includeExpired = false } = {}) => {
  let remaining = roundQuantity(quantity);
  if (remaining <= 0) return { consumed: [], totalCost: 0 };
  const result = await client.query(
    `SELECT id, remaining_quantity, unit_cost, expiry_date
     FROM inventory_lots
     WHERE ingredient_id = $1
       AND remaining_quantity > 0
       AND ($2::boolean = TRUE OR expiry_date IS NULL OR expiry_date >= CURRENT_DATE)
     ORDER BY expiry_date ASC NULLS LAST, received_at ASC, id ASC
     FOR UPDATE`,
    [ingredientId, includeExpired]
  );
  const available = result.rows.reduce((sum, lot) => sum + Number(lot.remaining_quantity || 0), 0);
  if (available + 0.000001 < remaining) {
    throw new Error('วัตถุดิบที่ยังไม่หมดอายุมีไม่เพียงพอ');
  }
  const consumed = [];
  let totalCost = 0;
  for (const lot of result.rows) {
    if (remaining <= 0) break;
    const used = Math.min(remaining, Number(lot.remaining_quantity));
    const nextRemaining = roundQuantity(Number(lot.remaining_quantity) - used);
    await client.query(
      'UPDATE inventory_lots SET remaining_quantity = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      [nextRemaining, lot.id]
    );
    if (orderItemId !== null) {
      await client.query(
        `INSERT INTO order_item_lot_allocations (order_item_id, inventory_lot_id, quantity, unit_cost)
         VALUES ($1, $2, $3, $4)`,
        [orderItemId, lot.id, roundQuantity(used), roundCost(lot.unit_cost)]
      );
    }
    consumed.push({ lot_id: lot.id, quantity: roundQuantity(used), unit_cost: roundCost(lot.unit_cost) });
    totalCost += used * Number(lot.unit_cost || 0);
    remaining = roundQuantity(remaining - used);
  }
  return { consumed, totalCost: roundCost(totalCost) };
};

const restoreOrderLots = async (client, orderId) => {
  const allocations = await client.query(
    `SELECT oil.id, oil.inventory_lot_id, oil.quantity
     FROM order_item_lot_allocations oil
     JOIN order_items oi ON oi.id = oil.order_item_id
     JOIN inventory_lots il ON il.id = oil.inventory_lot_id
     WHERE oi.order_id = $1
     ORDER BY oil.id
     FOR UPDATE OF il`,
    [orderId]
  );
  for (const allocation of allocations.rows) {
    await client.query(
      `UPDATE inventory_lots
       SET remaining_quantity = remaining_quantity + $1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2`,
      [allocation.quantity, allocation.inventory_lot_id]
    );
  }
  if (allocations.rows.length) {
    await client.query(
      `DELETE FROM order_item_lot_allocations
       WHERE order_item_id IN (SELECT id FROM order_items WHERE order_id = $1)`,
      [orderId]
    );
  }
  return allocations.rows.length;
};

const applyLotAdjustment = async (client, { ingredientId, difference, unitCost = 0, note = 'ปรับยอดสต็อก' }) => {
  const amount = roundQuantity(difference);
  if (amount > 0) {
    return [await addInventoryLot(client, {
      ingredientId,
      quantity: amount,
      unitCost,
      lotNo: automaticLotNo('ADJ'),
    })];
  }
  if (amount < 0) {
    const used = await consumeLots(client, ingredientId, Math.abs(amount), { includeExpired: true });
    return used.consumed;
  }
  return [];
};

module.exports = {
  addInventoryLot,
  applyLotAdjustment,
  automaticLotNo,
  consumeLots,
  restoreOrderLots,
  roundQuantity,
};
