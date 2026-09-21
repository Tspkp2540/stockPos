const CONTEXT_SCOPES = Object.freeze({
  operations: 'operations',
  finance: 'finance',
  personal_orders: 'personal_orders',
});

const uniqueScopes = (value) => [...new Set(Array.isArray(value) ? value.map((scope) => String(scope || '').trim()) : [])];
const canView = (permissions, menu) => permissions?.[menu]?.view === true;

function allowedAssistantScopes(scopes, { role, permissions } = {}) {
  const requested = uniqueScopes(scopes);
  const roleName = String(role || '').toUpperCase();
  const isAdmin = roleName === 'ADMIN';
  return requested.filter((scope) => {
    if (scope === CONTEXT_SCOPES.operations) return isAdmin || canView(permissions, 'pos') || canView(permissions, 'orders') || canView(permissions, 'kitchen');
    if (scope === CONTEXT_SCOPES.finance) return isAdmin || canView(permissions, 'finance');
    if (scope === CONTEXT_SCOPES.personal_orders) return true;
    return false;
  });
}

const number = (value) => Number(value || 0);
const money = (value) => number(value).toFixed(2);

async function buildAssistantContext(pool, scopes, userId) {
  const selected = new Set(scopes);
  const chunks = [];
  const jobs = [];
  if (selected.has(CONTEXT_SCOPES.operations)) {
    jobs.push(pool.query(
      `SELECT COUNT(*) FILTER (WHERE status NOT IN ('COMPLETED', 'CANCELLED'))::int AS open_orders,
              COUNT(*) FILTER (WHERE status = 'READY')::int AS ready_orders
       FROM orders
       WHERE (created_at AT TIME ZONE 'Asia/Bangkok')::date = (NOW() AT TIME ZONE 'Asia/Bangkok')::date`,
    ).then((result) => {
      const row = result.rows[0] || {};
      chunks.push(`ข้อมูลสรุปงานวันนี้ที่ได้รับอนุญาต: ออเดอร์ค้าง ${number(row.open_orders)} รายการ, พร้อมรับ ${number(row.ready_orders)} รายการ`);
    }));
    jobs.push(pool.query(
      'SELECT COUNT(*)::int AS low_stock_count FROM ingredients WHERE stock_qty <= min_stock_alert',
    ).then((result) => chunks.push(`ข้อมูลสรุปสต็อกที่ได้รับอนุญาต: วัตถุดิบใกล้หมด ${number(result.rows[0]?.low_stock_count)} รายการ`)));
  }
  if (selected.has(CONTEXT_SCOPES.finance)) {
    jobs.push(pool.query(
      `SELECT COUNT(*)::int AS order_count, COALESCE(SUM(net_revenue), 0) AS net_revenue,
              COALESCE(SUM(discount_amount), 0) AS discount_amount
       FROM orders
       WHERE status <> 'CANCELLED'
         AND (created_at AT TIME ZONE 'Asia/Bangkok')::date = (NOW() AT TIME ZONE 'Asia/Bangkok')::date`,
    ).then((result) => {
      const row = result.rows[0] || {};
      chunks.push(`ข้อมูลสรุปการเงินวันนี้ที่ได้รับอนุญาต: ${number(row.order_count)} ออเดอร์, รายได้สุทธิ ${money(row.net_revenue)} บาท, ส่วนลด ${money(row.discount_amount)} บาท`);
    }));
  }
  if (selected.has(CONTEXT_SCOPES.personal_orders)) {
    jobs.push(pool.query(
      `SELECT COUNT(*)::int AS order_count, COALESCE(SUM(net_revenue), 0) AS net_revenue
       FROM orders
       WHERE user_id = $1 AND status <> 'CANCELLED'`,
      [userId],
    ).then((result) => {
      const row = result.rows[0] || {};
      chunks.push(`ข้อมูลคำสั่งซื้อของบัญชีที่ได้รับอนุญาต: ${number(row.order_count)} ออเดอร์, ยอดสุทธิสะสม ${money(row.net_revenue)} บาท`);
    }));
  }
  await Promise.all(jobs);
  return chunks;
}

module.exports = { CONTEXT_SCOPES, allowedAssistantScopes, buildAssistantContext };
