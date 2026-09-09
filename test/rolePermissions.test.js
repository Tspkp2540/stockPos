const assert = require('node:assert/strict');
const test = require('node:test');
const { ROLE_PERMISSION_DEFAULTS, sanitizePermissions } = require('../utils/rolePermissions');

test('default roles only expose their allowed system menus', () => {
  assert.equal(ROLE_PERMISSION_DEFAULTS.ADMIN.finance.delete, true);
  assert.equal(ROLE_PERMISSION_DEFAULTS.STAFF.pos.create, true);
  assert.equal(ROLE_PERMISSION_DEFAULTS.STAFF.finance, undefined);
  assert.equal(ROLE_PERMISSION_DEFAULTS.USER.orders.view, true);
  assert.equal(ROLE_PERMISSION_DEFAULTS.USER.orders.update, false);
});

test('permission sanitization accepts explicit permissions and rejects unknown or truthy values', () => {
  const permissions = sanitizePermissions({
    pos: { view: true, create: 'true', update: false },
    finance: { view: true },
    unknown_menu: { delete: true },
  });
  assert.deepEqual(permissions.pos, { view: true, create: false, update: false, delete: false });
  assert.deepEqual(permissions.finance, { view: true, create: false, update: false, delete: false });
  assert.equal(Object.hasOwn(permissions, 'unknown_menu'), false);
});
