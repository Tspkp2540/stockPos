const assert = require('node:assert/strict');
const test = require('node:test');
const { normalizeReceiptItems } = require('../utils/stockReceiving');

test('receiving stock accepts valid fractional quantities and optional lot details', () => {
  assert.deepEqual(normalizeReceiptItems([{
    ingredient_id: '9', quantity: '2.5', unit_cost: '14.75', lot_no: ' LOT-1 ', expiry_date: '2026-12-31',
  }]), [{
    ingredient_id: 9, quantity: 2.5, unit_cost: 14.75, lot_no: 'LOT-1', expiry_date: '2026-12-31',
  }]);
});

test('receiving stock rejects missing items, invalid quantities, negative costs, and invalid dates', () => {
  assert.throws(() => normalizeReceiptItems([]), /อย่างน้อย 1/);
  assert.throws(() => normalizeReceiptItems([{ ingredient_id: 1, quantity: 0, unit_cost: 1 }]), /ไม่ถูกต้อง/);
  assert.throws(() => normalizeReceiptItems([{ ingredient_id: 1, quantity: 1, unit_cost: -1 }]), /ไม่ถูกต้อง/);
  assert.throws(() => normalizeReceiptItems([{ ingredient_id: 1, quantity: 1, unit_cost: 1, expiry_date: '2026-99-99' }]), /ไม่ถูกต้อง/);
});
