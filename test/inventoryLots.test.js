const assert = require('node:assert/strict');
const test = require('node:test');
const { automaticLotNo, consumeLots, roundQuantity } = require('../utils/inventoryLots');

test('inventory quantities are rounded safely and generated lot numbers are traceable', () => {
  assert.equal(roundQuantity(1.23456), 1.235);
  assert.equal(roundQuantity('invalid'), 0);
  assert.match(automaticLotNo('RCV'), /^RCV-[A-Z0-9]+-[A-Z0-9]{4}$/);
});

test('lot consumption uses the earliest available lots and records their cost', async () => {
  const updates = [];
  const client = {
    query: async (sql, values) => {
      if (sql.includes('SELECT id, remaining_quantity')) {
        return { rows: [
          { id: 11, remaining_quantity: 1.25, unit_cost: 2 },
          { id: 12, remaining_quantity: 2, unit_cost: 3 },
        ] };
      }
      updates.push({ sql, values });
      return { rows: [] };
    },
  };
  const result = await consumeLots(client, 7, 1.5);
  assert.deepEqual(result, {
    consumed: [
      { lot_id: 11, quantity: 1.25, unit_cost: 2 },
      { lot_id: 12, quantity: 0.25, unit_cost: 3 },
    ],
    totalCost: 3.25,
  });
  assert.equal(updates.length, 2);
  assert.deepEqual(updates[0].values, [0, 11]);
  assert.deepEqual(updates[1].values, [1.75, 12]);
});

test('lot consumption rejects insufficient non-expired inventory before writing updates', async () => {
  let updateCalled = false;
  const client = {
    query: async (sql) => {
      if (sql.includes('SELECT id, remaining_quantity')) return { rows: [{ id: 1, remaining_quantity: 1, unit_cost: 5 }] };
      updateCalled = true;
      return { rows: [] };
    },
  };
  await assert.rejects(() => consumeLots(client, 7, 2), /ไม่เพียงพอ/);
  assert.equal(updateCalled, false);
});
