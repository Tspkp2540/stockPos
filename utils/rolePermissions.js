const permissionActions = Object.freeze(['view', 'create', 'update', 'delete']);
const permissionMenus = Object.freeze([
  'operations', 'pos', 'orders', 'kitchen', 'cash-shifts', 'alerts', 'inventory', 'menu',
  'procurement', 'sales-channels', 'coupons', 'loyalty-settings', 'loyalty-members',
  'role-permissions', 'audit-logs', 'printing', 'finance', 'business-reports',
]);

const allActions = () => ({ view: true, create: true, update: true, delete: true });
const ROLE_PERMISSION_DEFAULTS = Object.freeze({
  ADMIN: Object.fromEntries(permissionMenus.map((menu) => [menu, allActions()])),
  STAFF: {
    pos: { view: true, create: true, update: true, delete: false },
    orders: { view: true, create: false, update: true, delete: false },
    kitchen: { view: true, create: false, update: true, delete: false },
    'cash-shifts': { view: true, create: true, update: true, delete: false },
    menu: { view: true, create: false, update: false, delete: false },
    'sales-channels': { view: true, create: false, update: false, delete: false },
  },
  USER: { orders: { view: true, create: false, update: false, delete: false } },
});

const sanitizePermissions = (value) => Object.fromEntries(permissionMenus.map((menu) => [
  menu,
  Object.fromEntries(permissionActions.map((action) => [action, value?.[menu]?.[action] === true])),
]));

module.exports = { permissionActions, permissionMenus, ROLE_PERMISSION_DEFAULTS, sanitizePermissions };
