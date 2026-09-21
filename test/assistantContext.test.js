const test = require('node:test');
const assert = require('node:assert/strict');
const { allowedAssistantScopes, buildAssistantContext } = require('../utils/assistantContext');

test('assistant data scopes require explicit consent and permitted menus', () => {
  const scopes = ['operations', 'finance', 'personal_orders', 'unknown'];
  assert.deepEqual(allowedAssistantScopes(scopes, { role: 'STAFF', permissions: { pos: { view: true } } }), ['operations', 'personal_orders']);
  assert.deepEqual(allowedAssistantScopes(scopes, { role: 'ADMIN', permissions: {} }), ['operations', 'finance', 'personal_orders']);
  assert.deepEqual(allowedAssistantScopes(scopes, { role: 'USER', permissions: {} }), ['personal_orders']);
});

test('assistant context contains aggregate data only and scopes personal orders to the signed-in user', async () => {
  const calls = [];
  const pool = { query: async (sql, params) => {
    calls.push({ sql, params });
    if (sql.includes('low_stock_count')) return { rows: [{ low_stock_count: 3 }] };
    if (sql.includes('user_id = $1')) return { rows: [{ order_count: 2, net_revenue: '135.5' }] };
    if (sql.includes('discount_amount')) return { rows: [{ order_count: 4, net_revenue: '500', discount_amount: '20' }] };
    return { rows: [{ open_orders: 2, ready_orders: 1 }] };
  } };
  const context = await buildAssistantContext(pool, ['operations', 'finance', 'personal_orders'], 77);
  assert.equal(context.length, 4);
  assert.match(context.join(' '), /ออเดอร์ค้าง 2/);
  assert.match(context.join(' '), /รายได้สุทธิ 500.00/);
  assert.deepEqual(calls.find((call) => call.sql.includes('user_id = \$1')).params, [77]);
});
