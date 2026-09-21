require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');
const pool = require('../config/db');
const { hashPassword, verifyPassword, needsPasswordUpgrade, createToken, verifyToken, requireAuth, requireRoles } = require('../middleware/auth');
const { createApiEnvelopeMiddleware } = require('../middleware/apiEnvelope');

const app = express();
const server = http.createServer(app);
const serverStartedAt = Date.now();
const ordersRouter = require('../router/orders');
const inventoryRouter = require('../router/inventory');
const productsRouter = require('../router/products');
const purchaseOrdersRouter = require('../router/purchaseOrders');
const { addInventoryLot, consumeLots, restoreOrderLots } = require('../utils/inventoryLots');
const {
  loyaltyDiscountForPoints,
  loyaltyPointsForOrder,
  loyaltyRules,
  normalizeCouponCode,
  normalizePaymentMethod,
  requestError,
  validateCouponForAmount,
  validateLoyaltySettings,
} = require('../utils/commerceRules');
const { permissionActions, permissionMenus, ROLE_PERMISSION_DEFAULTS, sanitizePermissions } = require('../utils/rolePermissions');
const { settlePayments } = require('../utils/paymentSettlement');
const { askSystemAssistant } = require('../utils/assistantAi');
const { allowedAssistantScopes, buildAssistantContext } = require('../utils/assistantContext');

const promotionDiscountForAmount = (promotion, amount) => {
  const base = Math.max(0, Number(amount) || 0);
  if (!promotion || !promotion.is_active || base < Number(promotion.min_order_amount || 0)) return 0;
  const raw = promotion.discount_type === 'PERCENT'
    ? base * Math.min(100, Number(promotion.discount_value || 0)) / 100
    : Number(promotion.discount_value || 0);
  const capped = Number(promotion.max_discount_amount || 0) > 0
    ? Math.min(raw, Number(promotion.max_discount_amount))
    : raw;
  return Math.min(base, Math.max(0, capped));
};

const promotionMatchesCheckout = (promotion, { channelId, customerPhone, now = new Date() }) => {
  if (!promotion?.is_active) return false;
  if (promotion.channel_id && Number(promotion.channel_id) !== Number(channelId)) return false;
  if (promotion.requires_member && !customerPhone) return false;
  if (promotion.valid_from && new Date(promotion.valid_from) > now) return false;
  if (promotion.valid_until && new Date(promotion.valid_until) < now) return false;
  if (promotion.start_time && promotion.end_time) {
    const localTime = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now);
    const start = String(promotion.start_time).slice(0, 5);
    const end = String(promotion.end_time).slice(0, 5);
    if (!(start <= end ? localTime >= start && localTime <= end : localTime >= start || localTime <= end)) return false;
  }
  return true;
};

const localFrontendOrigins = new Set([
  'http://localhost:3000',
  'http://localhost:3001',
  'http://localhost:5173',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:3001',
  'http://127.0.0.1:5173',
]);
const productionFrontendOrigins = new Set([
  'https://stockpos-frontend-production.up.railway.app',
]);
const configuredFrontendOrigins = [process.env.FRONTEND_ORIGINS, process.env.FRONTEND_ORIGIN]
  .filter(Boolean)
  .flatMap((value) => String(value).split(','))
  .map((value) => value.trim())
  .filter(Boolean)
  .map((value) => {
    try {
      return new URL(value).origin;
    } catch (error) {
      console.warn(`Ignoring invalid FRONTEND_ORIGINS value: ${value}`);
      return null;
    }
  })
  .filter(Boolean);
const allowedFrontendOrigins = new Set([
  ...localFrontendOrigins,
  ...productionFrontendOrigins,
  ...configuredFrontendOrigins,
]);
const isAllowedOrigin = (origin) => !origin || allowedFrontendOrigins.has(origin);
const corsOrigin = (origin, callback) => callback(null, isAllowedOrigin(origin));
const apiEnvelopeEncryptionEnabled = process.env.API_PAYLOAD_ENCRYPTION_ENABLED === 'true';

const clientAddress = (req) => {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || req.socket?.remoteAddress || req.ip || 'unknown';
};
const createRateLimiter = ({ name, windowMs, max, key = clientAddress }) => {
  const buckets = new Map();
  const maxTrackedKeys = 10000;
  return (req, res, next) => {
    const now = Date.now();
    const bucketKey = `${name}:${key(req)}`;
    let bucket = buckets.get(bucketKey);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(bucketKey, bucket);
    }
    bucket.count += 1;

    if (buckets.size > maxTrackedKeys) {
      for (const [storedKey, storedBucket] of buckets) {
        if (storedBucket.resetAt <= now || buckets.size > maxTrackedKeys) buckets.delete(storedKey);
      }
    }

    const remaining = Math.max(0, max - bucket.count);
    res.set('RateLimit-Limit', String(max));
    res.set('RateLimit-Remaining', String(remaining));
    res.set('RateLimit-Reset', String(Math.ceil(bucket.resetAt / 1000)));
    if (bucket.count <= max) return next();

    const retryAfterSeconds = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
    res.set('Retry-After', String(retryAfterSeconds));
    return res.status(429).json({
      success: false,
      error: `Too many ${name} requests. Please try again in ${retryAfterSeconds} seconds.`,
      code: 'RATE_LIMITED',
    });
  };
};
const apiRateLimiter = createRateLimiter({ name: 'API', windowMs: 60 * 1000, max: 360 });
const loginRateLimiter = createRateLimiter({ name: 'login', windowMs: 15 * 60 * 1000, max: 12 });
const registrationRateLimiter = createRateLimiter({ name: 'registration', windowMs: 60 * 60 * 1000, max: 5 });
const sessionUnlockRateLimiter = createRateLimiter({
  name: 'session unlock',
  windowMs: 15 * 60 * 1000,
  max: 10,
  key: (req) => req.user?.sub ? `user:${req.user.sub}` : clientAddress(req),
});
const publicLookupRateLimiter = createRateLimiter({ name: 'public lookup', windowMs: 60 * 1000, max: 30 });
const protectedLookupRateLimiter = createRateLimiter({
  name: 'lookup',
  windowMs: 60 * 1000,
  max: 90,
  key: (req) => req.user?.sub ? `user:${req.user.sub}` : clientAddress(req),
});
const assistantRateLimiter = createRateLimiter({
  name: 'assistant',
  windowMs: 10 * 60 * 1000,
  max: 30,
  key: (req) => req.user?.sub ? `user:${req.user.sub}` : clientAddress(req),
});
const assistantEnabled = process.env.AI_ASSISTANT_ENABLED === 'true';
const assistantProvider = String(process.env.AI_ASSISTANT_PROVIDER || 'openai').trim().toLowerCase();
const assistantConfigured = () => assistantEnabled && (
  assistantProvider === 'ollama'
    ? Boolean(process.env.OLLAMA_BASE_URL)
    : assistantProvider === 'openai' && Boolean(process.env.OPENAI_API_KEY)
);

const isValidRecordDate = (value) => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};

const selectedRecordDate = (value) => isValidRecordDate(value) ? value : null;
const bangkokToday = () => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const value = (type) => parts.find((part) => part.type === type)?.value;
  return `${value('year')}-${value('month')}-${value('day')}`;
};
const shiftRecordDate = (value, days) => {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};
const assertBusinessDateOpen = async (client, recordDate = null) => {
  const result = await client.query(
    `SELECT id FROM daily_closings
     WHERE business_date = COALESCE($1::date, (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Bangkok')::date)
     LIMIT 1`,
    [recordDate]
  );
  if (result.rows.length) {
    throw requestError('วันทำการนี้ถูกปิดยอดแล้ว ไม่สามารถแก้ไขได้', 409);
  }
};
const normalizePhone = (value) => String(value || '').replace(/\D/g, '');
const isValidPhone = (value) => /^\d{9,15}$/.test(value);
const publicUser = (user) => ({ id: Number(user.id), username: user.username, name: user.full_name, phone: user.phone || '', role: String(user.role).toLowerCase(), role_key: String(user.role_key || user.role).toLowerCase() });
const rolePermissionsFor = async (role) => {
  const result = await pool.query('SELECT permissions FROM role_permissions WHERE role = $1', [String(role || '').toUpperCase()]);
  const defaults = ROLE_PERMISSION_DEFAULTS[String(role || '').toUpperCase()] || {};
  const stored = result.rows[0]?.permissions || {};
  return Object.fromEntries(permissionMenus.map((menu) => [menu, Object.fromEntries(permissionActions.map((action) => [
    action,
    typeof stored?.[menu]?.[action] === 'boolean' ? stored[menu][action] : defaults?.[menu]?.[action] === true,
  ]))]));
};
const requirePermission = (menu, action) => async (req, res, next) => {
  if (req.user?.roleKey === 'ADMIN' || (!req.user?.roleKey && req.user?.role === 'ADMIN')) return next();
  try {
    const permissions = await rolePermissionsFor(req.user?.roleKey || req.user?.role);
    if (permissions?.[menu]?.[action]) return next();
    return res.status(403).json({ success: false, error: 'This role is not allowed to perform this action' });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
};
const requireResourcePermission = (resource) => (req, res, next) => {
  const action = req.method === 'GET' ? 'view' : req.method === 'POST' ? 'create' : req.method === 'DELETE' ? 'delete' : 'update';
  return requirePermission(resource, action)(req, res, next);
};
const getLoyaltyRules = async (client = pool, { forUpdate = false } = {}) => {
  const result = await client.query(
    `SELECT is_enabled, earn_enabled, redeem_enabled, earn_mode, spend_per_point, cups_per_point, baht_per_point, max_redeem_percent, updated_at
     FROM loyalty_settings WHERE id = 1${forUpdate ? ' FOR UPDATE' : ''}`,
  );
  return loyaltyRules(result.rows[0]);
};
const loyaltyAccountPayload = (account) => account ? ({
  id: Number(account.id),
  customer_phone: account.customer_phone,
  customer_name: account.customer_name || '',
  points_balance: Number(account.points_balance || 0),
  lifetime_points: Number(account.lifetime_points || 0),
  lifetime_spend: Number(account.lifetime_spend || 0),
  order_count: Number(account.order_count || 0),
  last_order_at: account.last_order_at || null,
  updated_at: account.updated_at,
}) : null;
const auditSensitiveFields = new Set(['password', 'password_hash', 'token', 'authorization', 'access_token', 'refresh_token']);
const auditPayload = (value, depth = 0) => {
  if (depth > 3) return '[truncated]';
  if (value === null || value === undefined || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return value.length > 300 ? `${value.slice(0, 300)}…` : value;
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => auditPayload(item, depth + 1));
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).slice(0, 30).map(([key, item]) => [
      key,
      auditSensitiveFields.has(String(key).toLowerCase()) ? '[redacted]' : auditPayload(item, depth + 1),
    ]));
  }
  return String(value);
};
const shouldAuditRequest = (req) => {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) || !req.user) return false;
  const ignoredPaths = new Set(['/api/auth/login', '/api/auth/register', '/api/auth/verify-password', '/api/coupons/validate', '/api/loyalty/lookup']);
  return req.path.startsWith('/api/') && !ignoredPaths.has(req.path);
};
const recordAuditLog = (req, statusCode) => {
  if (!shouldAuditRequest(req)) return;
  const pathParts = req.path.replace(/^\/api\//, '').split('/').filter(Boolean);
  const resourceId = pathParts.find((part) => /^\d+$/.test(part)) || null;
  pool.query(
    `INSERT INTO audit_logs
     (actor_user_id, actor_username, actor_role, action, resource, resource_id, request_summary, status_code, ip_address)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)`,
    [
      req.user.sub,
      req.user.username || '',
      req.user.role || '',
      req.method,
      pathParts.slice(0, 2).join('/') || req.path,
      resourceId,
      JSON.stringify(auditPayload(req.auditSummary ?? req.body ?? {})),
      statusCode,
      String(req.ip || '').slice(0, 100),
    ],
  ).catch((error) => console.warn('Audit log write failed.', error.message));
};
const resolveItemModifiers = async (client, productId, rawModifiers = []) => {
  const optionIds = [...new Set(
    (Array.isArray(rawModifiers) ? rawModifiers : [])
      .map((modifier) => Number(modifier?.option_id ?? modifier))
      .filter((id) => Number.isInteger(id) && id > 0)
  )];
  const suppliedCount = Array.isArray(rawModifiers) ? rawModifiers.length : 0;
  if (optionIds.length !== suppliedCount) throw requestError('Invalid modifier selection');

  const groupsResult = await client.query(
    `SELECT id, name, min_selection, max_selection
     FROM product_modifier_groups
     WHERE product_id = $1
     ORDER BY display_order, id`,
    [productId]
  );
  if (!groupsResult.rows.length) {
    if (optionIds.length) throw requestError('This menu does not support the selected modifier');
    return [];
  }

  const optionsResult = optionIds.length
    ? await client.query(
      `SELECT mo.id, mo.name, mo.price_adjustment, mg.id AS group_id, mg.name AS group_name
       FROM product_modifier_options mo
       JOIN product_modifier_groups mg ON mg.id = mo.modifier_group_id
       WHERE mg.product_id = $1 AND mo.id = ANY($2::bigint[]) AND mo.is_active = TRUE`,
      [productId, optionIds]
    )
    : { rows: [] };
  if (optionsResult.rows.length !== optionIds.length) throw requestError('One or more modifiers are unavailable');

  const selectionsPerGroup = new Map();
  for (const option of optionsResult.rows) {
    selectionsPerGroup.set(option.group_id, (selectionsPerGroup.get(option.group_id) || 0) + 1);
  }
  for (const group of groupsResult.rows) {
    const selected = selectionsPerGroup.get(group.id) || 0;
    if (selected < Number(group.min_selection) || selected > Number(group.max_selection)) {
      throw requestError(`Please select ${group.name}`);
    }
  }
  return optionsResult.rows;
};

const startServer = async () => {
  try {
    const client = await pool.connect();
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id BIGSERIAL PRIMARY KEY,
        username VARCHAR(64) NOT NULL UNIQUE,
        full_name VARCHAR(120) NOT NULL,
        password_hash TEXT NOT NULL,
        role VARCHAR(16) NOT NULL CHECK (role IN ('ADMIN', 'STAFF', 'USER')),
        phone VARCHAR(20),
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await client.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS role_key VARCHAR(32)');
    await client.query('UPDATE users SET role_key = role WHERE role_key IS NULL OR role_key = \'\'');
    await client.query("ALTER TABLE users ALTER COLUMN role_key SET DEFAULT 'USER'");
    await client.query('ALTER TABLE users ALTER COLUMN role_key SET NOT NULL');
    await client.query(`
      CREATE TABLE IF NOT EXISTS channels (
        id BIGSERIAL PRIMARY KEY,
        name VARCHAR(120) NOT NULL UNIQUE,
        gp_percent NUMERIC(5, 2) NOT NULL DEFAULT 0 CHECK (gp_percent >= 0 AND gp_percent <= 100),
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS role_permissions (
        role VARCHAR(32) PRIMARY KEY,
        base_role VARCHAR(16) NOT NULL DEFAULT 'USER' CHECK (base_role IN ('ADMIN', 'STAFF', 'USER')),
        display_name VARCHAR(80) NOT NULL DEFAULT '',
        permissions JSONB NOT NULL DEFAULT '{}'::jsonb,
        updated_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await client.query('ALTER TABLE role_permissions DROP CONSTRAINT IF EXISTS role_permissions_role_check');
    await client.query('ALTER TABLE role_permissions ALTER COLUMN role TYPE VARCHAR(32)');
    await client.query("ALTER TABLE role_permissions ADD COLUMN IF NOT EXISTS base_role VARCHAR(16) NOT NULL DEFAULT 'USER'");
    await client.query("ALTER TABLE role_permissions ADD COLUMN IF NOT EXISTS display_name VARCHAR(80) NOT NULL DEFAULT ''");
    await client.query('UPDATE role_permissions SET base_role = role WHERE role IN (\'ADMIN\', \'STAFF\', \'USER\') AND base_role = \'USER\'');
    await client.query('UPDATE role_permissions SET display_name = role WHERE display_name = \'\'');
    for (const [role, permissions] of Object.entries(ROLE_PERMISSION_DEFAULTS)) {
      await client.query(
        `INSERT INTO role_permissions (role, base_role, display_name, permissions)
         VALUES ($1, $1, $1, $2::jsonb)
         ON CONFLICT (role) DO NOTHING`,
        [role, JSON.stringify(permissions)],
      );
    }
    await client.query('ALTER TABLE channels ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE');
    await client.query('ALTER TABLE channels ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP');
    await client.query('ALTER TABLE channels ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP');
    for (const [name, feePercent] of [['Front Store', 0], ['GrabFood', 30], ['LINE MAN', 30]]) {
      await client.query(
        `INSERT INTO channels (name, gp_percent)
         SELECT $1::varchar, $2
         WHERE NOT EXISTS (SELECT 1 FROM channels WHERE LOWER(name) = LOWER($1::text))`,
        [name, feePercent]
      );
    }
    await client.query('ALTER TABLE IF EXISTS orders ADD COLUMN IF NOT EXISTS user_id BIGINT REFERENCES users(id)');
    await client.query('ALTER TABLE IF EXISTS orders ADD COLUMN IF NOT EXISTS client_request_id VARCHAR(120)');
    await client.query('CREATE UNIQUE INDEX IF NOT EXISTS orders_user_client_request_unique_idx ON orders(user_id, client_request_id) WHERE client_request_id IS NOT NULL');
    await client.query('ALTER TABLE IF EXISTS orders ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ');
    await client.query('ALTER TABLE IF EXISTS orders ALTER COLUMN created_at SET DEFAULT CURRENT_TIMESTAMP');
    await client.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS phone VARCHAR(20)');
    await client.query('CREATE UNIQUE INDEX IF NOT EXISTS users_phone_unique ON users(phone) WHERE phone IS NOT NULL');
    await client.query('ALTER TABLE IF EXISTS orders ADD COLUMN IF NOT EXISTS customer_name VARCHAR(120)');
    await client.query('ALTER TABLE IF EXISTS orders ADD COLUMN IF NOT EXISTS customer_nickname VARCHAR(80)');
    await client.query('ALTER TABLE IF EXISTS orders ADD COLUMN IF NOT EXISTS customer_phone VARCHAR(20)');
    await client.query('ALTER TABLE IF EXISTS orders ADD COLUMN IF NOT EXISTS queue_no INTEGER');
    await client.query(`
      CREATE TABLE IF NOT EXISTS loyalty_settings (
        id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
        is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
        earn_enabled BOOLEAN NOT NULL DEFAULT TRUE,
        redeem_enabled BOOLEAN NOT NULL DEFAULT TRUE,
        earn_mode VARCHAR(12) NOT NULL DEFAULT 'SPEND' CHECK (earn_mode IN ('SPEND', 'CUP')),
        spend_per_point NUMERIC(12, 2) NOT NULL DEFAULT 25 CHECK (spend_per_point > 0),
        cups_per_point NUMERIC(12, 2) NOT NULL DEFAULT 1 CHECK (cups_per_point > 0),
        baht_per_point NUMERIC(12, 2) NOT NULL DEFAULT 0.10 CHECK (baht_per_point > 0),
        max_redeem_percent NUMERIC(5, 2) NOT NULL DEFAULT 50 CHECK (max_redeem_percent >= 0 AND max_redeem_percent <= 100),
        updated_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await client.query("ALTER TABLE loyalty_settings ADD COLUMN IF NOT EXISTS earn_mode VARCHAR(12) NOT NULL DEFAULT 'SPEND'");
    await client.query('ALTER TABLE loyalty_settings ADD COLUMN IF NOT EXISTS cups_per_point NUMERIC(12, 2) NOT NULL DEFAULT 1');
    await client.query('ALTER TABLE loyalty_settings ADD COLUMN IF NOT EXISTS earn_enabled BOOLEAN NOT NULL DEFAULT TRUE');
    await client.query('ALTER TABLE loyalty_settings ADD COLUMN IF NOT EXISTS redeem_enabled BOOLEAN NOT NULL DEFAULT TRUE');
    await client.query(`
      INSERT INTO loyalty_settings (id)
      VALUES (1)
      ON CONFLICT (id) DO NOTHING
    `);
    await client.query(`UPDATE loyalty_settings
      SET earn_enabled = FALSE, redeem_enabled = FALSE
      WHERE is_enabled = FALSE AND earn_enabled = TRUE AND redeem_enabled = TRUE`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS loyalty_accounts (
        id BIGSERIAL PRIMARY KEY,
        customer_phone VARCHAR(20) NOT NULL UNIQUE,
        customer_name VARCHAR(120) NOT NULL DEFAULT '',
        points_balance INTEGER NOT NULL DEFAULT 0,
        lifetime_points INTEGER NOT NULL DEFAULT 0,
        lifetime_spend NUMERIC(12, 2) NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS loyalty_transactions (
        id BIGSERIAL PRIMARY KEY,
        loyalty_account_id BIGINT NOT NULL REFERENCES loyalty_accounts(id) ON DELETE CASCADE,
        order_id BIGINT REFERENCES orders(id) ON DELETE SET NULL,
        transaction_type VARCHAR(32) NOT NULL CHECK (transaction_type IN ('EARN', 'REDEEM', 'CANCEL_EARN_REVERSAL', 'CANCEL_REDEEM_REVERSAL')),
        points_delta INTEGER NOT NULL,
        amount NUMERIC(12, 2) NOT NULL DEFAULT 0,
        note TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await client.query('ALTER TABLE IF EXISTS orders ADD COLUMN IF NOT EXISTS loyalty_account_id BIGINT REFERENCES loyalty_accounts(id) ON DELETE SET NULL');
    await client.query('ALTER TABLE IF EXISTS orders ADD COLUMN IF NOT EXISTS loyalty_points_earned INTEGER NOT NULL DEFAULT 0');
    await client.query('ALTER TABLE IF EXISTS orders ADD COLUMN IF NOT EXISTS loyalty_points_redeemed INTEGER NOT NULL DEFAULT 0');
    await client.query('ALTER TABLE IF EXISTS orders ADD COLUMN IF NOT EXISTS loyalty_discount_amount NUMERIC(12, 2) NOT NULL DEFAULT 0');
    await client.query('CREATE INDEX IF NOT EXISTS loyalty_transactions_account_created_idx ON loyalty_transactions(loyalty_account_id, created_at DESC)');
    await client.query('CREATE INDEX IF NOT EXISTS orders_loyalty_account_idx ON orders(loyalty_account_id)');
    await client.query('ALTER TABLE IF EXISTS products ADD COLUMN IF NOT EXISTS is_sold_out BOOLEAN NOT NULL DEFAULT FALSE');
    await client.query('ALTER TABLE IF EXISTS products ADD COLUMN IF NOT EXISTS barcode VARCHAR(80)');
    await client.query('ALTER TABLE IF EXISTS products ADD COLUMN IF NOT EXISTS counts_as_loyalty_cup BOOLEAN NOT NULL DEFAULT FALSE');
    await client.query("ALTER TABLE IF EXISTS products ADD COLUMN IF NOT EXISTS production_station VARCHAR(16) NOT NULL DEFAULT 'BAR'");
    await client.query('ALTER TABLE IF EXISTS products ADD COLUMN IF NOT EXISTS prep_minutes INTEGER NOT NULL DEFAULT 5');
    await client.query(`DO $$ BEGIN
      ALTER TABLE products ADD CONSTRAINT products_production_station_check CHECK (production_station IN ('BAR', 'KITCHEN', 'BAKERY', 'OTHER'));
    EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
    await client.query(`DO $$ BEGIN
      ALTER TABLE products ADD CONSTRAINT products_prep_minutes_check CHECK (prep_minutes >= 1 AND prep_minutes <= 180);
    EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
    await client.query("ALTER TABLE IF EXISTS order_items ADD COLUMN IF NOT EXISTS production_station VARCHAR(16) NOT NULL DEFAULT 'BAR'");
    await client.query('ALTER TABLE IF EXISTS order_items ADD COLUMN IF NOT EXISTS target_prep_minutes INTEGER NOT NULL DEFAULT 5');
    await client.query("ALTER TABLE IF EXISTS order_items ADD COLUMN IF NOT EXISTS production_status VARCHAR(16) NOT NULL DEFAULT 'PENDING'");
    await client.query('ALTER TABLE IF EXISTS order_items ADD COLUMN IF NOT EXISTS production_accepted_at TIMESTAMPTZ');
    await client.query('ALTER TABLE IF EXISTS order_items ADD COLUMN IF NOT EXISTS production_started_at TIMESTAMPTZ');
    await client.query('ALTER TABLE IF EXISTS order_items ADD COLUMN IF NOT EXISTS production_completed_at TIMESTAMPTZ');
    await client.query('ALTER TABLE IF EXISTS order_items DROP CONSTRAINT IF EXISTS order_items_production_status_check');
    await client.query("ALTER TABLE IF EXISTS order_items ADD CONSTRAINT order_items_production_status_check CHECK (production_status IN ('PENDING', 'ACCEPTED', 'IN_PROGRESS', 'READY'))");
    await client.query('CREATE UNIQUE INDEX IF NOT EXISTS products_barcode_unique_idx ON products(barcode) WHERE barcode IS NOT NULL');
    await client.query(`
      CREATE TABLE IF NOT EXISTS product_channel_settings (
        product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        channel_id BIGINT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        price_retail NUMERIC(12, 2),
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (product_id, channel_id),
        CHECK (price_retail IS NULL OR price_retail >= 0)
      )
    `);
    await client.query('CREATE INDEX IF NOT EXISTS product_channel_settings_channel_idx ON product_channel_settings(channel_id, is_active)');
    await client.query(`
      CREATE TABLE IF NOT EXISTS coupons (
        id BIGSERIAL PRIMARY KEY,
        code VARCHAR(64) NOT NULL UNIQUE,
        discount_type VARCHAR(12) NOT NULL CHECK (discount_type IN ('AMOUNT', 'PERCENT')),
        discount_value NUMERIC(12, 2) NOT NULL CHECK (discount_value > 0),
        min_order_amount NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (min_order_amount >= 0),
        max_discount_amount NUMERIC(12, 2),
        valid_from TIMESTAMPTZ,
        valid_until TIMESTAMPTZ,
        usage_limit INTEGER CHECK (usage_limit IS NULL OR usage_limit > 0),
        used_count INTEGER NOT NULL DEFAULT 0 CHECK (used_count >= 0),
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await client.query('ALTER TABLE IF EXISTS orders ADD COLUMN IF NOT EXISTS subtotal_amount NUMERIC(12, 2) NOT NULL DEFAULT 0');
    await client.query('ALTER TABLE IF EXISTS orders ADD COLUMN IF NOT EXISTS discount_amount NUMERIC(12, 2) NOT NULL DEFAULT 0');
    await client.query('ALTER TABLE IF EXISTS orders ADD COLUMN IF NOT EXISTS manual_discount_amount NUMERIC(12, 2) NOT NULL DEFAULT 0');
    await client.query('ALTER TABLE IF EXISTS orders ADD COLUMN IF NOT EXISTS coupon_discount_amount NUMERIC(12, 2) NOT NULL DEFAULT 0');
    await client.query('ALTER TABLE IF EXISTS orders ADD COLUMN IF NOT EXISTS coupon_code VARCHAR(64)');
    await client.query('ALTER TABLE IF EXISTS orders ADD COLUMN IF NOT EXISTS coupon_id BIGINT REFERENCES coupons(id)');
    await client.query('CREATE INDEX IF NOT EXISTS coupons_active_code_idx ON coupons(UPPER(code)) WHERE is_active = TRUE');
    await client.query(`
      CREATE TABLE IF NOT EXISTS promotions (
        id BIGSERIAL PRIMARY KEY,
        name VARCHAR(140) NOT NULL,
        discount_type VARCHAR(12) NOT NULL CHECK (discount_type IN ('AMOUNT', 'PERCENT')),
        discount_value NUMERIC(12, 2) NOT NULL CHECK (discount_value > 0),
        min_order_amount NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (min_order_amount >= 0),
        max_discount_amount NUMERIC(12, 2),
        channel_id BIGINT REFERENCES channels(id) ON DELETE SET NULL,
        requires_member BOOLEAN NOT NULL DEFAULT FALSE,
        start_time TIME,
        end_time TIME,
        valid_from TIMESTAMPTZ,
        valid_until TIMESTAMPTZ,
        priority INTEGER NOT NULL DEFAULT 0,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await client.query('ALTER TABLE IF EXISTS orders ADD COLUMN IF NOT EXISTS promotion_id BIGINT REFERENCES promotions(id)');
    await client.query('ALTER TABLE IF EXISTS orders ADD COLUMN IF NOT EXISTS promotion_discount_amount NUMERIC(12, 2) NOT NULL DEFAULT 0');
    await client.query('CREATE INDEX IF NOT EXISTS promotions_active_priority_idx ON promotions(priority DESC, id DESC) WHERE is_active = TRUE');
    await client.query(`
      CREATE TABLE IF NOT EXISTS product_modifier_groups (
        id BIGSERIAL PRIMARY KEY,
        product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        name VARCHAR(100) NOT NULL,
        min_selection INTEGER NOT NULL DEFAULT 0 CHECK (min_selection >= 0),
        max_selection INTEGER NOT NULL DEFAULT 1 CHECK (max_selection > 0),
        display_order INTEGER NOT NULL DEFAULT 0,
        CHECK (min_selection <= max_selection)
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS product_modifier_options (
        id BIGSERIAL PRIMARY KEY,
        modifier_group_id BIGINT NOT NULL REFERENCES product_modifier_groups(id) ON DELETE CASCADE,
        name VARCHAR(100) NOT NULL,
        price_adjustment NUMERIC(12, 2) NOT NULL DEFAULT 0,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        display_order INTEGER NOT NULL DEFAULT 0
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS order_item_modifiers (
        id BIGSERIAL PRIMARY KEY,
        order_item_id BIGINT NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
        modifier_option_id BIGINT REFERENCES product_modifier_options(id) ON DELETE SET NULL,
        group_name VARCHAR(100) NOT NULL,
        option_name VARCHAR(100) NOT NULL,
        price_adjustment NUMERIC(12, 2) NOT NULL DEFAULT 0
      )
    `);
    await client.query('CREATE INDEX IF NOT EXISTS product_modifier_groups_product_idx ON product_modifier_groups(product_id, display_order)');
    await client.query('CREATE INDEX IF NOT EXISTS order_item_modifiers_item_idx ON order_item_modifiers(order_item_id)');
    await client.query(`
      CREATE TABLE IF NOT EXISTS cash_shifts (
        id BIGSERIAL PRIMARY KEY,
        opened_by BIGINT NOT NULL REFERENCES users(id),
        opened_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        opening_cash NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (opening_cash >= 0),
        opening_note TEXT NOT NULL DEFAULT '',
        status VARCHAR(12) NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CLOSED')),
        closed_by BIGINT REFERENCES users(id),
        closed_at TIMESTAMPTZ,
        closing_cash NUMERIC(12, 2),
        expected_cash NUMERIC(12, 2),
        difference_amount NUMERIC(12, 2),
        closing_note TEXT NOT NULL DEFAULT ''
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS order_payments (
        id BIGSERIAL PRIMARY KEY,
        order_id BIGINT NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
        cash_shift_id BIGINT REFERENCES cash_shifts(id) ON DELETE SET NULL,
        paid_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
        payment_method VARCHAR(16) NOT NULL CHECK (payment_method IN ('CASH', 'QR', 'TRANSFER', 'CARD', 'OTHER')),
        paid_amount NUMERIC(12, 2) NOT NULL CHECK (paid_amount >= 0),
        amount_received NUMERIC(12, 2) NOT NULL CHECK (amount_received >= 0),
        change_amount NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (change_amount >= 0),
        change_method VARCHAR(16) CHECK (change_method IS NULL OR change_method IN ('CASH')),
        status VARCHAR(12) NOT NULL DEFAULT 'PAID' CHECK (status IN ('PAID', 'VOIDED')),
        paid_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS cash_shifts_one_open_per_user_idx
      ON cash_shifts(opened_by) WHERE status = 'OPEN'
    `);
    await client.query('CREATE INDEX IF NOT EXISTS order_payments_cash_shift_idx ON order_payments(cash_shift_id, status)');
    await client.query('ALTER TABLE order_payments DROP CONSTRAINT IF EXISTS order_payments_order_id_key');
    await client.query("ALTER TABLE order_payments ADD COLUMN IF NOT EXISTS change_method VARCHAR(16) CHECK (change_method IS NULL OR change_method IN ('CASH'))");
    await client.query('CREATE INDEX IF NOT EXISTS order_payments_order_status_idx ON order_payments(order_id, status)');
    await client.query('CREATE INDEX IF NOT EXISTS orders_customer_phone_created_at_idx ON orders(customer_phone, created_at DESC)');
    await client.query(`
      CREATE TABLE IF NOT EXISTS dining_tables (
        id BIGSERIAL PRIMARY KEY,
        table_code VARCHAR(32) NOT NULL UNIQUE,
        display_name VARCHAR(100) NOT NULL DEFAULT '',
        capacity INTEGER NOT NULL DEFAULT 2 CHECK (capacity > 0 AND capacity <= 100),
        status VARCHAR(16) NOT NULL DEFAULT 'AVAILABLE' CHECK (status IN ('AVAILABLE', 'OCCUPIED', 'DISABLED')),
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS dining_sessions (
        id BIGSERIAL PRIMARY KEY,
        table_id BIGINT NOT NULL REFERENCES dining_tables(id) ON DELETE RESTRICT,
        status VARCHAR(16) NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CLOSED')),
        opened_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
        closed_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
        opened_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        closed_at TIMESTAMPTZ
      )
    `);
    await client.query('ALTER TABLE orders ADD COLUMN IF NOT EXISTS table_id BIGINT REFERENCES dining_tables(id) ON DELETE SET NULL');
    await client.query('ALTER TABLE orders ADD COLUMN IF NOT EXISTS dining_session_id BIGINT REFERENCES dining_sessions(id) ON DELETE SET NULL');
    await client.query('CREATE INDEX IF NOT EXISTS dining_sessions_open_table_idx ON dining_sessions(table_id) WHERE status = \'OPEN\'');
    await client.query('CREATE INDEX IF NOT EXISTS orders_dining_session_idx ON orders(dining_session_id, created_at DESC)');
    await client.query(`
      CREATE TABLE IF NOT EXISTS order_returns (
        id BIGSERIAL PRIMARY KEY,
        return_no VARCHAR(64) NOT NULL UNIQUE,
        order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
        cash_shift_id BIGINT REFERENCES cash_shifts(id) ON DELETE SET NULL,
        returned_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
        refund_method VARCHAR(16) NOT NULL CHECK (refund_method IN ('CASH', 'QR', 'TRANSFER', 'CARD', 'OTHER')),
        refund_amount NUMERIC(12, 2) NOT NULL CHECK (refund_amount > 0),
        points_earned_reversed INTEGER NOT NULL DEFAULT 0 CHECK (points_earned_reversed >= 0),
        points_redeemed_restored INTEGER NOT NULL DEFAULT 0 CHECK (points_redeemed_restored >= 0),
        coupon_usage_restored BOOLEAN NOT NULL DEFAULT FALSE,
        reason VARCHAR(500) NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS order_return_items (
        id BIGSERIAL PRIMARY KEY,
        return_id BIGINT NOT NULL REFERENCES order_returns(id) ON DELETE CASCADE,
        order_item_id BIGINT NOT NULL REFERENCES order_items(id) ON DELETE RESTRICT,
        product_id BIGINT REFERENCES products(id) ON DELETE SET NULL,
        product_name VARCHAR(200) NOT NULL DEFAULT '',
        quantity NUMERIC(12, 3) NOT NULL CHECK (quantity > 0),
        unit_price NUMERIC(12, 2) NOT NULL CHECK (unit_price >= 0),
        refund_amount NUMERIC(12, 2) NOT NULL CHECK (refund_amount >= 0)
      )
    `);
    await client.query('CREATE INDEX IF NOT EXISTS order_returns_order_created_idx ON order_returns(order_id, created_at DESC)');
    await client.query('CREATE INDEX IF NOT EXISTS order_return_items_order_item_idx ON order_return_items(order_item_id)');
    await client.query('ALTER TABLE order_returns ADD COLUMN IF NOT EXISTS points_earned_reversed INTEGER NOT NULL DEFAULT 0');
    await client.query('ALTER TABLE order_returns ADD COLUMN IF NOT EXISTS points_redeemed_restored INTEGER NOT NULL DEFAULT 0');
    await client.query('ALTER TABLE order_returns ADD COLUMN IF NOT EXISTS coupon_usage_restored BOOLEAN NOT NULL DEFAULT FALSE');
    await client.query(`
      CREATE TABLE IF NOT EXISTS suppliers (
        id BIGSERIAL PRIMARY KEY,
        name VARCHAR(160) NOT NULL UNIQUE,
        contact_name VARCHAR(120) NOT NULL DEFAULT '',
        phone VARCHAR(30) NOT NULL DEFAULT '',
        email VARCHAR(160) NOT NULL DEFAULT '',
        address TEXT NOT NULL DEFAULT '',
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS purchase_orders (
        id BIGSERIAL PRIMARY KEY,
        po_no VARCHAR(64) NOT NULL UNIQUE,
        supplier_id BIGINT REFERENCES suppliers(id) ON DELETE SET NULL,
        status VARCHAR(16) NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'SENT', 'RECEIVED', 'CANCELLED')),
        expected_date DATE,
        note TEXT NOT NULL DEFAULT '',
        created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        sent_at TIMESTAMPTZ,
        received_at TIMESTAMPTZ,
        cancelled_at TIMESTAMPTZ
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS purchase_order_items (
        id BIGSERIAL PRIMARY KEY,
        purchase_order_id BIGINT NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
        ingredient_id BIGINT NOT NULL REFERENCES ingredients(id) ON DELETE RESTRICT,
        quantity NUMERIC(12, 3) NOT NULL CHECK (quantity > 0),
        unit_cost NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (unit_cost >= 0),
        line_total NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (line_total >= 0)
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS stock_receipts (
        id BIGSERIAL PRIMARY KEY,
        receipt_no VARCHAR(64) NOT NULL UNIQUE,
        supplier_id BIGINT REFERENCES suppliers(id) ON DELETE SET NULL,
        purchase_order_id BIGINT REFERENCES purchase_orders(id) ON DELETE SET NULL,
        received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        note TEXT NOT NULL DEFAULT '',
        total_amount NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (total_amount >= 0),
        created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await client.query('ALTER TABLE stock_receipts ADD COLUMN IF NOT EXISTS purchase_order_id BIGINT REFERENCES purchase_orders(id) ON DELETE SET NULL');
    await client.query(`
      CREATE TABLE IF NOT EXISTS stock_receipt_items (
        id BIGSERIAL PRIMARY KEY,
        receipt_id BIGINT NOT NULL REFERENCES stock_receipts(id) ON DELETE CASCADE,
        ingredient_id BIGINT NOT NULL REFERENCES ingredients(id) ON DELETE RESTRICT,
        quantity NUMERIC(12, 3) NOT NULL CHECK (quantity > 0),
        unit_cost NUMERIC(12, 2) NOT NULL CHECK (unit_cost >= 0),
        line_total NUMERIC(12, 2) NOT NULL CHECK (line_total >= 0)
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS inventory_movements (
        id BIGSERIAL PRIMARY KEY,
        ingredient_id BIGINT NOT NULL REFERENCES ingredients(id) ON DELETE RESTRICT,
        movement_type VARCHAR(24) NOT NULL CHECK (movement_type IN ('INITIAL', 'PURCHASE', 'MANUAL_RESTOCK', 'ADJUSTMENT')),
        quantity_change NUMERIC(12, 3) NOT NULL,
        unit_cost NUMERIC(12, 2),
        reference_type VARCHAR(32) NOT NULL DEFAULT '',
        reference_id BIGINT,
        note TEXT NOT NULL DEFAULT '',
        created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await client.query('CREATE INDEX IF NOT EXISTS stock_receipts_received_at_idx ON stock_receipts(received_at DESC)');
    await client.query('CREATE INDEX IF NOT EXISTS purchase_orders_status_created_idx ON purchase_orders(status, created_at DESC)');
    await client.query('CREATE INDEX IF NOT EXISTS purchase_order_items_order_idx ON purchase_order_items(purchase_order_id)');
    await client.query('CREATE INDEX IF NOT EXISTS stock_receipts_purchase_order_idx ON stock_receipts(purchase_order_id)');
    await client.query('CREATE INDEX IF NOT EXISTS stock_receipt_items_receipt_idx ON stock_receipt_items(receipt_id)');
    await client.query('CREATE INDEX IF NOT EXISTS inventory_movements_ingredient_idx ON inventory_movements(ingredient_id, created_at DESC)');
    await client.query(`
      CREATE TABLE IF NOT EXISTS inventory_lots (
        id BIGSERIAL PRIMARY KEY,
        ingredient_id BIGINT NOT NULL REFERENCES ingredients(id) ON DELETE RESTRICT,
        stock_receipt_item_id BIGINT REFERENCES stock_receipt_items(id) ON DELETE SET NULL,
        lot_no VARCHAR(100) NOT NULL DEFAULT '',
        received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        expiry_date DATE,
        initial_quantity NUMERIC(12, 3) NOT NULL CHECK (initial_quantity > 0),
        remaining_quantity NUMERIC(12, 3) NOT NULL CHECK (remaining_quantity >= 0),
        unit_cost NUMERIC(12, 4) NOT NULL DEFAULT 0 CHECK (unit_cost >= 0),
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS order_item_lot_allocations (
        id BIGSERIAL PRIMARY KEY,
        order_item_id BIGINT NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
        inventory_lot_id BIGINT NOT NULL REFERENCES inventory_lots(id) ON DELETE RESTRICT,
        quantity NUMERIC(12, 3) NOT NULL CHECK (quantity > 0),
        unit_cost NUMERIC(12, 4) NOT NULL CHECK (unit_cost >= 0),
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await client.query('CREATE UNIQUE INDEX IF NOT EXISTS inventory_lots_receipt_item_unique_idx ON inventory_lots(stock_receipt_item_id) WHERE stock_receipt_item_id IS NOT NULL');
    await client.query('CREATE INDEX IF NOT EXISTS inventory_lots_fefo_idx ON inventory_lots(ingredient_id, expiry_date, received_at) WHERE remaining_quantity > 0');
    await client.query('CREATE INDEX IF NOT EXISTS order_item_lot_allocations_order_item_idx ON order_item_lot_allocations(order_item_id)');
    await client.query(`
      CREATE TABLE IF NOT EXISTS order_return_lot_restorations (
        id BIGSERIAL PRIMARY KEY,
        return_item_id BIGINT NOT NULL REFERENCES order_return_items(id) ON DELETE CASCADE,
        order_item_lot_allocation_id BIGINT NOT NULL REFERENCES order_item_lot_allocations(id) ON DELETE RESTRICT,
        inventory_lot_id BIGINT NOT NULL REFERENCES inventory_lots(id) ON DELETE RESTRICT,
        quantity NUMERIC(12, 3) NOT NULL CHECK (quantity > 0),
        unit_cost NUMERIC(12, 4) NOT NULL CHECK (unit_cost >= 0),
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await client.query('CREATE INDEX IF NOT EXISTS order_return_lot_restoration_allocation_idx ON order_return_lot_restorations(order_item_lot_allocation_id)');
    await client.query(`
      INSERT INTO inventory_lots
        (ingredient_id, lot_no, received_at, expiry_date, initial_quantity, remaining_quantity, unit_cost)
      SELECT i.id, 'OPENING-' || i.id, CURRENT_TIMESTAMP, i.expiry_date,
             i.stock_qty, i.stock_qty, i.cost_per_unit
      FROM ingredients i
      WHERE i.stock_qty > 0
        AND NOT EXISTS (
          SELECT 1 FROM inventory_lots il
          WHERE il.ingredient_id = i.id
        )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS expenses (
        id BIGSERIAL PRIMARY KEY,
        amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
        category VARCHAR(100) NOT NULL DEFAULT 'OPERATING_EXPENSE',
        description TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await client.query('ALTER TABLE expenses ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT \'\'');
    await client.query(`
      CREATE TABLE IF NOT EXISTS daily_closings (
        id BIGSERIAL PRIMARY KEY,
        business_date DATE NOT NULL UNIQUE,
        closed_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
        closed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        order_count INTEGER NOT NULL DEFAULT 0,
        gross_amount NUMERIC(12, 2) NOT NULL DEFAULT 0,
        net_revenue NUMERIC(12, 2) NOT NULL DEFAULT 0,
        total_cogs NUMERIC(12, 2) NOT NULL DEFAULT 0,
        gross_profit NUMERIC(12, 2) NOT NULL DEFAULT 0,
        discount_amount NUMERIC(12, 2) NOT NULL DEFAULT 0,
        expenses NUMERIC(12, 2) NOT NULL DEFAULT 0,
        operating_profit NUMERIC(12, 2) NOT NULL DEFAULT 0,
        note TEXT NOT NULL DEFAULT ''
      )
    `);
    await client.query('CREATE INDEX IF NOT EXISTS daily_closings_date_idx ON daily_closings(business_date DESC)');
    await client.query(`
      CREATE TABLE IF NOT EXISTS audit_logs (
        id BIGSERIAL PRIMARY KEY,
        actor_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
        actor_username VARCHAR(64) NOT NULL DEFAULT '',
        actor_role VARCHAR(16) NOT NULL DEFAULT '',
        action VARCHAR(12) NOT NULL,
        resource VARCHAR(160) NOT NULL,
        resource_id VARCHAR(80),
        request_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
        status_code INTEGER NOT NULL,
        ip_address VARCHAR(100) NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await client.query('CREATE INDEX IF NOT EXISTS audit_logs_created_at_idx ON audit_logs(created_at DESC)');
    await client.query('CREATE INDEX IF NOT EXISTS audit_logs_actor_idx ON audit_logs(actor_user_id, created_at DESC)');
    await client.query(`
      CREATE TABLE IF NOT EXISTS go_live_checks (
        check_key VARCHAR(80) PRIMARY KEY,
        status VARCHAR(16) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PASSED', 'BLOCKED')),
        note VARCHAR(1000) NOT NULL DEFAULT '',
        checked_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    client.release();
    console.log('⚡ Connected to PostgreSQL ดDatabase Successfully!');

    const PORT = process.env.PORT || 3000;
    server.listen(PORT, () => {
      console.log(`🚀 Server listening on port ${PORT}`);
    });
  } catch (error) {
    console.error('❌ Database Connection Error:', error);
    if (!process.env.DATABASE_URL && !process.env.PGHOST && !process.env.PGUSER && !process.env.PGDATABASE) {
      console.error('💡 Please set DATABASE_URL or PGHOST/PGUSER/PGPASSWORD/PGDATABASE (or use a .env file).');
    }
    process.exit(1);
  }
};

startServer();

// 1. ตั้งค่า CORS สำหรับ HTTP & WebSockets
if (!configuredFrontendOrigins.length) {
  console.warn('FRONTEND_ORIGINS is not configured. Only built-in local and production frontend origins are allowed; set it before adding another frontend domain.');
}
app.disable('x-powered-by');
app.use(cors({
  origin: corsOrigin,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', 'X-StockPOS-Envelope'],
  exposedHeaders: ['X-StockPOS-Envelope'],
  maxAge: 600,
}));
app.use((req, res, next) => {
  const forwardedProtocol = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  const isSecureRequest = req.secure || forwardedProtocol === 'https';
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'no-referrer');
  // API responses are JSON only. These headers prevent browser contexts from framing
  // or interpreting an API response as active page content.
  res.set('Content-Security-Policy', "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
  res.set('Permissions-Policy', 'camera=(), geolocation=(), microphone=()');
  res.set('Cross-Origin-Resource-Policy', 'same-site');
  // Railway terminates TLS at its proxy. Send HSTS only after the browser reached us via HTTPS.
  if (isSecureRequest) res.set('Strict-Transport-Security', 'max-age=31536000');
  next();
});
app.use(express.json({ limit: '1mb' }));
app.use(createApiEnvelopeMiddleware({ enabled: apiEnvelopeEncryptionEnabled }));
app.use('/api', apiRateLimiter);

// Disable caching for API responses to avoid 304 Not Modified in clients
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.set('Surrogate-Control', 'no-store');
  next();
});

// GET /api/health - ตรวจสถานะ API และการเชื่อมต่อฐานข้อมูลสำหรับหน้าร้าน
app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1 AS database_ok');
    res.json({
      success: true,
      data: {
        api: 'ok',
        database: 'ok',
        uptime_seconds: Math.floor((Date.now() - serverStartedAt) / 1000),
        checked_at: new Date().toISOString(),
      },
    });
  } catch (error) {
    res.status(503).json({
      success: false,
      data: { api: 'ok', database: 'unavailable', checked_at: new Date().toISOString() },
      error: 'Database is unavailable',
    });
  }
});

app.use('/api', (req, res, next) => {
  res.on('finish', () => {
    if (res.statusCode < 500) recordAuditLog(req, res.statusCode);
  });
  next();
});

const authConfigured = (res) => {
  if (process.env.AUTH_SECRET) return true;
  res.status(503).json({ success: false, error: 'Authentication is not configured' });
  return false;
};

app.post('/api/auth/register', registrationRateLimiter, async (req, res) => {
  if (!authConfigured(res)) return;
  const username = String(req.body?.username || '').trim().toLowerCase();
  const fullName = String(req.body?.full_name || '').trim();
  const phone = normalizePhone(req.body?.phone);
  const password = String(req.body?.password || '');
  if (!/^[a-z0-9._-]{3,64}$/.test(username) || fullName.length < 2 || !isValidPhone(phone) || password.length < 8) {
    return res.status(400).json({ success: false, error: 'Username, name, phone, or password is invalid' });
  }
  try {
    const result = await pool.query(
      `INSERT INTO users (username, full_name, password_hash, role, phone)
       VALUES ($1, $2, $3, 'USER', $4) RETURNING id, username, full_name, phone, role, role_key`,
      [username, fullName, hashPassword(password), phone]
    );
    const user = result.rows[0];
    res.status(201).json({ success: true, data: { user: publicUser(user), token: createToken(user) } });
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ success: false, error: 'Username or phone is already in use' });
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/auth/login', loginRateLimiter, async (req, res) => {
  if (!authConfigured(res)) return;
  const username = String(req.body?.username || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  try {
    const result = await pool.query('SELECT id, username, full_name, phone, password_hash, role, role_key FROM users WHERE username = $1', [username]);
    const user = result.rows[0];
    if (!user || !verifyPassword(password, user.password_hash)) return res.status(401).json({ success: false, error: 'Invalid username or password' });
    if (needsPasswordUpgrade(user.password_hash)) {
      await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hashPassword(password), user.id]);
    }
    res.json({ success: true, data: { user: publicUser(user), token: createToken(user) } });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Re-check the signed-in user's password when the screen was locked for inactivity.
// This deliberately returns no new token, so the original session expiry remains in force.
app.post('/api/auth/verify-password', requireAuth, sessionUnlockRateLimiter, async (req, res) => {
  const password = String(req.body?.password || '');
  if (!password) return res.status(400).json({ success: false, error: 'Password is required' });
  try {
    const result = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.user.sub]);
    const user = result.rows[0];
    if (!user) return res.status(401).json({ success: false, error: 'Session is no longer valid' });
    if (!verifyPassword(password, user.password_hash)) {
      return res.status(403).json({ success: false, error: 'รหัสผ่านไม่ถูกต้อง' });
    }
    return res.json({ success: true, data: { verified: true } });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

// The assistant is read-only: it receives only the user's role, current screen,
// and question. The StockPOS handbook is attached by the selected provider.
app.post('/api/assistant/chat', requireAuth, assistantRateLimiter, async (req, res) => {
  if (!assistantConfigured()) {
    return res.status(503).json({
      success: false,
      error: assistantProvider !== 'openai' && assistantProvider !== 'ollama'
        ? 'ผู้ให้บริการ AI ที่เลือกไม่รองรับ'
        : 'ผู้ช่วย AI ยังไม่ได้เปิดใช้งานหรือกำหนดค่าไม่ครบ',
      code: 'ASSISTANT_NOT_CONFIGURED',
    });
  }
  try {
    const permissions = await rolePermissionsFor(req.user.roleKey || req.user.role);
    const contextScopes = allowedAssistantScopes(req.body?.context_scopes, {
      role: req.user.role,
      permissions,
    });
    const systemContext = await buildAssistantContext(pool, contextScopes, req.user.sub);
    const result = await askSystemAssistant({
      provider: assistantProvider,
      apiKey: process.env.OPENAI_API_KEY,
      model: assistantProvider === 'ollama'
        ? process.env.OLLAMA_ASSISTANT_MODEL || 'llama3.2:1b'
        : process.env.OPENAI_ASSISTANT_MODEL || 'gpt-5-mini',
      ollamaBaseUrl: process.env.OLLAMA_BASE_URL,
      timeoutMs: process.env.AI_ASSISTANT_TIMEOUT_MS,
      userId: req.user.sub,
      role: req.user.roleKey || req.user.role,
      view: req.body?.current_view,
      question: req.body?.question,
      history: req.body?.history,
      systemContext,
    });
    return res.json({ success: true, data: { ...result, context_scopes: contextScopes } });
  } catch (error) {
    const statusCode = Number(error.statusCode) || 502;
    console.error('AI assistant request failed', {
      statusCode,
      code: error.code || 'ASSISTANT_ERROR',
      provider: error.provider || null,
    });
    return res.status(statusCode).json({
      success: false,
      error: error.message || 'ไม่สามารถตอบคำถามได้ในขณะนี้',
      code: error.code || 'ASSISTANT_ERROR',
    });
  }
});

app.get('/api/auth/me', requireAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT id, username, full_name, phone, role, role_key FROM users WHERE id = $1', [req.user.sub]);
    if (!result.rows.length) return res.status(401).json({ success: false, error: 'Session is no longer valid' });
    const user = result.rows[0];
    const permissions = await rolePermissionsFor(user.role_key || user.role);
    res.json({ success: true, data: { ...publicUser(user), permissions } });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

const goLiveCheckKeys = new Set([
  'database_backup',
  'audit_log_review',
  'admin_access',
  'staff_access',
  'user_access',
  'sales_flow',
  'print_flow',
]);

// GET /api/admin/go-live/readiness - สถานะข้อมูลที่ต้องตรวจสอบก่อนเปิดใช้จริง
app.get('/api/admin/go-live/readiness', requireAuth, requireRoles('ADMIN'), async (req, res) => {
  try {
    const [rolesResult, channelResult, productResult, inventoryResult, shiftResult, backupResult] = await Promise.all([
      pool.query(`SELECT role, COUNT(*)::int AS count FROM users GROUP BY role ORDER BY role ASC`),
      pool.query(`SELECT COUNT(*)::int AS active_channels FROM channels WHERE is_active = TRUE`),
      pool.query(`SELECT COUNT(*)::int AS active_products FROM products WHERE is_sold_out = FALSE`),
      pool.query(`SELECT COUNT(*)::int AS low_stock_count FROM ingredients WHERE stock_qty <= min_stock_alert`),
      pool.query(`SELECT COUNT(*)::int AS open_shift_count FROM cash_shifts WHERE status = 'OPEN'`),
      pool.query(`SELECT MAX(created_at) AS last_backup_at FROM audit_logs WHERE action = 'EXPORT' AND resource = 'admin/backups'`),
    ]);
    const roleCounts = Object.fromEntries(rolesResult.rows.map((row) => [String(row.role || '').toLowerCase(), Number(row.count || 0)]));
    res.json({
      success: true,
      data: {
        role_counts: roleCounts,
        active_channels: Number(channelResult.rows[0]?.active_channels || 0),
        active_products: Number(productResult.rows[0]?.active_products || 0),
        low_stock_count: Number(inventoryResult.rows[0]?.low_stock_count || 0),
        open_shift_count: Number(shiftResult.rows[0]?.open_shift_count || 0),
        last_backup_at: backupResult.rows[0]?.last_backup_at || null,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/admin/backups/export - ส่งออก snapshot ข้อมูลธุรกิจแบบ JSON (ไม่ส่งออก password hash)
app.get('/api/admin/backups/export', requireAuth, requireRoles('ADMIN'), async (req, res) => {
  const backupQueries = {
    users: `SELECT id, username, full_name, role, phone, created_at FROM users ORDER BY id`,
    channels: `SELECT * FROM channels ORDER BY id`,
    ingredients: `SELECT * FROM ingredients ORDER BY id`,
    inventory_lots: `SELECT * FROM inventory_lots ORDER BY id`,
    products: `SELECT * FROM products ORDER BY id`,
    product_channel_settings: `SELECT * FROM product_channel_settings ORDER BY product_id, channel_id`,
    recipes: `SELECT * FROM recipes ORDER BY id`,
    product_modifier_groups: `SELECT * FROM product_modifier_groups ORDER BY id`,
    product_modifier_options: `SELECT * FROM product_modifier_options ORDER BY id`,
    suppliers: `SELECT * FROM suppliers ORDER BY id`,
    purchase_orders: `SELECT * FROM purchase_orders ORDER BY id`,
    purchase_order_items: `SELECT * FROM purchase_order_items ORDER BY id`,
    stock_receipts: `SELECT * FROM stock_receipts ORDER BY id`,
    stock_receipt_items: `SELECT * FROM stock_receipt_items ORDER BY id`,
    inventory_movements: `SELECT * FROM inventory_movements ORDER BY id`,
    orders: `SELECT * FROM orders ORDER BY id`,
    order_items: `SELECT * FROM order_items ORDER BY id`,
    order_item_modifiers: `SELECT * FROM order_item_modifiers ORDER BY id`,
    order_item_lot_allocations: `SELECT * FROM order_item_lot_allocations ORDER BY id`,
    order_returns: `SELECT * FROM order_returns ORDER BY id`,
    order_return_items: `SELECT * FROM order_return_items ORDER BY id`,
    order_return_lot_restorations: `SELECT * FROM order_return_lot_restorations ORDER BY id`,
    order_payments: `SELECT * FROM order_payments ORDER BY id`,
    dining_tables: `SELECT * FROM dining_tables ORDER BY id`,
    dining_sessions: `SELECT * FROM dining_sessions ORDER BY id`,
    coupons: `SELECT * FROM coupons ORDER BY id`,
    promotions: `SELECT * FROM promotions ORDER BY id`,
    expenses: `SELECT * FROM expenses ORDER BY id`,
    cash_shifts: `SELECT * FROM cash_shifts ORDER BY id`,
    daily_closings: `SELECT * FROM daily_closings ORDER BY id`,
    loyalty_accounts: `SELECT * FROM loyalty_accounts ORDER BY id`,
    loyalty_transactions: `SELECT * FROM loyalty_transactions ORDER BY id`,
    audit_logs: `SELECT * FROM audit_logs ORDER BY id`,
    go_live_checks: `SELECT * FROM go_live_checks ORDER BY check_key`,
  };
  try {
    const result = await Promise.all(Object.entries(backupQueries).map(async ([name, query]) => {
      const rows = await pool.query(query);
      return [name, rows.rows];
    }));
    const generatedAt = new Date();
    await pool.query(
      `INSERT INTO audit_logs
       (actor_user_id, actor_username, actor_role, action, resource, request_summary, status_code, ip_address)
       VALUES ($1, $2, $3, 'EXPORT', 'admin/backups', $4::jsonb, 200, $5)`,
      [req.user.sub, req.user.username || '', req.user.role || '', JSON.stringify({ table_count: result.length }), String(req.ip || '').slice(0, 100)],
    );
    const stamp = generatedAt.toISOString().replace(/[:.]/g, '-');
    res.attachment(`stockpos-business-backup-${stamp}.json`).json({
      backup_format: 'stockpos-business-data-v1',
      generated_at: generatedAt.toISOString(),
      generated_by: { id: req.user.sub, username: req.user.username, role: req.user.role },
      note: 'Snapshot excludes password hashes. Keep it encrypted and use a database-provider backup or pg_dump for a full infrastructure restore.',
      tables: Object.fromEntries(result),
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/admin/audit-logs - ประวัติการแก้ไขและการทำรายการสำคัญ
app.get('/api/admin/audit-logs', requireAuth, requireRoles('ADMIN'), requirePermission('audit-logs', 'view'), async (req, res) => {
  const limit = Math.min(200, Math.max(1, Number(req.query?.limit) || 30));
  const scope = String(req.query?.scope || 'all').toLowerCase();
  const importantOnly = scope === 'important';
  const search = String(req.query?.search || '').trim().slice(0, 160);
  const from = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query?.from || '')) ? String(req.query.from) : null;
  const to = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query?.to || '')) ? String(req.query.to) : null;
  try {
    const conditions = [];
    const params = [];
    if (importantOnly) {
      conditions.push(`al.status_code BETWEEN 200 AND 299 AND (
        (al.resource = 'admin/loyalty-members' AND al.action IN ('PUT', 'DELETE'))
        OR (al.resource = 'admin/users' AND al.action = 'PUT' AND al.request_summary ? 'role_key')
        OR (al.resource LIKE 'products/%' AND al.action IN ('PUT', 'DELETE') AND (al.request_summary ->> 'price_changed' = 'true' OR al.action = 'DELETE'))
        OR (al.resource LIKE 'orders/%' AND al.action IN ('PUT', 'DELETE'))
      )`);
    }
    if (search) {
      params.push(`%${search}%`);
      const searchParam = `$${params.length}`;
      conditions.push(`(
        al.actor_username ILIKE ${searchParam}
        OR COALESCE(u.full_name, '') ILIKE ${searchParam}
        OR al.action ILIKE ${searchParam}
        OR al.resource ILIKE ${searchParam}
        OR COALESCE(al.resource_id, '') ILIKE ${searchParam}
        OR al.request_summary::text ILIKE ${searchParam}
      )`);
    }
    if (from) {
      params.push(from);
      conditions.push(`(al.created_at AT TIME ZONE 'Asia/Bangkok')::date >= $${params.length}::date`);
    }
    if (to) {
      params.push(to);
      conditions.push(`(al.created_at AT TIME ZONE 'Asia/Bangkok')::date <= $${params.length}::date`);
    }
    params.push(limit);
    const result = await pool.query(
      `SELECT al.*, COALESCE(u.full_name, NULLIF(al.actor_username, ''), 'ระบบ') AS actor_name
       FROM audit_logs al
       LEFT JOIN users u ON u.id = al.actor_user_id
       ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
       ORDER BY al.created_at DESC, al.id DESC
       LIMIT $${params.length}`,
      params,
    );
    res.json({ success: true, data: result.rows });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET/PUT /api/admin/go-live-checks - เก็บผลการตรวจรับก่อนเปิดใช้งาน
app.get('/api/admin/go-live-checks', requireAuth, requireRoles('ADMIN'), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT glc.*, COALESCE(u.full_name, u.username, 'ผู้ดูแลระบบ') AS checked_by_name
       FROM go_live_checks glc
       LEFT JOIN users u ON u.id = glc.checked_by
       ORDER BY glc.check_key ASC`,
    );
    res.json({ success: true, data: result.rows });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.put('/api/admin/go-live-checks/:key', requireAuth, requireRoles('ADMIN'), async (req, res) => {
  const checkKey = String(req.params.key || '').trim();
  const status = String(req.body?.status || 'PENDING').trim().toUpperCase();
  const note = String(req.body?.note || '').trim().slice(0, 1000);
  if (!goLiveCheckKeys.has(checkKey) || !['PENDING', 'PASSED', 'BLOCKED'].includes(status)) {
    return res.status(400).json({ success: false, error: 'Invalid readiness check' });
  }
  try {
    const result = await pool.query(
      `INSERT INTO go_live_checks (check_key, status, note, checked_by, updated_at)
       VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
       ON CONFLICT (check_key) DO UPDATE
         SET status = EXCLUDED.status, note = EXCLUDED.note, checked_by = EXCLUDED.checked_by, updated_at = CURRENT_TIMESTAMP
       RETURNING *`,
      [checkKey, status, note, req.user.sub],
    );
    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/admin/role-permissions', requireAuth, requireRoles('ADMIN'), requirePermission('role-permissions', 'view'), async (req, res) => {
  try {
    const result = await pool.query('SELECT role, base_role, display_name, permissions, updated_at FROM role_permissions ORDER BY role');
    const profiles = await Promise.all(result.rows.map(async (row) => ({
      ...row,
      permissions: await rolePermissionsFor(row.role),
    })));
    res.json({ success: true, data: profiles });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/admin/role-permissions', requireAuth, requireRoles('ADMIN'), requirePermission('role-permissions', 'create'), async (req, res) => {
  const role = String(req.body?.role || '').trim().toUpperCase();
  const displayName = String(req.body?.display_name || '').trim().slice(0, 80);
  const baseRole = String(req.body?.base_role || 'STAFF').trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_]{2,31}$/.test(role) || ['ADMIN', 'STAFF', 'USER'].includes(role)) {
    return res.status(400).json({ success: false, error: 'Role code must be 3-32 characters and cannot replace a system role' });
  }
  if (!['ADMIN', 'STAFF', 'USER'].includes(baseRole)) return res.status(400).json({ success: false, error: 'Base role is invalid' });
  try {
    const permissions = sanitizePermissions(req.body?.permissions || ROLE_PERMISSION_DEFAULTS[baseRole]);
    const result = await pool.query(
      `INSERT INTO role_permissions (role, base_role, display_name, permissions, updated_by)
       VALUES ($1, $2, $3, $4::jsonb, $5)
       RETURNING role, base_role, display_name, permissions, updated_at`,
      [role, baseRole, displayName || role, JSON.stringify(permissions), req.user.sub],
    );
    res.status(201).json({ success: true, data: { ...result.rows[0], permissions: sanitizePermissions(result.rows[0].permissions) } });
  } catch (error) {
    res.status(error.code === '23505' ? 409 : 500).json({ success: false, error: error.code === '23505' ? 'Role code already exists' : error.message });
  }
});

app.put('/api/admin/role-permissions/:role', requireAuth, requireRoles('ADMIN'), requirePermission('role-permissions', 'update'), async (req, res) => {
  const role = String(req.params.role || '').toUpperCase();
  if (role === 'ADMIN') return res.status(400).json({ success: false, error: 'Admin permissions cannot be changed' });
  try {
    const permissions = sanitizePermissions(req.body?.permissions);
    const result = await pool.query(
      `UPDATE role_permissions SET display_name = COALESCE(NULLIF($1, ''), display_name), permissions = $2::jsonb, updated_by = $3, updated_at = CURRENT_TIMESTAMP
       WHERE role = $4 RETURNING role, base_role, display_name, permissions, updated_at`,
      [String(req.body?.display_name || '').trim().slice(0, 80), JSON.stringify(permissions), req.user.sub, role],
    );
    if (!result.rows.length) return res.status(404).json({ success: false, error: 'Role not found' });
    res.json({ success: true, data: { ...result.rows[0], permissions: sanitizePermissions(result.rows[0].permissions) } });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.delete('/api/admin/role-permissions/:role', requireAuth, requireRoles('ADMIN'), requirePermission('role-permissions', 'delete'), async (req, res) => {
  const role = String(req.params.role || '').toUpperCase();
  if (['ADMIN', 'STAFF', 'USER'].includes(role)) return res.status(400).json({ success: false, error: 'System roles cannot be deleted' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const assigned = await client.query('SELECT COUNT(*)::int AS total FROM users WHERE role_key = $1 FOR UPDATE', [role]);
    if (Number(assigned.rows[0]?.total || 0)) throw requestError('Move users out of this role before deleting it', 409);
    const deleted = await client.query(
      'DELETE FROM role_permissions WHERE role = $1 RETURNING role, base_role, display_name, permissions',
      [role],
    );
    if (!deleted.rows.length) throw requestError('Role not found', 404);
    req.auditSummary = { deleted: deleted.rows[0] };
    await client.query('COMMIT');
    res.json({ success: true, data: deleted.rows[0] });
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  } finally {
    client.release();
  }
});

app.get('/api/admin/users', requireAuth, requireRoles('ADMIN'), requirePermission('role-permissions', 'view'), async (req, res) => {
  try {
    const result = await pool.query('SELECT id, username, full_name, phone, role, role_key, created_at FROM users ORDER BY created_at DESC');
    res.json({ success: true, data: result.rows.map((user) => publicUser(user)) });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.put('/api/admin/users/:id/role', requireAuth, requireRoles('ADMIN'), requirePermission('role-permissions', 'update'), async (req, res) => {
  const roleKey = String(req.body?.role_key || '').trim().toUpperCase();
  try {
    const roleResult = await pool.query('SELECT role, base_role FROM role_permissions WHERE role = $1', [roleKey]);
    if (!roleResult.rows.length) return res.status(400).json({ success: false, error: 'Role not found' });
    const targetId = Number(req.params.id);
    if (!Number.isInteger(targetId) || targetId <= 0) return res.status(400).json({ success: false, error: 'User is invalid' });
    if (targetId === Number(req.user.sub) && roleResult.rows[0].base_role !== 'ADMIN') return res.status(400).json({ success: false, error: 'You cannot remove your own admin access' });
    const updated = await pool.query(
      `UPDATE users SET role = $1, role_key = $2 WHERE id = $3
       RETURNING id, username, full_name, phone, role, role_key`,
      [roleResult.rows[0].base_role, roleResult.rows[0].role, targetId],
    );
    if (!updated.rows.length) return res.status(404).json({ success: false, error: 'User not found' });
    res.json({ success: true, data: publicUser(updated.rows[0]) });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/loyalty/settings', requireAuth, requireRoles('ADMIN'), requirePermission('loyalty-settings', 'view'), async (req, res) => {
  try {
    res.json({ success: true, data: await getLoyaltyRules() });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.put('/api/loyalty/settings', requireAuth, requireRoles('ADMIN'), requirePermission('loyalty-settings', 'update'), async (req, res) => {
  try {
    const settings = validateLoyaltySettings(req.body);
    const result = await pool.query(
      `UPDATE loyalty_settings
       SET is_enabled = $1, earn_enabled = $2, redeem_enabled = $3, earn_mode = $4, spend_per_point = $5, cups_per_point = $6,
           baht_per_point = $7, max_redeem_percent = $8, updated_by = $9, updated_at = CURRENT_TIMESTAMP
       WHERE id = 1
       RETURNING is_enabled, earn_enabled, redeem_enabled, earn_mode, spend_per_point, cups_per_point, baht_per_point, max_redeem_percent, updated_at`,
      [
        settings.is_enabled,
        settings.earn_enabled,
        settings.redeem_enabled,
        settings.earn_mode,
        settings.spend_per_point,
        settings.cups_per_point,
        settings.baht_per_point,
        settings.max_redeem_percent,
        req.user.sub,
      ],
    );
    res.json({ success: true, data: loyaltyRules(result.rows[0]) });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});

app.get('/api/loyalty/me', requireAuth, requireRoles('USER'), async (req, res) => {
  try {
    const rules = await getLoyaltyRules();
    const userResult = await pool.query('SELECT phone FROM users WHERE id = $1', [req.user.sub]);
    const phone = userResult.rows[0]?.phone || '';
    if (!phone) return res.json({ success: true, data: { account: null, rules } });
    const result = await pool.query(
      `SELECT id, customer_phone, customer_name, points_balance, lifetime_points, lifetime_spend, updated_at
       FROM loyalty_accounts WHERE customer_phone = $1`,
      [phone]
    );
    res.json({ success: true, data: { account: loyaltyAccountPayload(result.rows[0]), rules } });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/loyalty/lookup', requireAuth, requireRoles('ADMIN', 'STAFF'), requirePermission('pos', 'view'), protectedLookupRateLimiter, async (req, res) => {
  const phone = normalizePhone(req.body?.phone);
  if (!isValidPhone(phone)) return res.status(400).json({ success: false, error: 'Customer phone number is invalid' });
  try {
    const rules = await getLoyaltyRules();
    const result = await pool.query(
      `SELECT id, customer_phone, customer_name, points_balance, lifetime_points, lifetime_spend, updated_at
       FROM loyalty_accounts WHERE customer_phone = $1`,
      [phone]
    );
    res.json({ success: true, data: { account: loyaltyAccountPayload(result.rows[0]), rules } });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/admin/loyalty-members', requireAuth, requireRoles('ADMIN'), requirePermission('loyalty-members', 'view'), async (req, res) => {
  const search = String(req.query?.search || '').trim().slice(0, 120);
  const limit = Math.min(200, Math.max(1, Number(req.query?.limit) || 100));
  try {
    const result = await pool.query(
      `SELECT la.id, la.customer_phone, la.customer_name, la.points_balance, la.lifetime_points,
              la.lifetime_spend, la.created_at, la.updated_at,
              COUNT(DISTINCT o.id)::int AS order_count,
              MAX(o.created_at) AS last_order_at
       FROM loyalty_accounts la
       LEFT JOIN orders o ON o.loyalty_account_id = la.id
       WHERE ($1 = '' OR la.customer_phone ILIKE '%' || $1 || '%' OR la.customer_name ILIKE '%' || $1 || '%')
       GROUP BY la.id
       ORDER BY la.updated_at DESC, la.id DESC
       LIMIT $2`,
      [search, limit],
    );
    res.json({ success: true, data: result.rows.map(loyaltyAccountPayload) });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/admin/loyalty-members', requireAuth, requireRoles('ADMIN'), requirePermission('loyalty-members', 'create'), async (req, res) => {
  const phone = normalizePhone(req.body?.customer_phone);
  const name = String(req.body?.customer_name || '').trim().slice(0, 120);
  const openingPoints = Number(req.body?.opening_points || 0);
  if (!isValidPhone(phone)) return res.status(400).json({ success: false, error: 'Customer phone number is invalid' });
  if (!Number.isInteger(openingPoints) || openingPoints < 0) return res.status(400).json({ success: false, error: 'Opening points must be a non-negative whole number' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const inserted = await client.query(
      `INSERT INTO loyalty_accounts (customer_phone, customer_name, points_balance, lifetime_points)
       VALUES ($1, $2, $3, $3)
       RETURNING id, customer_phone, customer_name, points_balance, lifetime_points, lifetime_spend, created_at, updated_at`,
      [phone, name, openingPoints],
    );
    const account = inserted.rows[0];
    if (openingPoints) {
      await client.query(
        `INSERT INTO loyalty_transactions (loyalty_account_id, transaction_type, points_delta, amount, note)
         VALUES ($1, 'EARN', $2, 0, 'Opening balance set by admin')`,
        [account.id, openingPoints],
      );
    }
    await client.query('COMMIT');
    res.status(201).json({ success: true, data: loyaltyAccountPayload(account) });
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(error.code === '23505' ? 409 : 500).json({ success: false, error: error.code === '23505' ? 'A member already exists for this phone number' : error.message });
  } finally {
    client.release();
  }
});

app.put('/api/admin/loyalty-members/:id', requireAuth, requireRoles('ADMIN'), requirePermission('loyalty-members', 'update'), async (req, res) => {
  const phone = normalizePhone(req.body?.customer_phone);
  const name = String(req.body?.customer_name || '').trim().slice(0, 120);
  const requestedPoints = Number(req.body?.points_balance);
  if (!isValidPhone(phone)) return res.status(400).json({ success: false, error: 'Customer phone number is invalid' });
  if (!Number.isInteger(requestedPoints) || requestedPoints < 0) return res.status(400).json({ success: false, error: 'Points balance must be a non-negative whole number' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query(
      `SELECT id, customer_phone, customer_name, points_balance, lifetime_points, lifetime_spend
       FROM loyalty_accounts WHERE id = $1 FOR UPDATE`,
      [req.params.id],
    );
    if (!existing.rows.length) throw requestError('Member not found', 404);
    const account = existing.rows[0];
    const pointDelta = requestedPoints - Number(account.points_balance || 0);
    const updated = await client.query(
      `UPDATE loyalty_accounts
       SET customer_phone = $1, customer_name = $2, points_balance = $3,
           lifetime_points = lifetime_points + $4, updated_at = CURRENT_TIMESTAMP
       WHERE id = $5
       RETURNING id, customer_phone, customer_name, points_balance, lifetime_points, lifetime_spend, created_at, updated_at`,
      [phone, name, requestedPoints, Math.max(0, pointDelta), account.id],
    );
    if (pointDelta) {
      await client.query(
        `INSERT INTO loyalty_transactions (loyalty_account_id, transaction_type, points_delta, amount, note)
         VALUES ($1, $2, $3, 0, 'Balance adjusted by admin')`,
        [account.id, pointDelta > 0 ? 'EARN' : 'REDEEM', pointDelta],
      );
    }
    await client.query('COMMIT');
    res.json({ success: true, data: loyaltyAccountPayload(updated.rows[0]) });
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(error.statusCode || (error.code === '23505' ? 409 : 500)).json({ success: false, error: error.code === '23505' ? 'A member already exists for this phone number' : error.message });
  } finally {
    client.release();
  }
});

app.delete('/api/admin/loyalty-members/:id', requireAuth, requireRoles('ADMIN'), requirePermission('loyalty-members', 'delete'), async (req, res) => {
  try {
    const result = await pool.query(
      `DELETE FROM loyalty_accounts WHERE id = $1
       RETURNING id, customer_phone, customer_name, points_balance, lifetime_points, lifetime_spend, order_count, last_order_at`,
      [req.params.id],
    );
    if (!result.rows.length) return res.status(404).json({ success: false, error: 'Member not found' });
    req.auditSummary = { deleted: result.rows[0] };
    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/users/customers', requireAuth, requireRoles('ADMIN', 'STAFF'), async (req, res) => {
  try {
    const result = await pool.query(`SELECT id, username, full_name, phone FROM users WHERE role = 'USER' ORDER BY username ASC`);
    res.json({ success: true, data: result.rows.map((user) => ({ id: Number(user.id), username: user.username, name: user.full_name, phone: user.phone || '' })) });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

const promotionPayload = (body = {}) => {
  const name = String(body.name || '').trim().slice(0, 140);
  const discountType = String(body.discount_type || '').trim().toUpperCase();
  const discountValue = Number(body.discount_value);
  const minOrderAmount = Math.max(0, Number(body.min_order_amount || 0));
  const maxDiscountAmount = body.max_discount_amount === '' || body.max_discount_amount === null || body.max_discount_amount === undefined ? null : Number(body.max_discount_amount);
  const channelId = body.channel_id ? Number(body.channel_id) : null;
  const startTime = body.start_time ? String(body.start_time).slice(0, 5) : null;
  const endTime = body.end_time ? String(body.end_time).slice(0, 5) : null;
  if (!name || !['AMOUNT', 'PERCENT'].includes(discountType) || !Number.isFinite(discountValue) || discountValue <= 0 || (discountType === 'PERCENT' && discountValue > 100) || !Number.isFinite(minOrderAmount) || (maxDiscountAmount !== null && (!Number.isFinite(maxDiscountAmount) || maxDiscountAmount <= 0)) || (channelId !== null && (!Number.isInteger(channelId) || channelId <= 0))) throw requestError('ข้อมูลโปรโมชั่นไม่ถูกต้อง');
  return { name, discountType, discountValue, minOrderAmount, maxDiscountAmount, channelId, requiresMember: body.requires_member === true, startTime, endTime, validFrom: body.valid_from || null, validUntil: body.valid_until || null, priority: Number.isInteger(Number(body.priority)) ? Number(body.priority) : 0, isActive: body.is_active !== false };
};

app.get('/api/promotions', requireAuth, requireRoles('ADMIN'), async (req, res) => {
  try { const result = await pool.query('SELECT * FROM promotions ORDER BY is_active DESC, priority DESC, id DESC'); res.json({ success: true, data: result.rows }); }
  catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.post('/api/promotions/quote', requireAuth, requireRoles('ADMIN', 'STAFF'), requirePermission('pos', 'view'), protectedLookupRateLimiter, async (req, res) => {
  const channelId = Number(req.body?.channel_id);
  const amount = Math.max(0, Number(req.body?.amount || 0));
  const customerPhone = normalizePhone(req.body?.customer_phone);
  if (!Number.isInteger(channelId) || channelId <= 0 || !Number.isFinite(amount)) return res.status(400).json({ success: false, error: 'ข้อมูลสำหรับคำนวณโปรโมชั่นไม่ถูกต้อง' });
  try {
    const result = await pool.query('SELECT * FROM promotions WHERE is_active = TRUE ORDER BY priority DESC, id DESC');
    const promotion = result.rows.find((item) => promotionMatchesCheckout(item, { channelId, customerPhone }) && promotionDiscountForAmount(item, amount) > 0) || null;
    res.json({ success: true, data: promotion ? { promotion, discount_amount: promotionDiscountForAmount(promotion, amount) } : { promotion: null, discount_amount: 0 } });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.post('/api/promotions', requireAuth, requireRoles('ADMIN'), async (req, res) => {
  try {
    const promotion = promotionPayload(req.body);
    const result = await pool.query(`INSERT INTO promotions (name, discount_type, discount_value, min_order_amount, max_discount_amount, channel_id, requires_member, start_time, end_time, valid_from, valid_until, priority, is_active) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`, [promotion.name, promotion.discountType, promotion.discountValue, promotion.minOrderAmount, promotion.maxDiscountAmount, promotion.channelId, promotion.requiresMember, promotion.startTime, promotion.endTime, promotion.validFrom, promotion.validUntil, promotion.priority, promotion.isActive]);
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (error) { res.status(error.statusCode || 500).json({ success: false, error: error.message }); }
});

app.put('/api/promotions/:id', requireAuth, requireRoles('ADMIN'), async (req, res) => {
  try {
    const promotion = promotionPayload(req.body);
    const result = await pool.query(`UPDATE promotions SET name=$1, discount_type=$2, discount_value=$3, min_order_amount=$4, max_discount_amount=$5, channel_id=$6, requires_member=$7, start_time=$8, end_time=$9, valid_from=$10, valid_until=$11, priority=$12, is_active=$13, updated_at=CURRENT_TIMESTAMP WHERE id=$14 RETURNING *`, [promotion.name, promotion.discountType, promotion.discountValue, promotion.minOrderAmount, promotion.maxDiscountAmount, promotion.channelId, promotion.requiresMember, promotion.startTime, promotion.endTime, promotion.validFrom, promotion.validUntil, promotion.priority, promotion.isActive, req.params.id]);
    if (!result.rows.length) return res.status(404).json({ success: false, error: 'ไม่พบโปรโมชั่น' });
    res.json({ success: true, data: result.rows[0] });
  } catch (error) { res.status(error.statusCode || 500).json({ success: false, error: error.message }); }
});

app.post('/api/coupons/validate', requireAuth, requireRoles('ADMIN', 'STAFF'), requirePermission('pos', 'view'), protectedLookupRateLimiter, async (req, res) => {
  const code = normalizeCouponCode(req.body?.code);
  const amount = Math.max(0, Number(req.body?.amount) || 0);
  if (!code) return res.status(400).json({ success: false, error: 'Coupon code is required' });

  try {
    const result = await pool.query(
      `SELECT id, code, discount_type, discount_value, min_order_amount, max_discount_amount,
              valid_from, valid_until, usage_limit, used_count, is_active
       FROM coupons WHERE UPPER(code) = $1`,
      [code]
    );
    const coupon = result.rows[0];
    const discountAmount = validateCouponForAmount(coupon, amount);
    res.json({
      success: true,
      data: {
        code: coupon.code,
        discount_type: coupon.discount_type,
        discount_value: Number(coupon.discount_value),
        min_order_amount: Number(coupon.min_order_amount || 0),
        max_discount_amount: Number(coupon.max_discount_amount || 0),
        discount_amount: Number(discountAmount.toFixed(2)),
      }
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});

app.get('/api/coupons', requireAuth, requireRoles('ADMIN'), requirePermission('coupons', 'view'), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, code, discount_type, discount_value, min_order_amount, max_discount_amount,
              valid_from, valid_until, usage_limit, used_count, is_active, created_at
       FROM coupons ORDER BY created_at DESC`
    );
    res.json({ success: true, data: result.rows });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/coupons', requireAuth, requireRoles('ADMIN'), requirePermission('coupons', 'create'), async (req, res) => {
  const code = normalizeCouponCode(req.body?.code);
  const discountType = String(req.body?.discount_type || '').toUpperCase();
  const discountValue = Number(req.body?.discount_value);
  const minOrderAmount = Math.max(0, Number(req.body?.min_order_amount) || 0);
  const hasMaxDiscount = req.body?.max_discount_amount !== undefined && req.body?.max_discount_amount !== null && req.body?.max_discount_amount !== '';
  const hasUsageLimit = req.body?.usage_limit !== undefined && req.body?.usage_limit !== null && req.body?.usage_limit !== '';
  const maxDiscountAmount = hasMaxDiscount ? Number(req.body.max_discount_amount) : null;
  const usageLimit = hasUsageLimit ? Number(req.body.usage_limit) : null;
  const validFrom = req.body?.valid_from || null;
  const validUntil = req.body?.valid_until || null;

  if (!/^[A-Z0-9_-]{3,64}$/.test(code) || !['AMOUNT', 'PERCENT'].includes(discountType) || !Number.isFinite(discountValue) || discountValue <= 0) {
    return res.status(400).json({ success: false, error: 'Coupon data is invalid' });
  }
  if (discountType === 'PERCENT' && discountValue > 100) return res.status(400).json({ success: false, error: 'Percent discount cannot exceed 100' });
  if ((maxDiscountAmount !== null && (!Number.isFinite(maxDiscountAmount) || maxDiscountAmount <= 0)) ||
      (usageLimit !== null && (!Number.isInteger(usageLimit) || usageLimit <= 0))) {
    return res.status(400).json({ success: false, error: 'Coupon limit data is invalid' });
  }
  if (validFrom && validUntil && new Date(validFrom) > new Date(validUntil)) return res.status(400).json({ success: false, error: 'Coupon date range is invalid' });

  try {
    const result = await pool.query(
      `INSERT INTO coupons (code, discount_type, discount_value, min_order_amount, max_discount_amount, usage_limit, valid_from, valid_until)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [code, discountType, discountValue, minOrderAmount, maxDiscountAmount, usageLimit, validFrom, validUntil]
    );
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ success: false, error: 'Coupon code already exists' });
    res.status(500).json({ success: false, error: error.message });
  }
});

app.put('/api/coupons/:id', requireAuth, requireRoles('ADMIN'), requirePermission('coupons', 'update'), async (req, res) => {
  const couponId = Number(req.params.id);
  const code = normalizeCouponCode(req.body?.code);
  const discountType = String(req.body?.discount_type || '').toUpperCase();
  const discountValue = Number(req.body?.discount_value);
  const minOrderAmount = Math.max(0, Number(req.body?.min_order_amount) || 0);
  const hasMaxDiscount = req.body?.max_discount_amount !== undefined && req.body?.max_discount_amount !== null && req.body?.max_discount_amount !== '';
  const hasUsageLimit = req.body?.usage_limit !== undefined && req.body?.usage_limit !== null && req.body?.usage_limit !== '';
  const maxDiscountAmount = hasMaxDiscount ? Number(req.body.max_discount_amount) : null;
  const usageLimit = hasUsageLimit ? Number(req.body.usage_limit) : null;
  const validFrom = req.body?.valid_from || null;
  const validUntil = req.body?.valid_until || null;
  const isActive = typeof req.body?.is_active === 'boolean' ? req.body.is_active : true;

  if (!Number.isInteger(couponId) || couponId <= 0 || !/^[A-Z0-9_-]{3,64}$/.test(code) || !['AMOUNT', 'PERCENT'].includes(discountType) || !Number.isFinite(discountValue) || discountValue <= 0) {
    return res.status(400).json({ success: false, error: 'Coupon data is invalid' });
  }
  if (discountType === 'PERCENT' && discountValue > 100) return res.status(400).json({ success: false, error: 'Percent discount cannot exceed 100' });
  if ((maxDiscountAmount !== null && (!Number.isFinite(maxDiscountAmount) || maxDiscountAmount <= 0)) ||
      (usageLimit !== null && (!Number.isInteger(usageLimit) || usageLimit <= 0))) {
    return res.status(400).json({ success: false, error: 'Coupon limit data is invalid' });
  }
  if (validFrom && validUntil && new Date(validFrom) > new Date(validUntil)) return res.status(400).json({ success: false, error: 'Coupon date range is invalid' });

  try {
    const result = await pool.query(
      `UPDATE coupons
       SET code = $1, discount_type = $2, discount_value = $3, min_order_amount = $4,
           max_discount_amount = $5, usage_limit = $6, valid_from = $7, valid_until = $8, is_active = $9
       WHERE id = $10
       RETURNING *`,
      [code, discountType, discountValue, minOrderAmount, maxDiscountAmount, usageLimit, validFrom, validUntil, isActive, couponId]
    );
    if (!result.rows.length) return res.status(404).json({ success: false, error: 'Coupon not found' });
    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ success: false, error: 'Coupon code already exists' });
    res.status(500).json({ success: false, error: error.message });
  }
});

// Register routers after middleware
app.use('/api/inventory', requireAuth, requireRoles('ADMIN'), requireResourcePermission('inventory'), inventoryRouter);
app.use('/api/purchase-orders', requireAuth, requireRoles('ADMIN'), requireResourcePermission('procurement'), purchaseOrdersRouter);
app.use('/api/orders', requireAuth, ordersRouter);
app.use('/api/products', requireAuth, requireRoles('ADMIN', 'STAFF'), requireResourcePermission('menu'), productsRouter);

const io = new Server(server, {
  cors: {
    origin: corsOrigin,
    methods: ['GET', 'POST'],
    allowedHeaders: ['Authorization'],
  },
  allowRequest: (req, callback) => callback(null, isAllowedOrigin(req.headers.origin)),
});
app.set('socketio', io);

io.use((socket, next) => {
  try {
    socket.user = verifyToken(socket.handshake.auth?.token);
    next();
  } catch (error) {
    next(new Error('Authentication required'));
  }
});

// 2. จัดการการเชื่อมต่อ WebSockets (สำหรับ Real-time 3D Scene Updates)
io.on('connection', (socket) => {
  if (socket.user.role === 'USER') socket.join(`user:${socket.user.sub}`);
  else socket.join('operations');
  console.log(`🔌 Client Connected: ${socket.id}`);

  socket.on('disconnect', () => {
    console.log(`❌ Client Disconnected: ${socket.id}`);
  });
});

// ----------------------------------------------------
// API ROUTES
// ----------------------------------------------------

// Dashboard สาธารณะ: แสดงเฉพาะคิวของวันนี้ หรือกรองด้วยเบอร์โทรได้
app.post('/api/public/orders/lookup', publicLookupRateLimiter, async (req, res) => {
  const phone = normalizePhone(req.body?.phone);
  if (phone && !isValidPhone(phone)) {
    return res.status(400).json({ success: false, error: 'Please enter a valid phone number' });
  }

  try {
    const result = await pool.query(
      `SELECT o.id, o.order_no, o.queue_no, o.customer_name, o.customer_nickname, o.status, o.created_at, c.name AS channel_name,
              COALESCE(
                JSON_AGG(JSON_BUILD_OBJECT(
                  'product_id', oi.product_id,
                  'name', p.name,
                  'quantity', oi.quantity,
                  'modifiers', COALESCE((
                    SELECT JSON_AGG(JSON_BUILD_OBJECT(
                      'group_name', oim.group_name,
                      'name', oim.option_name
                    ) ORDER BY oim.id)
                    FROM order_item_modifiers oim
                    WHERE oim.order_item_id = oi.id
                  ), '[]'::json)
                ) ORDER BY oi.id) FILTER (WHERE oi.id IS NOT NULL), '[]'::json
              ) AS items
       FROM orders o
       LEFT JOIN channels c ON c.id = o.channel_id
       LEFT JOIN order_items oi ON oi.order_id = o.id
       LEFT JOIN products p ON p.id = oi.product_id
       WHERE ($1::varchar IS NULL OR o.customer_phone = $1)
         AND (o.created_at AT TIME ZONE 'Asia/Bangkok')::date = (NOW() AT TIME ZONE 'Asia/Bangkok')::date
       GROUP BY o.id, c.name
       ORDER BY o.created_at DESC
       LIMIT 50`,
      [phone || null]
    );
    res.json({ success: true, data: result.rows });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});

// 📌 Health Check Endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date() });
});

const tablePayload = (body = {}) => {
  const tableCode = String(body.table_code || '').trim().toUpperCase().replace(/\s+/g, '-').slice(0, 32);
  const displayName = String(body.display_name || '').trim().slice(0, 100);
  const capacity = Number(body.capacity || 2);
  const isActive = body.is_active !== false;
  if (!/^[A-Z0-9_-]{1,32}$/.test(tableCode)) throw requestError('รหัสโต๊ะต้องเป็นตัวอักษรอังกฤษ ตัวเลข หรือ - _', 400);
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > 100) throw requestError('จำนวนที่นั่งต้องอยู่ระหว่าง 1 ถึง 100', 400);
  return { tableCode, displayName, capacity, isActive };
};

app.get('/api/tables', requireAuth, requireRoles('ADMIN', 'STAFF'), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT dt.*, ds.id AS session_id, ds.opened_at,
              COALESCE((SELECT COUNT(*) FROM orders o WHERE o.dining_session_id = ds.id AND o.status IN ('COOKING', 'READY')), 0)::int AS active_order_count,
              COALESCE((SELECT COUNT(*) FROM orders o WHERE o.dining_session_id = ds.id), 0)::int AS order_count
       FROM dining_tables dt
       LEFT JOIN LATERAL (
         SELECT id, opened_at FROM dining_sessions WHERE table_id = dt.id AND status = 'OPEN' ORDER BY opened_at DESC LIMIT 1
       ) ds ON TRUE
       WHERE dt.is_active = TRUE OR $1::boolean = TRUE
       ORDER BY dt.is_active DESC, dt.table_code ASC`,
      [req.user.role === 'ADMIN']
    );
    res.json({ success: true, data: result.rows });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/tables', requireAuth, requireRoles('ADMIN'), async (req, res) => {
  try {
    const table = tablePayload(req.body);
    const result = await pool.query(
      `INSERT INTO dining_tables (table_code, display_name, capacity, is_active)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [table.tableCode, table.displayName, table.capacity, table.isActive]
    );
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (error) {
    res.status(error.statusCode || (error.code === '23505' ? 409 : 500)).json({ success: false, error: error.code === '23505' ? 'รหัสโต๊ะนี้มีอยู่แล้ว' : error.message });
  }
});

app.put('/api/tables/:id', requireAuth, requireRoles('ADMIN'), async (req, res) => {
  try {
    const table = tablePayload(req.body);
    const result = await pool.query(
      `UPDATE dining_tables SET table_code = $1, display_name = $2, capacity = $3, is_active = $4,
       status = CASE WHEN $4 = FALSE THEN 'DISABLED' WHEN status = 'DISABLED' THEN 'AVAILABLE' ELSE status END,
       updated_at = CURRENT_TIMESTAMP WHERE id = $5 RETURNING *`,
      [table.tableCode, table.displayName, table.capacity, table.isActive, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ success: false, error: 'ไม่พบโต๊ะ' });
    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    res.status(error.statusCode || (error.code === '23505' ? 409 : 500)).json({ success: false, error: error.code === '23505' ? 'รหัสโต๊ะนี้มีอยู่แล้ว' : error.message });
  }
});

app.post('/api/tables/:id/release', requireAuth, requireRoles('ADMIN', 'STAFF'), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const tableId = Number(req.params.id);
    const active = await client.query(
      `SELECT ds.id FROM dining_sessions ds JOIN orders o ON o.dining_session_id = ds.id
       WHERE ds.table_id = $1 AND ds.status = 'OPEN' AND o.status IN ('COOKING', 'READY') LIMIT 1 FOR UPDATE`,
      [tableId]
    );
    if (active.rows.length) throw requestError('ยังมีออเดอร์ที่ต้องจัดเตรียมอยู่ จึงปิดโต๊ะไม่ได้', 409);
    await client.query(`UPDATE dining_sessions SET status = 'CLOSED', closed_by = $1, closed_at = CURRENT_TIMESTAMP WHERE table_id = $2 AND status = 'OPEN'`, [req.user.sub, tableId]);
    const result = await client.query(`UPDATE dining_tables SET status = 'AVAILABLE', updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND is_active = TRUE RETURNING *`, [tableId]);
    if (!result.rows.length) throw requestError('ไม่พบโต๊ะที่เปิดใช้งาน', 404);
    await client.query('COMMIT');
    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  } finally { client.release(); }
});

const tableIdFrom = (value) => {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw requestError('รหัสโต๊ะไม่ถูกต้อง');
  return id;
};

const lockedTables = async (client, sourceId, targetId) => {
  if (sourceId === targetId) throw requestError('ต้องเลือกโต๊ะปลายทางคนละโต๊ะ');
  const result = await client.query(
    `SELECT * FROM dining_tables WHERE id = ANY($1::bigint[]) FOR UPDATE`,
    [[sourceId, targetId]]
  );
  const source = result.rows.find((table) => Number(table.id) === sourceId);
  const target = result.rows.find((table) => Number(table.id) === targetId);
  if (!source || !target || !source.is_active || !target.is_active || target.status === 'DISABLED') {
    throw requestError('ไม่พบโต๊ะที่เปิดใช้งาน', 404);
  }
  return { source, target };
};

const openTableSession = async (client, tableId) => {
  const result = await client.query(
    `SELECT * FROM dining_sessions WHERE table_id = $1 AND status = 'OPEN' ORDER BY opened_at DESC LIMIT 1 FOR UPDATE`,
    [tableId]
  );
  return result.rows[0] || null;
};

app.post('/api/tables/:id/move', requireAuth, requireRoles('ADMIN', 'STAFF'), async (req, res) => {
  const client = await pool.connect();
  try {
    const sourceId = tableIdFrom(req.params.id);
    const targetId = tableIdFrom(req.body?.target_table_id);
    await client.query('BEGIN');
    const { source, target } = await lockedTables(client, sourceId, targetId);
    const sourceSession = await openTableSession(client, source.id);
    if (!sourceSession) throw requestError('โต๊ะต้นทางยังไม่มีบิลที่เปิดอยู่', 409);
    if (await openTableSession(client, target.id)) throw requestError('โต๊ะปลายทางมีบิลอยู่แล้ว กรุณาใช้การรวมโต๊ะ', 409);
    await client.query(`UPDATE dining_sessions SET table_id = $1 WHERE id = $2`, [target.id, sourceSession.id]);
    await client.query(`UPDATE orders SET table_id = $1 WHERE dining_session_id = $2`, [target.id, sourceSession.id]);
    await client.query(`UPDATE dining_tables SET status = 'AVAILABLE', updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [source.id]);
    await client.query(`UPDATE dining_tables SET status = 'OCCUPIED', updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [target.id]);
    await client.query('COMMIT');
    res.json({ success: true, message: `ย้ายบิลไปยัง ${target.table_code} แล้ว` });
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  } finally { client.release(); }
});

app.post('/api/tables/:id/merge', requireAuth, requireRoles('ADMIN', 'STAFF'), async (req, res) => {
  const client = await pool.connect();
  try {
    const sourceId = tableIdFrom(req.params.id);
    const targetId = tableIdFrom(req.body?.target_table_id);
    await client.query('BEGIN');
    const { source, target } = await lockedTables(client, sourceId, targetId);
    const sourceSession = await openTableSession(client, source.id);
    if (!sourceSession) throw requestError('โต๊ะต้นทางยังไม่มีบิลที่เปิดอยู่', 409);
    let targetSession = await openTableSession(client, target.id);
    if (!targetSession) {
      targetSession = (await client.query(
        `INSERT INTO dining_sessions (table_id, opened_by) VALUES ($1, $2) RETURNING *`,
        [target.id, req.user.sub]
      )).rows[0];
    }
    await client.query(
      `UPDATE orders SET table_id = $1, dining_session_id = $2 WHERE dining_session_id = $3`,
      [target.id, targetSession.id, sourceSession.id]
    );
    await client.query(`UPDATE dining_sessions SET status = 'CLOSED', closed_by = $1, closed_at = CURRENT_TIMESTAMP WHERE id = $2`, [req.user.sub, sourceSession.id]);
    await client.query(`UPDATE dining_tables SET status = 'AVAILABLE', updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [source.id]);
    await client.query(`UPDATE dining_tables SET status = 'OCCUPIED', updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [target.id]);
    await client.query('COMMIT');
    res.json({ success: true, message: `รวมบิลเข้ากับ ${target.table_code} แล้ว` });
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  } finally { client.release(); }
});

app.post('/api/tables/:id/split', requireAuth, requireRoles('ADMIN', 'STAFF'), async (req, res) => {
  const client = await pool.connect();
  try {
    const sourceId = tableIdFrom(req.params.id);
    const targetId = tableIdFrom(req.body?.target_table_id);
    const orderIds = [...new Set((Array.isArray(req.body?.order_ids) ? req.body.order_ids : []).map(Number))]
      .filter((id) => Number.isInteger(id) && id > 0);
    if (!orderIds.length) throw requestError('เลือกอย่างน้อยหนึ่งออเดอร์เพื่อแยกโต๊ะ');
    await client.query('BEGIN');
    const { source, target } = await lockedTables(client, sourceId, targetId);
    const sourceSession = await openTableSession(client, source.id);
    if (!sourceSession) throw requestError('โต๊ะต้นทางยังไม่มีบิลที่เปิดอยู่', 409);
    let targetSession = await openTableSession(client, target.id);
    if (!targetSession) {
      targetSession = (await client.query(
        `INSERT INTO dining_sessions (table_id, opened_by) VALUES ($1, $2) RETURNING *`,
        [target.id, req.user.sub]
      )).rows[0];
    }
    const moved = await client.query(
      `UPDATE orders SET table_id = $1, dining_session_id = $2
       WHERE dining_session_id = $3 AND id = ANY($4::bigint[]) RETURNING id`,
      [target.id, targetSession.id, sourceSession.id, orderIds]
    );
    if (moved.rows.length !== orderIds.length) throw requestError('มีออเดอร์บางรายการไม่ได้อยู่ในโต๊ะต้นทาง', 409);
    const remaining = await client.query(`SELECT COUNT(*)::int AS count FROM orders WHERE dining_session_id = $1`, [sourceSession.id]);
    if (Number(remaining.rows[0]?.count || 0) === 0) {
      await client.query(`UPDATE dining_sessions SET status = 'CLOSED', closed_by = $1, closed_at = CURRENT_TIMESTAMP WHERE id = $2`, [req.user.sub, sourceSession.id]);
      await client.query(`UPDATE dining_tables SET status = 'AVAILABLE', updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [source.id]);
    }
    await client.query(`UPDATE dining_tables SET status = 'OCCUPIED', updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [target.id]);
    await client.query('COMMIT');
    res.json({ success: true, message: `แยก ${moved.rows.length} ออเดอร์ไปยัง ${target.table_code} แล้ว` });
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  } finally { client.release(); }
});

// 📌 GET /api/channels - ดึงรายชื่อช่องทางขาย
app.get('/api/channels', requireAuth, requireRoles('ADMIN', 'STAFF'), requirePermission('sales-channels', 'view'), async (req, res) => {
  try {
    const result = await pool.query(
      req.user.role === 'ADMIN'
        ? 'SELECT * FROM channels ORDER BY is_active DESC, id ASC'
        : 'SELECT * FROM channels WHERE is_active = TRUE ORDER BY id ASC'
    );
    res.json({ success: true, data: result.rows });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

const normalizeChannelPayload = (body = {}) => {
  const name = String(body.name || '').trim().replace(/\s+/g, ' ').slice(0, 120);
  const gpPercent = Number(body.gp_percent ?? 0);
  const isActive = body.is_active !== false;
  if (name.length < 2) throw requestError('Channel name must contain at least 2 characters');
  if (!Number.isFinite(gpPercent) || gpPercent < 0 || gpPercent > 100) {
    throw requestError('Channel fee percentage must be between 0 and 100');
  }
  return { name, gpPercent, isActive };
};

app.post('/api/channels', requireAuth, requireRoles('ADMIN'), requirePermission('sales-channels', 'create'), async (req, res) => {
  try {
    const { name, gpPercent, isActive } = normalizeChannelPayload(req.body);
    const result = await pool.query(
      `INSERT INTO channels (name, gp_percent, is_active)
       VALUES ($1, $2, $3) RETURNING *`,
      [name, gpPercent, isActive]
    );
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ success: false, error: 'Channel name already exists' });
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});

app.put('/api/channels/:id', requireAuth, requireRoles('ADMIN'), requirePermission('sales-channels', 'update'), async (req, res) => {
  try {
    const { name, gpPercent, isActive } = normalizeChannelPayload(req.body);
    const result = await pool.query(
      `UPDATE channels
       SET name = $1, gp_percent = $2, is_active = $3, updated_at = CURRENT_TIMESTAMP
       WHERE id = $4
       RETURNING *`,
      [name, gpPercent, isActive, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ success: false, error: 'Channel not found' });
    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ success: false, error: 'Channel name already exists' });
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});

const shiftWithCashSales = `
  SELECT cs.*, (
    COALESCE((SELECT SUM(op.paid_amount) FROM order_payments op
      WHERE op.cash_shift_id = cs.id AND op.payment_method = 'CASH' AND op.status = 'PAID'), 0)
    - COALESCE((SELECT SUM(op.change_amount) FROM order_payments op
      WHERE op.cash_shift_id = cs.id AND op.payment_method <> 'CASH' AND op.change_method = 'CASH' AND op.status = 'PAID'), 0)
    - COALESCE((SELECT SUM(orr.refund_amount) FROM order_returns orr
      WHERE orr.cash_shift_id = cs.id AND orr.refund_method = 'CASH'), 0)
  ) AS cash_sales
  FROM cash_shifts cs
`;

app.get('/api/shifts/current', requireAuth, requireRoles('ADMIN', 'STAFF'), requirePermission('cash-shifts', 'view'), async (req, res) => {
  try {
    const result = await pool.query(
      `${shiftWithCashSales}
       WHERE cs.opened_by = $1 AND cs.status = 'OPEN'
       ORDER BY cs.opened_at DESC
       LIMIT 1`,
      [req.user.sub]
    );
    res.json({ success: true, data: result.rows[0] || null });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/shifts', requireAuth, requireRoles('ADMIN'), requirePermission('cash-shifts', 'view'), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT cs.*, opened_user.full_name AS opened_by_name,
        closed_user.full_name AS closed_by_name, (
          COALESCE((SELECT SUM(op.paid_amount) FROM order_payments op WHERE op.cash_shift_id = cs.id AND op.payment_method = 'CASH' AND op.status = 'PAID'), 0)
          - COALESCE((SELECT SUM(op.change_amount) FROM order_payments op WHERE op.cash_shift_id = cs.id AND op.payment_method <> 'CASH' AND op.change_method = 'CASH' AND op.status = 'PAID'), 0)
          - COALESCE((SELECT SUM(orr.refund_amount) FROM order_returns orr WHERE orr.cash_shift_id = cs.id AND orr.refund_method = 'CASH'), 0)
        ) AS cash_sales
       FROM cash_shifts cs
       LEFT JOIN users opened_user ON opened_user.id = cs.opened_by
       LEFT JOIN users closed_user ON closed_user.id = cs.closed_by
       WHERE cs.status IN ('OPEN', 'CLOSED')
       ORDER BY cs.opened_at DESC
       LIMIT 50`
    );
    res.json({ success: true, data: result.rows });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/shifts/open', requireAuth, requireRoles('ADMIN', 'STAFF'), requirePermission('cash-shifts', 'create'), async (req, res) => {
  const openingCash = Number(req.body?.opening_cash || 0);
  const openingNote = String(req.body?.opening_note || '').trim().slice(0, 500);
  if (!Number.isFinite(openingCash) || openingCash < 0) {
    return res.status(400).json({ success: false, error: 'Opening cash is invalid' });
  }
  try {
    const result = await pool.query(
      `INSERT INTO cash_shifts (opened_by, opening_cash, opening_note)
       VALUES ($1, $2, $3) RETURNING *`,
      [req.user.sub, openingCash, openingNote]
    );
    res.status(201).json({ success: true, data: { ...result.rows[0], cash_sales: 0 } });
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ success: false, error: 'You already have an open cash shift' });
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/shifts/:id/close', requireAuth, requireRoles('ADMIN', 'STAFF'), requirePermission('cash-shifts', 'update'), async (req, res) => {
  const closingCash = Number(req.body?.closing_cash);
  const closingNote = String(req.body?.closing_note || '').trim().slice(0, 500);
  if (!Number.isFinite(closingCash) || closingCash < 0) {
    return res.status(400).json({ success: false, error: 'Closing cash is invalid' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const shiftResult = await client.query('SELECT * FROM cash_shifts WHERE id = $1 FOR UPDATE', [req.params.id]);
    const shift = shiftResult.rows[0];
    if (!shift) throw requestError('Cash shift not found', 404);
    if (shift.status !== 'OPEN') throw requestError('Cash shift is already closed', 409);
    if (req.user.role !== 'ADMIN' && Number(shift.opened_by) !== Number(req.user.sub)) {
      throw requestError('Only the shift owner or an admin can close this shift', 403);
    }
    const cashResult = await client.query(
      `SELECT (
        COALESCE((SELECT SUM(paid_amount) FROM order_payments WHERE cash_shift_id = $1 AND payment_method = 'CASH' AND status = 'PAID'), 0)
        - COALESCE((SELECT SUM(change_amount) FROM order_payments WHERE cash_shift_id = $1 AND payment_method <> 'CASH' AND change_method = 'CASH' AND status = 'PAID'), 0)
        - COALESCE((SELECT SUM(refund_amount) FROM order_returns WHERE cash_shift_id = $1 AND refund_method = 'CASH'), 0)
      ) AS cash_sales`,
      [shift.id]
    );
    const cashSales = Number(cashResult.rows[0].cash_sales || 0);
    const expectedCash = Number(shift.opening_cash || 0) + cashSales;
    const differenceAmount = closingCash - expectedCash;
    if (Math.abs(differenceAmount) >= 0.005 && !closingNote) {
      throw requestError('กรุณาระบุเหตุผลของยอดเงินที่ต่างก่อนปิดกะ', 400);
    }
    const updated = await client.query(
      `UPDATE cash_shifts
       SET status = 'CLOSED', closed_by = $1, closed_at = CURRENT_TIMESTAMP,
           closing_cash = $2, expected_cash = $3, difference_amount = $4, closing_note = $5
       WHERE id = $6 RETURNING *`,
      [req.user.sub, closingCash, expectedCash, differenceAmount, closingNote, shift.id]
    );
    await client.query('COMMIT');
    res.json({ success: true, data: { ...updated.rows[0], cash_sales: cashSales } });
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  } finally {
    client.release();
  }
});

// 📌 GET /api/orders - ดึงรายการออเดอร์ล่าสุด
app.get('/api/orders', requireAuth, requirePermission('orders', 'view'), async (req, res) => {
  const isUser = req.user.role === 'USER';
  const userId = isUser ? req.user.sub : null;
  const limitClause = isUser ? '' : 'LIMIT 100';
  try {
    const result = await pool.query(
      `SELECT o.id, o.order_no, o.queue_no, o.customer_name, o.customer_nickname, o.customer_phone, o.channel_id, c.name AS channel_name, o.status,
              o.subtotal_amount, o.discount_amount, o.manual_discount_amount, o.coupon_discount_amount, o.loyalty_discount_amount,
              o.loyalty_points_earned, o.loyalty_points_redeemed,
              o.coupon_code, o.coupon_id, o.gross_amount, o.gp_amount, o.total_cogs, o.net_revenue, o.net_profit, o.created_at,
              COALESCE((SELECT SUM(orr.refund_amount) FROM order_returns orr WHERE orr.order_id = o.id), 0) AS refunded_amount,
              COALESCE((SELECT SUM(orlr.quantity * orlr.unit_cost)
                FROM order_returns orr
                JOIN order_return_items ori ON ori.return_id = orr.id
                JOIN order_return_lot_restorations orlr ON orlr.return_item_id = ori.id
                WHERE orr.order_id = o.id), 0) AS restored_cogs,
              COALESCE((SELECT JSON_AGG(JSON_BUILD_OBJECT(
                'return_no', orr.return_no, 'refund_amount', orr.refund_amount, 'refund_method', orr.refund_method,
                'reason', orr.reason, 'created_at', orr.created_at
              ) ORDER BY orr.created_at DESC) FROM order_returns orr WHERE orr.order_id = o.id), '[]'::json) AS returns,
              COALESCE((
                SELECT JSON_BUILD_OBJECT(
                  'payment_method', op.payment_method,
                  'paid_amount', op.paid_amount,
                  'amount_received', op.amount_received,
                  'change_amount', op.change_amount,
                  'change_method', op.change_method,
                  'status', op.status,
                  'paid_at', op.paid_at
                )
                FROM order_payments op
                WHERE op.order_id = o.id
                ORDER BY op.id ASC
                LIMIT 1
              ), 'null'::json) AS payment,
              COALESCE((
                SELECT JSON_AGG(JSON_BUILD_OBJECT(
                  'id', op.id,
                  'payment_method', op.payment_method,
                  'paid_amount', op.paid_amount,
                  'amount_received', op.amount_received,
                  'change_amount', op.change_amount,
                  'change_method', op.change_method,
                  'status', op.status,
                  'paid_at', op.paid_at
                ) ORDER BY op.id ASC)
                FROM order_payments op
                WHERE op.order_id = o.id
              ), '[]'::json) AS payments,
              COALESCE(
                JSON_AGG(JSON_BUILD_OBJECT(
                  'order_item_id', oi.id,
                  'product_id', oi.product_id,
                  'name', p.name,
                  'quantity', oi.quantity,
                  'returned_quantity', COALESCE((SELECT SUM(ori.quantity) FROM order_return_items ori WHERE ori.order_item_id = oi.id), 0),
                  'unit_price', oi.unit_price,
                  'subtotal', oi.subtotal,
                  'production_station', oi.production_station,
                  'target_prep_minutes', oi.target_prep_minutes,
                  'production_status', oi.production_status,
                  'production_accepted_at', oi.production_accepted_at,
                  'production_started_at', oi.production_started_at,
                  'production_completed_at', oi.production_completed_at,
                  'modifiers', COALESCE((
                    SELECT JSON_AGG(JSON_BUILD_OBJECT(
                      'option_id', oim.modifier_option_id,
                      'group_name', oim.group_name,
                      'name', oim.option_name,
                      'price_adjustment', oim.price_adjustment
                    ) ORDER BY oim.id)
                    FROM order_item_modifiers oim
                    WHERE oim.order_item_id = oi.id
                  ), '[]'::json)
                ) ORDER BY oi.id) FILTER (WHERE oi.id IS NOT NULL), '[]'::json
              ) AS items
       FROM orders o
       LEFT JOIN channels c ON c.id = o.channel_id
       LEFT JOIN order_items oi ON oi.order_id = o.id
       LEFT JOIN products p ON p.id = oi.product_id
       WHERE ($1::bigint IS NULL
              OR o.user_id = $1
              OR o.customer_phone = (SELECT phone FROM users WHERE id = $1))
       GROUP BY o.id, c.name
       ORDER BY o.created_at DESC
       ${limitClause}`
      , [userId]
    );
    res.json({ success: true, data: result.rows });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 📌 GET /api/inventory - ดึงรายการวัตถุดิบ + ตรวจสอบสินค้าใกล้หมด/ใกล้หมดอายุ
app.get('/api/inventory', requireAuth, requireRoles('ADMIN'), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT *, 
        CASE 
          WHEN stock_qty <= min_stock_alert THEN true 
          ELSE false 
        END AS is_low_stock
       FROM ingredients 
       ORDER BY id ASC`
    );
    res.json({ success: true, data: result.rows });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 📌 GET /api/financial-summary?date=YYYY-MM-DD - ดึงยอดสรุปตามวันที่ที่เลือก
app.get('/api/financial-summary', requireAuth, requireRoles('ADMIN'), requirePermission('finance', 'view'), async (req, res) => {
  const recordDate = selectedRecordDate(req.query?.date);
  try {
    const query = `
      SELECT 
        COALESCE(SUM(o.gross_amount - COALESCE(return_totals.refund_amount, 0)), 0) AS total_gross,
        COALESCE(SUM(o.gp_amount - (o.gp_amount * COALESCE(return_totals.refund_amount, 0) / NULLIF(o.gross_amount, 0))), 0) AS total_gp,
        COALESCE(SUM(o.net_revenue - (o.net_revenue * COALESCE(return_totals.refund_amount, 0) / NULLIF(o.gross_amount, 0))), 0) AS total_net_revenue,
        COALESCE(SUM(o.total_cogs - COALESCE(return_totals.restored_cogs, 0)), 0) AS total_cogs,
        COALESCE(SUM((o.net_revenue - (o.net_revenue * COALESCE(return_totals.refund_amount, 0) / NULLIF(o.gross_amount, 0))) - (o.total_cogs - COALESCE(return_totals.restored_cogs, 0))), 0) AS total_net_profit,
        COUNT(o.id) AS total_orders,
        (SELECT COALESCE(SUM(amount), 0) FROM expenses
         WHERE DATE(created_at AT TIME ZONE 'Asia/Bangkok') = COALESCE($1::date, (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Bangkok')::date)) AS total_expenses
      FROM orders o
      LEFT JOIN (
        SELECT returned_amounts.order_id, returned_amounts.refund_amount,
               COALESCE(restored_costs.restored_cogs, 0) AS restored_cogs
        FROM (
          SELECT order_id, SUM(refund_amount) AS refund_amount
          FROM order_returns GROUP BY order_id
        ) returned_amounts
        LEFT JOIN (
          SELECT orr.order_id, SUM(orlr.quantity * orlr.unit_cost) AS restored_cogs
          FROM order_returns orr
          JOIN order_return_items ori ON ori.return_id = orr.id
          JOIN order_return_lot_restorations orlr ON orlr.return_item_id = ori.id
          GROUP BY orr.order_id
        ) restored_costs ON restored_costs.order_id = returned_amounts.order_id
      ) return_totals ON return_totals.order_id = o.id
      WHERE DATE(o.created_at AT TIME ZONE 'Asia/Bangkok') = COALESCE($1::date, (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Bangkok')::date)
        AND o.status <> 'CANCELLED';
    `;
    const result = await pool.query(query, [recordDate]);
    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 📊 GET /api/sales-breakdown?date=YYYY-MM-DD - สรุปยอดตามช่องทางและวิธีชำระเงิน
app.get('/api/sales-breakdown', requireAuth, requireRoles('ADMIN'), requirePermission('finance', 'view'), async (req, res) => {
  const recordDate = selectedRecordDate(req.query?.date);
  const dateFilter = "DATE(o.created_at AT TIME ZONE 'Asia/Bangkok') = COALESCE($1::date, (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Bangkok')::date)";
  try {
    const [channelResult, paymentResult] = await Promise.all([
      pool.query(
        `SELECT COALESCE(c.name, 'ไม่ระบุช่องทาง') AS channel_name,
                COUNT(o.id)::int AS order_count,
                COALESCE(SUM(o.gross_amount - COALESCE(rt.refund_amount, 0)), 0) AS gross_amount,
                COALESCE(SUM(o.net_revenue - (o.net_revenue * COALESCE(rt.refund_amount, 0) / NULLIF(o.gross_amount, 0))), 0) AS net_revenue
         FROM orders o
         LEFT JOIN channels c ON c.id = o.channel_id
         LEFT JOIN (SELECT order_id, SUM(refund_amount) AS refund_amount FROM order_returns GROUP BY order_id) rt ON rt.order_id = o.id
         WHERE ${dateFilter} AND o.status <> 'CANCELLED'
         GROUP BY c.id, c.name
         ORDER BY gross_amount DESC, channel_name ASC`,
        [recordDate]
      ),
      pool.query(
        `SELECT COALESCE(op.payment_method, 'OTHER') AS payment_method,
                COUNT(DISTINCT o.id)::int AS order_count,
                COALESCE(SUM(COALESCE(op.paid_amount, o.gross_amount)), 0) - COALESCE(SUM(refunds.refund_amount), 0) AS payment_amount,
                COALESCE(SUM(COALESCE(op.change_amount, 0)), 0) AS change_amount
         FROM orders o
         LEFT JOIN (
           SELECT order_id, payment_method, SUM(paid_amount) AS paid_amount, SUM(change_amount) AS change_amount
           FROM order_payments WHERE status = 'PAID'
           GROUP BY order_id, payment_method
         ) op ON op.order_id = o.id
         LEFT JOIN (
           SELECT order_id, refund_method, SUM(refund_amount) AS refund_amount
           FROM order_returns GROUP BY order_id, refund_method
         ) refunds ON refunds.order_id = o.id AND refunds.refund_method = op.payment_method
         WHERE ${dateFilter} AND o.status <> 'CANCELLED'
         GROUP BY COALESCE(op.payment_method, 'OTHER')
         ORDER BY payment_amount DESC, payment_method ASC`,
        [recordDate]
      ),
    ]);
    res.json({
      success: true,
      data: {
        channels: channelResult.rows,
        payments: paymentResult.rows,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 📈 GET /api/reports/summary?from=YYYY-MM-DD&to=YYYY-MM-DD - รายงานยอดขายเพื่อบริหารร้าน
app.get('/api/reports/summary', requireAuth, requireRoles('ADMIN'), requirePermission('business-reports', 'view'), async (req, res) => {
  const from = selectedRecordDate(req.query?.from);
  const to = selectedRecordDate(req.query?.to);
  if (!from || !to || from > to) {
    return res.status(400).json({ success: false, error: 'Please provide a valid report period' });
  }

  const periodDays = Math.floor((new Date(`${to}T00:00:00.000Z`) - new Date(`${from}T00:00:00.000Z`)) / 86400000) + 1;
  const previousTo = shiftRecordDate(from, -1);
  const previousFrom = shiftRecordDate(previousTo, -(periodDays - 1));
  const dateFilter = "DATE(o.created_at AT TIME ZONE 'Asia/Bangkok') BETWEEN $1::date AND $2::date";
  const expenseDateFilter = "DATE(e.created_at AT TIME ZONE 'Asia/Bangkok') BETWEEN $1::date AND $2::date";
  const summaryQuery = `
    SELECT COUNT(o.id)::int AS order_count,
           COALESCE(SUM(o.subtotal_amount), 0) AS subtotal_amount,
           COALESCE(SUM(o.gross_amount), 0) AS gross_amount,
           COALESCE(SUM(o.gp_amount), 0) AS gp_amount,
           COALESCE(SUM(o.net_revenue), 0) AS net_revenue,
           COALESCE(SUM(o.total_cogs), 0) AS total_cogs,
           COALESCE(SUM(o.net_profit), 0) AS net_profit,
           COALESCE(SUM(o.manual_discount_amount), 0) + COALESCE(SUM(o.coupon_discount_amount), 0) + COALESCE(SUM(o.loyalty_discount_amount), 0) AS discount_amount
    FROM orders o
    WHERE ${dateFilter} AND o.status <> 'CANCELLED'`;
  const expensesQuery = `SELECT COALESCE(SUM(e.amount), 0) AS expenses FROM expenses e WHERE ${expenseDateFilter}`;

  try {
    const [summaryResult, previousSummaryResult, expenseResult, previousExpenseResult, dailyResult, productMetricsResult, channelMetricsResult, hourlySalesResult, inventoryUsageResult] = await Promise.all([
      pool.query(summaryQuery, [from, to]),
      pool.query(summaryQuery, [previousFrom, previousTo]),
      pool.query(expensesQuery, [from, to]),
      pool.query(expensesQuery, [previousFrom, previousTo]),
      pool.query(
        `SELECT DATE(o.created_at AT TIME ZONE 'Asia/Bangkok')::text AS record_date,
                COUNT(o.id)::int AS order_count,
                COALESCE(SUM(o.net_revenue), 0) AS net_revenue,
                COALESCE(SUM(o.net_profit), 0) AS gross_profit
         FROM orders o
         WHERE ${dateFilter} AND o.status <> 'CANCELLED'
         GROUP BY DATE(o.created_at AT TIME ZONE 'Asia/Bangkok')
         ORDER BY DATE(o.created_at AT TIME ZONE 'Asia/Bangkok') ASC`,
        [from, to]
      ),
      pool.query(
        `SELECT p.id AS product_id, COALESCE(p.name, 'เมนูที่ถูกลบ') AS product_name,
                COALESCE(SUM(oi.quantity), 0) AS quantity_sold,
                COUNT(DISTINCT o.id)::int AS order_count,
                COALESCE(SUM(oi.subtotal), 0) AS list_sales_amount,
                COALESCE(SUM(oi.subtotal * COALESCE(o.discount_amount / NULLIF(o.subtotal_amount, 0), 0)), 0) AS discount_amount,
                COALESCE(SUM(oi.subtotal * COALESCE(o.gp_amount / NULLIF(o.subtotal_amount, 0), 0)), 0) AS gp_amount,
                COALESCE(SUM(oi.subtotal * COALESCE(o.net_revenue / NULLIF(o.subtotal_amount, 0), 0)), 0) AS net_revenue,
                COALESCE(SUM(CASE
                  WHEN item_cogs.order_item_id IS NULL THEN COALESCE(o.total_cogs, 0) * COALESCE(oi.subtotal / NULLIF(o.subtotal_amount, 0), 0)
                  ELSE item_cogs.total_cogs
                END), 0) AS total_cogs,
                COALESCE(SUM(oi.subtotal * COALESCE(o.net_revenue / NULLIF(o.subtotal_amount, 0), 0) - CASE
                  WHEN item_cogs.order_item_id IS NULL THEN COALESCE(o.total_cogs, 0) * COALESCE(oi.subtotal / NULLIF(o.subtotal_amount, 0), 0)
                  ELSE item_cogs.total_cogs
                END), 0) AS net_profit
         FROM orders o
         JOIN order_items oi ON oi.order_id = o.id
         LEFT JOIN products p ON p.id = oi.product_id
         LEFT JOIN (
           SELECT order_item_id, SUM(quantity * unit_cost) AS total_cogs
           FROM order_item_lot_allocations
           GROUP BY order_item_id
         ) item_cogs ON item_cogs.order_item_id = oi.id
         WHERE ${dateFilter} AND o.status <> 'CANCELLED'
         GROUP BY p.id, p.name
         ORDER BY net_revenue DESC, quantity_sold DESC, product_name ASC
         LIMIT 100`,
        [from, to]
      ),
      pool.query(
        `SELECT COALESCE(c.name, 'ไม่ระบุช่องทาง') AS channel_name,
                COUNT(o.id)::int AS order_count,
                COALESCE(SUM(o.subtotal_amount), 0) AS subtotal_amount,
                COALESCE(SUM(o.discount_amount), 0) AS discount_amount,
                COALESCE(SUM(o.gross_amount), 0) AS gross_amount,
                COALESCE(SUM(o.gp_amount), 0) AS gp_amount,
                COALESCE(SUM(o.net_revenue), 0) AS net_revenue,
                COALESCE(SUM(o.total_cogs), 0) AS total_cogs,
                COALESCE(SUM(o.net_profit), 0) AS net_profit
         FROM orders o
         LEFT JOIN channels c ON c.id = o.channel_id
         WHERE ${dateFilter} AND o.status <> 'CANCELLED'
         GROUP BY c.id, c.name
         ORDER BY net_revenue DESC, channel_name ASC`,
        [from, to]
      ),
      pool.query(
        `SELECT EXTRACT(HOUR FROM o.created_at AT TIME ZONE 'Asia/Bangkok')::int AS hour,
                COUNT(o.id)::int AS order_count,
                COALESCE(SUM(o.gross_amount), 0) AS gross_amount,
                COALESCE(SUM(o.net_revenue), 0) AS net_revenue,
                COALESCE(SUM(o.net_profit), 0) AS net_profit
         FROM orders o
         WHERE ${dateFilter} AND o.status <> 'CANCELLED'
         GROUP BY EXTRACT(HOUR FROM o.created_at AT TIME ZONE 'Asia/Bangkok')
         ORDER BY hour ASC`,
        [from, to]
      ),
      pool.query(
        `SELECT i.id AS ingredient_id, i.name AS ingredient_name, i.unit,
                COALESCE(SUM(oila.quantity), 0) AS quantity_used,
                COALESCE(SUM(oila.quantity * oila.unit_cost), 0) AS usage_cost
         FROM orders o
         JOIN order_items oi ON oi.order_id = o.id
         JOIN order_item_lot_allocations oila ON oila.order_item_id = oi.id
         JOIN inventory_lots il ON il.id = oila.inventory_lot_id
         JOIN ingredients i ON i.id = il.ingredient_id
         WHERE ${dateFilter} AND o.status <> 'CANCELLED'
         GROUP BY i.id, i.name, i.unit
         ORDER BY quantity_used DESC, usage_cost DESC, ingredient_name ASC
         LIMIT 8`,
        [from, to]
      ),
    ]);
    const formatSummary = (summary, expenses) => {
      const netProfit = Number(summary.net_profit || 0);
      const expenseTotal = Number(expenses.expenses || 0);
      return {
        order_count: Number(summary.order_count || 0),
        subtotal_amount: Number(summary.subtotal_amount || 0),
        gross_amount: Number(summary.gross_amount || 0),
        gp_amount: Number(summary.gp_amount || 0),
        net_revenue: Number(summary.net_revenue || 0),
        total_cogs: Number(summary.total_cogs || 0),
        gross_profit: netProfit,
        net_profit: netProfit,
        discount_amount: Number(summary.discount_amount || 0),
        expenses: expenseTotal,
        operating_profit: netProfit - expenseTotal,
      };
    };
    res.json({
      success: true,
      data: {
        period: { from, to, previous_from: previousFrom, previous_to: previousTo },
        summary: formatSummary(summaryResult.rows[0] || {}, expenseResult.rows[0] || {}),
        previous_summary: formatSummary(previousSummaryResult.rows[0] || {}, previousExpenseResult.rows[0] || {}),
        daily: dailyResult.rows,
        top_products: productMetricsResult.rows.slice(0, 5),
        product_metrics: productMetricsResult.rows,
        channel_metrics: channelMetricsResult.rows,
        hourly_sales: hourlySalesResult.rows,
        inventory_usage: inventoryUsageResult.rows,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 📒 GET /api/daily-closings?date=YYYY-MM-DD - สถานะปิดยอดของวันนั้น
app.get('/api/daily-closings', requireAuth, requireRoles('ADMIN'), requirePermission('finance', 'view'), async (req, res) => {
  const businessDate = selectedRecordDate(req.query?.date);
  if (!businessDate) return res.status(400).json({ success: false, error: 'Please provide a valid business date' });
  try {
    const result = await pool.query(
      `SELECT dc.*, u.full_name AS closed_by_name
       FROM daily_closings dc
       LEFT JOIN users u ON u.id = dc.closed_by
       WHERE dc.business_date = $1::date`,
      [businessDate]
    );
    res.json({ success: true, data: result.rows[0] || null });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 📒 POST /api/daily-closings - ปิดยอดและเก็บ snapshot รายวัน
app.post('/api/daily-closings', requireAuth, requireRoles('ADMIN'), requirePermission('finance', 'update'), async (req, res) => {
  const businessDate = selectedRecordDate(req.body?.business_date);
  const note = String(req.body?.note || '').trim().slice(0, 1000);
  if (!businessDate || businessDate > bangkokToday()) {
    return res.status(400).json({ success: false, error: 'Business date must not be in the future' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const openShift = await client.query(
      `SELECT id FROM cash_shifts
       WHERE status = 'OPEN'
         AND DATE(opened_at AT TIME ZONE 'Asia/Bangkok') = $1::date
       LIMIT 1`,
      [businessDate]
    );
    if (openShift.rows.length) {
      throw requestError('กรุณาปิดกะเงินสดที่เปิดอยู่ก่อนปิดยอดประจำวัน', 409);
    }
    const orderSummary = await client.query(
      `SELECT COUNT(o.id)::int AS order_count,
              COALESCE(SUM(o.gross_amount - COALESCE(rt.refund_amount, 0)), 0) AS gross_amount,
              COALESCE(SUM(o.net_revenue - (o.net_revenue * COALESCE(rt.refund_amount, 0) / NULLIF(o.gross_amount, 0))), 0) AS net_revenue,
              COALESCE(SUM(o.total_cogs - COALESCE(rt.restored_cogs, 0)), 0) AS total_cogs,
              COALESCE(SUM((o.net_revenue - (o.net_revenue * COALESCE(rt.refund_amount, 0) / NULLIF(o.gross_amount, 0))) - (o.total_cogs - COALESCE(rt.restored_cogs, 0))), 0) AS gross_profit,
              COALESCE(SUM(o.manual_discount_amount), 0) + COALESCE(SUM(o.coupon_discount_amount), 0) + COALESCE(SUM(o.loyalty_discount_amount), 0) AS discount_amount
       FROM orders o
       LEFT JOIN (
         SELECT refunds.order_id, refunds.refund_amount, COALESCE(costs.restored_cogs, 0) AS restored_cogs
         FROM (SELECT order_id, SUM(refund_amount) AS refund_amount FROM order_returns GROUP BY order_id) refunds
         LEFT JOIN (
           SELECT orr.order_id, SUM(orlr.quantity * orlr.unit_cost) AS restored_cogs
           FROM order_returns orr
           JOIN order_return_items ori ON ori.return_id = orr.id
           JOIN order_return_lot_restorations orlr ON orlr.return_item_id = ori.id
           GROUP BY orr.order_id
         ) costs ON costs.order_id = refunds.order_id
       ) rt ON rt.order_id = o.id
       WHERE DATE(o.created_at AT TIME ZONE 'Asia/Bangkok') = $1::date
         AND o.status <> 'CANCELLED'`,
      [businessDate]
    );
    const expenseSummary = await client.query(
      `SELECT COALESCE(SUM(amount), 0) AS expenses
       FROM expenses
       WHERE DATE(created_at AT TIME ZONE 'Asia/Bangkok') = $1::date`,
      [businessDate]
    );
    const totals = orderSummary.rows[0] || {};
    const expenses = Number(expenseSummary.rows[0]?.expenses || 0);
    const grossProfit = Number(totals.gross_profit || 0);
    const result = await client.query(
      `INSERT INTO daily_closings
       (business_date, closed_by, order_count, gross_amount, net_revenue, total_cogs, gross_profit, discount_amount, expenses, operating_profit, note)
       VALUES ($1::date, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [
        businessDate,
        req.user.sub,
        Number(totals.order_count || 0),
        Number(totals.gross_amount || 0),
        Number(totals.net_revenue || 0),
        Number(totals.total_cogs || 0),
        grossProfit,
        Number(totals.discount_amount || 0),
        expenses,
        grossProfit - expenses,
        note,
      ]
    );
    await client.query('COMMIT');
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (error) {
    await client.query('ROLLBACK');
    const status = error.code === '23505' ? 409 : error.statusCode || 500;
    const message = error.code === '23505' ? 'วันทำการนี้ถูกปิดยอดแล้ว' : error.message;
    res.status(status).json({ success: false, error: message });
  } finally {
    client.release();
  }
});

// POST /api/expenses - บันทึกค่าใช้จ่ายประจำวัน
app.post('/api/expenses', requireAuth, requireRoles('ADMIN'), requirePermission('finance', 'create'), async (req, res) => {
  const amount = Number(req.body?.amount);
  const category = String(req.body?.category || 'OPERATING_EXPENSE').trim();
  const description = String(req.body?.description || '').trim();
  const recordDate = selectedRecordDate(req.body?.record_date);

  if (!Number.isFinite(amount) || amount <= 0 || !category) {
    return res.status(400).json({ success: false, error: 'Invalid expense payload' });
  }

  try {
    await assertBusinessDateOpen(pool, recordDate);
    const result = await pool.query(
      `INSERT INTO expenses (amount, category, description, created_at)
       VALUES ($1, $2, $3, COALESCE($4::date::timestamp AT TIME ZONE 'Asia/Bangkok', CURRENT_TIMESTAMP))
       RETURNING *`,
      [amount, category, description, recordDate]
    );
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});

// GET /api/expenses - รายการค่าใช้จ่ายทั้งหมด
app.get('/api/expenses', requireAuth, requireRoles('ADMIN'), requirePermission('finance', 'view'), async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM expenses ORDER BY created_at DESC');
    res.json({ success: true, data: result.rows });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// PUT /api/expenses/:id - แก้ไขรายการค่าใช้จ่าย
app.put('/api/expenses/:id', requireAuth, requireRoles('ADMIN'), requirePermission('finance', 'update'), async (req, res) => {
  const amount = Number(req.body?.amount);
  const category = String(req.body?.category || '').trim();
  const description = String(req.body?.description || '').trim();
  const recordDate = selectedRecordDate(req.body?.record_date);
  if (!Number.isFinite(amount) || amount <= 0 || !category) {
    return res.status(400).json({ success: false, error: 'Invalid expense payload' });
  }
  try {
    const existing = await pool.query(
      `SELECT id, amount, category, description, created_at,
              DATE(created_at AT TIME ZONE 'Asia/Bangkok')::text AS business_date
       FROM expenses WHERE id = $1`,
      [req.params.id]
    );
    if (!existing.rows.length) return res.status(404).json({ success: false, error: 'Expense not found' });
    await assertBusinessDateOpen(pool, existing.rows[0].business_date);
    if (recordDate && recordDate !== existing.rows[0].business_date) {
      await assertBusinessDateOpen(pool, recordDate);
    }
    const result = await pool.query(
      `UPDATE expenses
       SET amount = $1, category = $2, description = $3,
           created_at = COALESCE($4::date::timestamp AT TIME ZONE 'Asia/Bangkok', created_at)
       WHERE id = $5 RETURNING *`,
      [amount, category, description, recordDate, req.params.id]
    );
    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});

// DELETE /api/expenses/:id - ลบรายการค่าใช้จ่าย
app.delete('/api/expenses/:id', requireAuth, requireRoles('ADMIN'), requirePermission('finance', 'delete'), async (req, res) => {
  try {
    const existing = await pool.query(
      `SELECT DATE(created_at AT TIME ZONE 'Asia/Bangkok')::text AS business_date
       FROM expenses WHERE id = $1`,
      [req.params.id]
    );
    if (!existing.rows.length) return res.status(404).json({ success: false, error: 'Expense not found' });
    await assertBusinessDateOpen(pool, existing.rows[0].business_date);
    const result = await pool.query('DELETE FROM expenses WHERE id = $1 RETURNING id', [req.params.id]);
    req.auditSummary = { deleted: existing.rows[0] };
    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});

// 📌 POST /api/orders - รับออเดอร์ใหม่ (ตัดสต็อคตามสูตร BOM, หัก GP และยิง Socket.io)
app.post('/api/orders', requireAuth, requireRoles('ADMIN', 'STAFF'), requirePermission('pos', 'create'), async (req, res) => {
  const { order_no, channel_id, items } = req.body;
  const suppliedClientRequestId = String(req.get('Idempotency-Key') || req.body?.client_request_id || '').trim();
  const clientRequestId = suppliedClientRequestId || null;
  const recordDate = selectedRecordDate(req.body?.record_date);
  const customerName = String(req.body?.customer_name || req.body?.customer_nickname || '').trim().slice(0, 120);
  const customerNickname = String(req.body?.customer_nickname || customerName).trim().slice(0, 80);
  const customerPhone = normalizePhone(req.body?.customer_phone);
  const requestedManualDiscount = Math.max(
    0,
    Number(req.body?.manual_discount_amount ?? req.body?.discount_amount) || 0
  );
  const requestedCouponCode = normalizeCouponCode(req.body?.coupon_code);
  const requestedPromotionId = req.body?.promotion_id ? Number(req.body.promotion_id) : null;
  const requestedLoyaltyPoints = Number(req.body?.loyalty_points_redeemed || 0);
  const suppliedPayments = Array.isArray(req.body?.payments) && req.body.payments.length
    ? req.body.payments
    : [{ payment_method: req.body?.payment_method, paid_amount: undefined, amount_received: req.body?.amount_received }];
  let requestedPayments;
  try {
    requestedPayments = suppliedPayments.map((payment) => ({
      payment_method: normalizePaymentMethod(payment?.payment_method),
      paid_amount: payment?.paid_amount === undefined || payment?.paid_amount === '' ? null : Number(payment.paid_amount),
      amount_received: payment?.amount_received === undefined || payment?.amount_received === '' ? null : Number(payment.amount_received),
    }));
  } catch (error) {
    return res.status(error.statusCode || 400).json({ success: false, error: error.message });
  }
  if (requestedPayments.length > 5 || requestedPayments.some((payment) => (payment.paid_amount !== null && (!Number.isFinite(payment.paid_amount) || payment.paid_amount < 0)) || (payment.amount_received !== null && (!Number.isFinite(payment.amount_received) || payment.amount_received < 0)))) {
    return res.status(400).json({ success: false, error: 'ข้อมูลการชำระเงินไม่ถูกต้อง' });
  }
  // ตัวอย่าง items: [ { product_id: 1, qty: 2, price: 50.00 } ]

  if (!order_no || !channel_id || !items || !items.length) {
    return res.status(400).json({ success: false, error: 'Missing required order data' });
  }
  if (clientRequestId && !/^[A-Za-z0-9._:-]{8,120}$/.test(clientRequestId)) {
    return res.status(400).json({ success: false, error: 'Idempotency-Key must contain 8-120 letters, numbers, dots, underscores, colons, or hyphens' });
  }
  if (customerPhone && !isValidPhone(customerPhone)) {
    return res.status(400).json({ success: false, error: 'Customer phone number is invalid' });
  }
  if (!Number.isInteger(requestedLoyaltyPoints) || requestedLoyaltyPoints < 0) {
    return res.status(400).json({ success: false, error: 'Loyalty points must be a non-negative whole number' });
  }
  if (requestedPromotionId !== null && (!Number.isInteger(requestedPromotionId) || requestedPromotionId <= 0)) {
    return res.status(400).json({ success: false, error: 'โปรโมชั่นที่เลือกไม่ถูกต้อง' });
  }

  const client = await pool.connect();

  try {
    // เริ่มต้น Database Transaction
    await client.query('BEGIN');
    await assertBusinessDateOpen(client, recordDate);

    // 1. ดึงข้อมูลช่องทางขาย (% GP)
    const channelRes = await client.query('SELECT name, gp_percent FROM channels WHERE id = $1 AND is_active = TRUE', [channel_id]);
    if (channelRes.rows.length === 0) {
      throw requestError('Invalid channel_id');
    }
    const channelName = channelRes.rows[0].name;
    const gpPercent = parseFloat(channelRes.rows[0].gp_percent);
    const requestedTableId = req.body?.table_id === undefined || req.body?.table_id === null || req.body?.table_id === '' ? null : Number(req.body.table_id);
    let tableId = null;
    let diningSessionId = null;
    if (requestedTableId !== null) {
      if (!Number.isInteger(requestedTableId) || requestedTableId <= 0) throw requestError('โต๊ะที่เลือกไม่ถูกต้อง');
      const tableResult = await client.query(`SELECT * FROM dining_tables WHERE id = $1 AND is_active = TRUE FOR UPDATE`, [requestedTableId]);
      const table = tableResult.rows[0];
      if (!table || table.status === 'DISABLED') throw requestError('โต๊ะที่เลือกไม่พร้อมใช้งาน', 409);
      tableId = table.id;
      const existingSession = await client.query(`SELECT id FROM dining_sessions WHERE table_id = $1 AND status = 'OPEN' ORDER BY opened_at DESC LIMIT 1 FOR UPDATE`, [tableId]);
      if (existingSession.rows.length) {
        diningSessionId = existingSession.rows[0].id;
      } else {
        const createdSession = await client.query(`INSERT INTO dining_sessions (table_id, opened_by) VALUES ($1, $2) RETURNING id`, [tableId, req.user.sub]);
        diningSessionId = createdSession.rows[0].id;
      }
      await client.query(`UPDATE dining_tables SET status = 'OCCUPIED', updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [tableId]);
    }
    // Serialize queue allocation so that two orders created together cannot receive the same queue.
    await client.query('SELECT pg_advisory_xact_lock(910246)');
    // A retry after a timeout reaches this point with the same key. Return the original
    // order instead of applying stock, coupon, payment, and loyalty changes again.
    if (clientRequestId) {
      const existingRequest = await client.query(
        `SELECT * FROM orders
         WHERE user_id = $1 AND client_request_id = $2
         LIMIT 1`,
        [req.user.sub, clientRequestId]
      );
      if (existingRequest.rows.length) {
        await client.query('COMMIT');
        return res.json({
          success: true,
          message: 'Existing order returned for this request',
          idempotent_replay: true,
          data: existingRequest.rows[0]
        });
      }
    }
    const queueResult = await client.query(
      `SELECT COALESCE(MAX(queue_no), 0) + 1 AS next_queue
       FROM orders
       WHERE DATE(created_at AT TIME ZONE 'Asia/Bangkok') =
             COALESCE($1::date, (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Bangkok')::date)`,
      [recordDate]
    );
    const queueNo = Number(queueResult.rows[0].next_queue);

    let subtotalAmount = 0;
    let totalCogs = 0;
    let totalCups = 0;

    // 2. สร้าง Order เริ่มต้น
    const orderRes = await client.query(
      `INSERT INTO orders (order_no, channel_id, gross_amount, net_revenue, status, created_at, customer_name, customer_nickname, customer_phone, queue_no, user_id, client_request_id, table_id, dining_session_id)
       VALUES ($1, $2, 0, 0, 'COOKING', COALESCE($3::date::timestamp AT TIME ZONE 'Asia/Bangkok', CURRENT_TIMESTAMP), $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING id`,
      [order_no, channel_id, recordDate, customerName || null, customerNickname || null, customerPhone || null, queueNo, req.user.sub, clientRequestId, tableId, diningSessionId]
    );
    const orderId = orderRes.rows[0].id;

    // 3. วนลูปประมวลผลสินค้าแต่ละรายการ
    for (const item of items) {
      const quantity = Number(item.qty);
      const unitPrice = Number(item.price);
      if (!Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(unitPrice) || unitPrice < 0) {
        throw requestError('Order item quantity and price are invalid');
      }
      const productResult = await client.query(
        `SELECT p.id, p.name, p.is_sold_out, p.counts_as_loyalty_cup, p.price_retail, p.production_station, p.prep_minutes,
                pcs.is_active AS channel_is_active, pcs.price_retail AS channel_price_retail
         FROM products p
         LEFT JOIN product_channel_settings pcs
           ON pcs.product_id = p.id AND pcs.channel_id = $2
         WHERE p.id = $1
         FOR KEY SHARE OF p`,
        [item.product_id, channel_id]
      );
      const product = productResult.rows[0];
      if (!product) throw requestError('Product not found', 404);
      if (product.is_sold_out) throw requestError(`${product.name} is temporarily unavailable`, 409);
      if (product.counts_as_loyalty_cup === true) totalCups += quantity;
      if (product.channel_is_active === false) {
        throw requestError(`${product.name} is not available for this sales channel`, 409);
      }
      const configuredPrice = product.channel_price_retail === null || product.channel_price_retail === undefined
        ? Number(product.price_retail || 0)
        : Number(product.channel_price_retail);
      if (Math.abs(unitPrice - configuredPrice) > 0.005) {
        throw requestError(`${product.name} price does not match this sales channel`, 409);
      }
      const selectedModifiers = await resolveItemModifiers(client, item.product_id, item.modifiers);
      const modifierAdjustment = selectedModifiers.reduce(
        (sum, modifier) => sum + Number(modifier.price_adjustment || 0),
        0
      );
      const finalUnitPrice = unitPrice + modifierAdjustment;
      if (finalUnitPrice < 0) throw requestError('Modifier adjustment makes item price invalid');
      const subtotal = quantity * finalUnitPrice;
      subtotalAmount += subtotal;

      // 3.1 บันทึกรายการลง order_items
      const orderItemResult = await client.query(
        `INSERT INTO order_items (order_id, product_id, quantity, unit_price, subtotal, production_station, target_prep_minutes)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [orderId, item.product_id, quantity, finalUnitPrice, subtotal, product.production_station || 'BAR', Number(product.prep_minutes || 5)]
      );
      const orderItemId = orderItemResult.rows[0].id;
      for (const modifier of selectedModifiers) {
        await client.query(
          `INSERT INTO order_item_modifiers (order_item_id, modifier_option_id, group_name, option_name, price_adjustment)
           VALUES ($1, $2, $3, $4, $5)`,
          [orderItemId, modifier.id, modifier.group_name, modifier.name, modifier.price_adjustment]
        );
      }

      // 3.2 ตัดวัตถุดิบตามล็อตแบบ FEFO (ล็อตใกล้หมดอายุก่อน) และเก็บต้นทุนล็อตจริง
      const recipeResult = await client.query(
        `SELECT r.ingredient_id, r.quantity_used, i.name, i.stock_qty
         FROM recipes r
         JOIN ingredients i ON i.id = r.ingredient_id
         WHERE r.product_id = $1
         FOR UPDATE OF i`,
        [item.product_id]
      );
      for (const recipeItem of recipeResult.rows) {
        const requiredQuantity = Number(recipeItem.quantity_used) * quantity;
        if (Number(recipeItem.stock_qty || 0) + 0.000001 < requiredQuantity) {
          throw requestError(`Insufficient stock for ${recipeItem.name}`);
        }
        const allocation = await consumeLots(client, recipeItem.ingredient_id, requiredQuantity, { orderItemId });
        await client.query(
          `UPDATE ingredients
           SET stock_qty = stock_qty - $1, updated_at = CURRENT_TIMESTAMP
           WHERE id = $2`,
          [requiredQuantity, recipeItem.ingredient_id]
        );
        totalCogs += Number(allocation.totalCost || 0);
      }
    }

    const manualDiscountAmount = Math.min(subtotalAmount, requestedManualDiscount);
    const couponBaseAmount = subtotalAmount - manualDiscountAmount;
    let promotionDiscountAmount = 0;
    let promotionId = null;
    if (requestedPromotionId) {
      const promotionResult = await client.query('SELECT * FROM promotions WHERE id = $1 FOR UPDATE', [requestedPromotionId]);
      const promotion = promotionResult.rows[0];
      if (!promotion || !promotionMatchesCheckout(promotion, { channelId: channel_id, customerPhone })) {
        throw requestError('โปรโมชั่นนี้ไม่สามารถใช้กับออเดอร์นี้ได้', 409);
      }
      promotionDiscountAmount = promotionDiscountForAmount(promotion, couponBaseAmount);
      if (promotionDiscountAmount <= 0) throw requestError('ยอดออเดอร์ยังไม่เข้าเงื่อนไขโปรโมชั่น', 409);
      promotionId = promotion.id;
    }
    let couponDiscountAmount = 0;
    let couponId = null;
    let couponCode = null;

    if (requestedCouponCode) {
      const couponResult = await client.query(
        `SELECT id, code, discount_type, discount_value, min_order_amount, max_discount_amount,
                valid_from, valid_until, usage_limit, used_count, is_active
         FROM coupons
         WHERE UPPER(code) = $1
         FOR UPDATE`,
        [requestedCouponCode]
      );
      const coupon = couponResult.rows[0];
      couponDiscountAmount = validateCouponForAmount(coupon, Math.max(0, couponBaseAmount - promotionDiscountAmount));
      couponId = coupon.id;
      couponCode = coupon.code;
      await client.query('UPDATE coupons SET used_count = used_count + 1 WHERE id = $1', [couponId]);
    }

    const loyaltyBaseAmount = Math.max(0, couponBaseAmount - promotionDiscountAmount - couponDiscountAmount);
    // Read the single settings row inside the order transaction. This makes every
    // earn/redeem calculation use the current admin-configured rules, not client input.
    const currentLoyaltyRules = await getLoyaltyRules(client, { forUpdate: true });
    let loyaltyAccount = null;
    let loyaltyPointsRedeemed = 0;
    let loyaltyDiscountAmount = 0;
    if (!currentLoyaltyRules.redeem_enabled && requestedLoyaltyPoints > 0) {
      throw requestError('Loyalty redemption is currently disabled', 409);
    }
    if ((currentLoyaltyRules.earn_enabled || currentLoyaltyRules.redeem_enabled) && customerPhone) {
      const accountResult = await client.query(
        `SELECT id, customer_phone, customer_name, points_balance, lifetime_points, lifetime_spend, updated_at
         FROM loyalty_accounts WHERE customer_phone = $1 FOR UPDATE`,
        [customerPhone]
      );
      if (accountResult.rows.length) {
        loyaltyAccount = accountResult.rows[0];
      } else {
        const insertedAccount = await client.query(
          `INSERT INTO loyalty_accounts (customer_phone, customer_name)
           VALUES ($1, $2)
           ON CONFLICT (customer_phone) DO UPDATE SET customer_phone = EXCLUDED.customer_phone
           RETURNING id, customer_phone, customer_name, points_balance, lifetime_points, lifetime_spend, updated_at`,
          [customerPhone, customerName]
        );
        loyaltyAccount = insertedAccount.rows[0];
      }
      if (requestedLoyaltyPoints > 0) {
        const availablePoints = Math.max(0, Number(loyaltyAccount.points_balance || 0));
        const maxRedeemPoints = Math.floor(
          (loyaltyBaseAmount * (currentLoyaltyRules.max_redeem_percent / 100)) / currentLoyaltyRules.baht_per_point,
        );
        if (requestedLoyaltyPoints > availablePoints) throw requestError('Customer does not have enough loyalty points', 409);
        if (requestedLoyaltyPoints > maxRedeemPoints) throw requestError(`This order can redeem at most ${maxRedeemPoints} points`, 400);
        loyaltyPointsRedeemed = requestedLoyaltyPoints;
        loyaltyDiscountAmount = loyaltyDiscountForPoints(loyaltyPointsRedeemed, currentLoyaltyRules);
      }
    } else if (requestedLoyaltyPoints > 0) {
      throw requestError('A customer phone number is required to redeem loyalty points');
    }

    const discountAmount = manualDiscountAmount + promotionDiscountAmount + couponDiscountAmount + loyaltyDiscountAmount;
    const grossAmount = Math.max(0, subtotalAmount - discountAmount);
    const loyaltyPointsEarned = loyaltyAccount && currentLoyaltyRules.earn_enabled
      ? loyaltyPointsForOrder({ amount: grossAmount, cups: totalCups }, currentLoyaltyRules)
      : 0;

    // A legacy caller submits one `payment_method` without an amount. A new
    // caller submits `payments`, whose allocated totals must exactly settle this order.
    const isSplitPayment = Array.isArray(req.body?.payments) && req.body.payments.length > 0;
    const settledPayments = settlePayments({ requestedPayments, grossAmount, isSplitPayment });

    let cashShiftId = null;
    if (settledPayments.some((payment) => payment.requires_cash_shift)) {
      const activeShift = await client.query(
        `SELECT id FROM cash_shifts
         WHERE opened_by = $1 AND status = 'OPEN'
         FOR UPDATE`,
        [req.user.sub]
      );
      // A cash sale may be recorded without an open shift. In that case the
      // payment remains traceable but is intentionally not assigned to a shift.
      cashShiftId = activeShift.rows[0]?.id || null;
    }
    const payments = settledPayments.map((payment) => ({
      ...payment,
      cash_shift_id: payment.requires_cash_shift ? cashShiftId : null,
    }));

    // 4. คำนวณ GP, รายรับสุทธิ, และกำไรสุทธิจากยอดหลังหักส่วนลด
    const gpAmount = grossAmount * (gpPercent / 100);
    const netRevenue = grossAmount - gpAmount;
    const netProfit = netRevenue - totalCogs;

    // 5. อัปเดตข้อมูลสรุปกลับลงในออเดอร์
    const updatedOrderRes = await client.query(
      `UPDATE orders
       SET subtotal_amount = $1, manual_discount_amount = $2, promotion_discount_amount = $3, promotion_id = $4, coupon_discount_amount = $5,
           discount_amount = $6, coupon_code = $7, coupon_id = $8,
           gross_amount = $9, gp_amount = $10, net_revenue = $11, total_cogs = $12, net_profit = $13,
           loyalty_account_id = $14, loyalty_points_earned = $15, loyalty_points_redeemed = $16,
           loyalty_discount_amount = $17
       WHERE id = $18 RETURNING *`,
      [
        subtotalAmount,
        manualDiscountAmount,
        promotionDiscountAmount,
        promotionId,
        couponDiscountAmount,
        discountAmount,
        couponCode,
        couponId,
        grossAmount,
        gpAmount,
        netRevenue,
        totalCogs,
        netProfit,
        loyaltyAccount?.id || null,
        loyaltyPointsEarned,
        loyaltyPointsRedeemed,
        loyaltyDiscountAmount,
        orderId,
      ]
    );

    for (const payment of payments) {
      await client.query(
        `INSERT INTO order_payments
         (order_id, cash_shift_id, paid_by, payment_method, paid_amount, amount_received, change_amount, change_method)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          orderId,
          payment.cash_shift_id,
          req.user.sub,
          payment.payment_method,
          payment.paid_amount,
          payment.amount_received,
          payment.change_amount,
          payment.change_method,
        ]
      );
    }

    if (loyaltyAccount) {
      await client.query(
        `UPDATE loyalty_accounts
         SET points_balance = points_balance - $1 + $2,
             lifetime_points = lifetime_points + $2,
             lifetime_spend = lifetime_spend + $3,
             customer_name = COALESCE(NULLIF($4, ''), customer_name),
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $5`,
        [loyaltyPointsRedeemed, loyaltyPointsEarned, grossAmount, customerName, loyaltyAccount.id]
      );
      if (loyaltyPointsRedeemed) {
        await client.query(
          `INSERT INTO loyalty_transactions (loyalty_account_id, order_id, transaction_type, points_delta, amount, note)
           VALUES ($1, $2, 'REDEEM', $3, $4, 'Redeemed at checkout')`,
          [loyaltyAccount.id, orderId, -loyaltyPointsRedeemed, loyaltyDiscountAmount]
        );
      }
      if (loyaltyPointsEarned) {
        await client.query(
          `INSERT INTO loyalty_transactions (loyalty_account_id, order_id, transaction_type, points_delta, amount, note)
           VALUES ($1, $2, 'EARN', $3, $4, 'Earned from order')`,
          [loyaltyAccount.id, orderId, loyaltyPointsEarned, grossAmount]
        );
      }
    }

    // ยืนยันการทำ Transaction ลง Database
    await client.query('COMMIT');

    // ส่งรายละเอียดรายการและจุดผลิตกลับไปพร้อมออเดอร์ใหม่ทันที เพื่อให้จอครัว
    // แยกงานบาร์/ครัว/ขนมได้โดยไม่ต้องรอรอบดึงข้อมูลถัดไป
    const createdItemsResult = await client.query(
      `SELECT oi.id AS order_item_id, oi.product_id, p.name, oi.quantity, oi.unit_price,
              oi.production_station, oi.target_prep_minutes, oi.production_status,
              oi.production_accepted_at, oi.production_started_at, oi.production_completed_at,
              COALESCE(
                json_agg(
                  json_build_object('id', oim.modifier_option_id, 'name', oim.option_name,
                                    'group_name', oim.group_name, 'price_adjustment', oim.price_adjustment)
                  ORDER BY oim.id
                ) FILTER (WHERE oim.id IS NOT NULL),
                '[]'::json
              ) AS modifiers
       FROM order_items oi
       JOIN products p ON p.id = oi.product_id
       LEFT JOIN order_item_modifiers oim ON oim.order_item_id = oi.id
       WHERE oi.order_id = $1
       GROUP BY oi.id, p.name
       ORDER BY oi.id`,
      [orderId]
    );
    const createdOrder = { ...updatedOrderRes.rows[0], payments, items: createdItemsResult.rows };

    // 6. ส่ง Real-time Event ให้ทุก Client (หน้าเว็บ 3D / หน้า POS / หน้า Kitchen)
    io.to('operations').emit('new_order_created', {
      order: createdOrder,
      channel: channelName,
      itemsCount: items.reduce((acc, curr) => acc + curr.qty, 0),
      message: `มีออเดอร์ใหม่ #${order_no} จาก ${channelName}`
    });

    res.status(201).json({
      success: true,
      message: 'Order created successfully',
      data: createdOrder
    });

  } catch (error) {
    // ถ้ามี Error เกิดขึ้น ให้ย้อนกลับ (Rollback) ข้อมูลทั้งหมด
    await client.query('ROLLBACK');
    console.error('❌ Transaction Error:', error);
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  } finally {
    client.release();
  }
});

// PUT /api/orders/:id - แก้ไข sales record พร้อมคำนวณยอดและสต็อกใหม่
app.put('/api/orders/:id', requireAuth, requireRoles('ADMIN', 'STAFF'), requirePermission('orders', 'update'), async (req, res) => {
  const { id } = req.params;
  const { order_no, channel_id, items, status = 'COMPLETED' } = req.body || {};
  const recordDate = selectedRecordDate(req.body?.record_date);
  const allowedStatuses = new Set(['COOKING', 'COMPLETED']);
  if (!order_no || !channel_id || !Array.isArray(items) || !items.length || !allowedStatuses.has(status)) {
    return res.status(400).json({ success: false, error: 'Invalid sales record payload' });
  }

  const normalizedItems = items.map((item) => ({
    product_id: Number(item.product_id),
    qty: Number(item.qty),
    price: Number(item.price),
  }));
  if (normalizedItems.some((item) => !Number.isInteger(item.product_id) || item.qty <= 0 || !Number.isFinite(item.price) || item.price < 0)) {
    return res.status(400).json({ success: false, error: 'Invalid sales item' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const orderResult = await client.query(
      `SELECT id, status, DATE(created_at AT TIME ZONE 'Asia/Bangkok')::text AS business_date,
              manual_discount_amount, coupon_discount_amount,
              loyalty_points_earned, loyalty_points_redeemed, loyalty_discount_amount
       FROM orders WHERE id = $1 FOR UPDATE`,
      [id]
    );
    if (!orderResult.rows.length) throw new Error('Order not found');
    await assertBusinessDateOpen(client, orderResult.rows[0].business_date);
    if (recordDate && recordDate !== orderResult.rows[0].business_date) {
      await assertBusinessDateOpen(client, recordDate);
    }
    if (orderResult.rows[0].status === 'CANCELLED') throw new Error('Cancelled sales records cannot be edited');
    if (Number(orderResult.rows[0].loyalty_points_earned || 0) || Number(orderResult.rows[0].loyalty_points_redeemed || 0)) {
      throw new Error('Loyalty-linked orders cannot be edited. Cancel and create a replacement order instead.');
    }
    const paymentCount = await client.query(
      `SELECT COUNT(*)::int AS count FROM order_payments WHERE order_id = $1 AND status = 'PAID'`,
      [id]
    );
    if (Number(paymentCount.rows[0]?.count || 0) > 1) {
      throw requestError('ออเดอร์ที่แยกชำระแล้วไม่สามารถแก้ไขรายการได้ กรุณายกเลิกแล้วสร้างใหม่', 409);
    }

    const channelResult = await client.query('SELECT gp_percent FROM channels WHERE id = $1', [channel_id]);
    if (!channelResult.rows.length) throw new Error('Invalid channel_id');

    const previousIngredients = await client.query(
      `SELECT r.ingredient_id, SUM(r.quantity_used * oi.quantity) AS quantity_to_restore,
              MAX(i.cost_per_unit) AS unit_cost
       FROM order_items oi
       JOIN recipes r ON r.product_id = oi.product_id
       JOIN ingredients i ON i.id = r.ingredient_id
       WHERE oi.order_id = $1
       GROUP BY r.ingredient_id`,
      [id]
    );
    const restoredLotCount = await restoreOrderLots(client, id);
    // คืนยอดรวมของ record เดิมก่อน แล้วจึงตรวจสอบและตัดตามรายการใหม่
    await client.query(
      `UPDATE ingredients ing
       SET stock_qty = ing.stock_qty + (r.quantity_used * oi.quantity), updated_at = CURRENT_TIMESTAMP
       FROM order_items oi
       JOIN recipes r ON r.product_id = oi.product_id
       WHERE oi.order_id = $1 AND ing.id = r.ingredient_id`,
      [id]
    );
    // ออเดอร์เก่าก่อนเริ่มระบบล็อตไม่มี allocation จึงสร้างล็อตคืนยอดเพื่อให้ยอดรวมและล็อตสอดคล้องกัน
    if (!restoredLotCount) {
      for (const row of previousIngredients.rows) {
        await addInventoryLot(client, {
          ingredientId: row.ingredient_id,
          quantity: row.quantity_to_restore,
          unitCost: row.unit_cost,
          lotNo: `LEGACY-RESTORE-${id}-${row.ingredient_id}`,
        });
      }
    }
    await client.query('DELETE FROM order_items WHERE order_id = $1', [id]);

    let subtotalAmount = 0;
    let totalCogs = 0;
    for (const item of normalizedItems) {
      const productResult = await client.query('SELECT id FROM products WHERE id = $1', [item.product_id]);
      if (!productResult.rows.length) throw new Error(`Product #${item.product_id} not found`);
      const recipeResult = await client.query(
        `SELECT r.ingredient_id, r.quantity_used, i.name, i.stock_qty
         FROM recipes r JOIN ingredients i ON i.id = r.ingredient_id
         WHERE r.product_id = $1 FOR UPDATE OF i`,
        [item.product_id]
      );
      const quantity = Number(item.qty);
      const unitPrice = Number(item.price);
      if (!Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(unitPrice) || unitPrice < 0) {
        throw requestError('Order item quantity and price are invalid');
      }
      const subtotal = quantity * unitPrice;
      subtotalAmount += subtotal;
      const orderItemResult = await client.query(
        'INSERT INTO order_items (order_id, product_id, quantity, unit_price, subtotal) VALUES ($1, $2, $3, $4, $5) RETURNING id',
        [id, item.product_id, quantity, unitPrice, subtotal]
      );
      for (const recipeItem of recipeResult.rows) {
        const requiredQty = Number(recipeItem.quantity_used) * quantity;
        if (Number(recipeItem.stock_qty || 0) + 0.000001 < requiredQty) throw new Error(`Insufficient stock for ${recipeItem.name}`);
        const allocation = await consumeLots(client, recipeItem.ingredient_id, requiredQty, { orderItemId: orderItemResult.rows[0].id });
        totalCogs += Number(allocation.totalCost || 0);
        await client.query(
          'UPDATE ingredients SET stock_qty = stock_qty - $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
          [requiredQty, recipeItem.ingredient_id]
        );
      }
    }

    const manualDiscountAmount = Math.min(
      subtotalAmount,
      Math.max(0, Number(orderResult.rows[0].manual_discount_amount) || 0)
    );
    const couponDiscountAmount = Math.min(
      subtotalAmount - manualDiscountAmount,
      Math.max(0, Number(orderResult.rows[0].coupon_discount_amount) || 0)
    );
    const discountAmount = manualDiscountAmount + couponDiscountAmount;
    const grossAmount = Math.max(0, subtotalAmount - discountAmount);
    const gpAmount = grossAmount * (Number(channelResult.rows[0].gp_percent) / 100);
    const netRevenue = grossAmount - gpAmount;
    const netProfit = netRevenue - totalCogs;
    const updated = await client.query(
      `UPDATE orders SET order_no = $1, channel_id = $2, status = $3,
       subtotal_amount = $4, manual_discount_amount = $5, coupon_discount_amount = $6, discount_amount = $7,
       gross_amount = $8, gp_amount = $9, net_revenue = $10, total_cogs = $11, net_profit = $12,
       created_at = COALESCE($13::date::timestamp AT TIME ZONE 'Asia/Bangkok', created_at)
       WHERE id = $14 RETURNING *`,
      [
        order_no,
        channel_id,
        status,
        subtotalAmount,
        manualDiscountAmount,
        couponDiscountAmount,
        discountAmount,
        grossAmount,
        gpAmount,
        netRevenue,
        totalCogs,
        netProfit,
        recordDate,
        id,
      ]
    );

    await client.query(
      `UPDATE order_payments
       SET paid_amount = $1,
           amount_received = GREATEST(amount_received, $1),
           change_amount = GREATEST(amount_received, $1) - $1,
           change_method = CASE
             WHEN payment_method IN ('CASH', 'QR', 'TRANSFER') AND GREATEST(amount_received, $1) > $1 THEN 'CASH'
             ELSE NULL
           END
       WHERE order_id = $2 AND status = 'PAID'`,
      [grossAmount, id]
    );
    await client.query('COMMIT');
    io.to('operations').emit('order_updated', { order: updated.rows[0] });
    res.json({ success: true, data: updated.rows[0] });
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(error.message === 'Order not found' ? 404 : error.statusCode || 400).json({ success: false, error: error.message });
  } finally {
    client.release();
  }
});

// DELETE /api/orders/:id - ลบ sales record และคืนสต็อกหากยังไม่ถูกยกเลิก
app.delete('/api/orders/:id', requireAuth, requireRoles('ADMIN'), async (req, res) => {
  const { id } = req.params;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const orderResult = await client.query(
      `SELECT id, order_no, channel_id, status, gross_amount, net_revenue, customer_name, customer_nickname,
              customer_phone, queue_no, created_at, DATE(created_at AT TIME ZONE 'Asia/Bangkok')::text AS business_date,
              loyalty_account_id, loyalty_points_earned, loyalty_points_redeemed
       FROM orders WHERE id = $1 FOR UPDATE`,
      [id]
    );
    if (!orderResult.rows.length) throw new Error('Order not found');
    await assertBusinessDateOpen(client, orderResult.rows[0].business_date);
    const returnCheck = await client.query('SELECT id FROM order_returns WHERE order_id = $1 LIMIT 1', [id]);
    if (returnCheck.rows.length) throw requestError('คำสั่งซื้อนี้มีประวัติคืนสินค้าแล้ว จึงไม่สามารถลบได้', 409);
    const deletedItems = await client.query(
      `SELECT oi.product_id, p.name, oi.quantity, oi.unit_price,
              COALESCE((
                SELECT JSON_AGG(JSON_BUILD_OBJECT('group_name', oim.group_name, 'option_name', oim.option_name) ORDER BY oim.id)
                FROM order_item_modifiers oim WHERE oim.order_item_id = oi.id
              ), '[]'::json) AS modifiers
       FROM order_items oi
       LEFT JOIN products p ON p.id = oi.product_id
       WHERE oi.order_id = $1
       ORDER BY oi.id`,
      [id],
    );
    req.auditSummary = {
      deleted: {
        ...orderResult.rows[0],
        items: deletedItems.rows,
      },
    };
    if (orderResult.rows[0].status !== 'CANCELLED') {
      const previousIngredients = await client.query(
        `SELECT r.ingredient_id, SUM(r.quantity_used * oi.quantity) AS quantity_to_restore,
                MAX(i.cost_per_unit) AS unit_cost
         FROM order_items oi
         JOIN recipes r ON r.product_id = oi.product_id
         JOIN ingredients i ON i.id = r.ingredient_id
         WHERE oi.order_id = $1
         GROUP BY r.ingredient_id`,
        [id]
      );
      const restoredLotCount = await restoreOrderLots(client, id);
      await client.query(
        `UPDATE ingredients ing
         SET stock_qty = ing.stock_qty + (r.quantity_used * oi.quantity), updated_at = CURRENT_TIMESTAMP
         FROM order_items oi
         JOIN recipes r ON r.product_id = oi.product_id
         WHERE oi.order_id = $1 AND ing.id = r.ingredient_id`,
        [id]
      );
      if (!restoredLotCount) {
        for (const row of previousIngredients.rows) {
          await addInventoryLot(client, {
            ingredientId: row.ingredient_id,
            quantity: row.quantity_to_restore,
            unitCost: row.unit_cost,
            lotNo: `LEGACY-DELETE-${id}-${row.ingredient_id}`,
          });
        }
      }
      const loyaltyOrder = orderResult.rows[0];
      if (loyaltyOrder.loyalty_account_id) {
        await client.query(
          `UPDATE loyalty_accounts
           SET points_balance = points_balance + $1 - $2, updated_at = CURRENT_TIMESTAMP
           WHERE id = $3`,
          [
            Number(loyaltyOrder.loyalty_points_redeemed || 0),
            Number(loyaltyOrder.loyalty_points_earned || 0),
            loyaltyOrder.loyalty_account_id,
          ]
        );
      }
    }
    await client.query('DELETE FROM loyalty_transactions WHERE order_id = $1', [id]);
    await client.query('DELETE FROM order_items WHERE order_id = $1', [id]);
    await client.query('DELETE FROM orders WHERE id = $1', [id]);
    await client.query('COMMIT');
    io.emit('order_deleted', { orderId: Number(id) });
    res.json({ success: true, data: { id: Number(id) } });
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(error.message === 'Order not found' ? 404 : error.statusCode || 400).json({ success: false, error: error.message });
  } finally {
    client.release();
  }
});

// 📌 PUT /api/orders/:id/status - อัปเดตสถานะออเดอร์ (COOKING -> READY -> COMPLETED)
app.put('/api/orders/:id/kitchen-stations/:station', requireAuth, requireRoles('ADMIN', 'STAFF'), requirePermission('kitchen', 'update'), async (req, res) => {
  const orderId = Number(req.params.id);
  const station = String(req.params.station || '').trim().toUpperCase();
  const productionStatus = String(req.body?.production_status || '').trim().toUpperCase();
  const productionStages = ['PENDING', 'ACCEPTED', 'IN_PROGRESS', 'READY'];
  if (!Number.isInteger(orderId) || !['BAR', 'KITCHEN', 'BAKERY', 'OTHER'].includes(station) || !productionStages.includes(productionStatus)) {
    return res.status(400).json({ success: false, error: 'ข้อมูลจุดผลิตหรือสถานะไม่ถูกต้อง' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const orderResult = await client.query(`SELECT id, status FROM orders WHERE id = $1 FOR UPDATE`, [orderId]);
    if (!orderResult.rows.length) throw requestError('ไม่พบคำสั่งซื้อ', 404);
    if (['CANCELLED', 'COMPLETED', 'RETURNED'].includes(orderResult.rows[0].status)) throw requestError('คำสั่งซื้อนี้ปิดงานแล้ว', 409);
    const stationItems = await client.query(
      `SELECT production_status FROM order_items
       WHERE order_id = $1 AND production_station = $2 FOR UPDATE`,
      [orderId, station]
    );
    if (!stationItems.rows.length) throw requestError('ไม่พบรายการของจุดผลิตนี้', 404);
    const currentStage = stationItems.rows
      .map((item) => String(item.production_status || 'PENDING'))
      .sort((left, right) => productionStages.indexOf(left) - productionStages.indexOf(right))[0];
    const allowedNextStages = {
      PENDING: ['ACCEPTED'],
      ACCEPTED: ['PENDING', 'IN_PROGRESS'],
      IN_PROGRESS: ['ACCEPTED', 'READY'],
      READY: ['IN_PROGRESS'],
    };
    if (!allowedNextStages[currentStage]?.includes(productionStatus)) {
      throw requestError('สถานะห้องครัวต้องดำเนินการตามลำดับ รอรับงาน → รับออเดอร์ → กำลังทำ → เสร็จสิ้น', 409);
    }
    const items = await client.query(
      `UPDATE order_items SET production_status = $1::varchar,
         production_accepted_at = CASE
           WHEN $1::varchar = 'PENDING' THEN NULL
           WHEN $1::varchar = 'ACCEPTED' THEN CURRENT_TIMESTAMP
           ELSE COALESCE(production_accepted_at, CURRENT_TIMESTAMP)
         END,
         production_started_at = CASE
           WHEN $1::varchar IN ('PENDING', 'ACCEPTED') THEN NULL
           WHEN $1::varchar = 'IN_PROGRESS' THEN CURRENT_TIMESTAMP
           ELSE COALESCE(production_started_at, CURRENT_TIMESTAMP)
         END,
         production_completed_at = CASE WHEN $1::varchar = 'READY' THEN CURRENT_TIMESTAMP ELSE NULL END
       WHERE order_id = $2 AND production_station = $3
       RETURNING id, production_accepted_at, production_started_at, production_completed_at`,
      [productionStatus, orderId, station]
    );
    const outstanding = await client.query(`SELECT COUNT(*)::int AS count FROM order_items WHERE order_id = $1 AND production_status <> 'READY'`, [orderId]);
    const orderStatus = Number(outstanding.rows[0]?.count || 0) === 0 ? 'READY' : 'COOKING';
    await client.query(`UPDATE orders SET status = $1 WHERE id = $2`, [orderStatus, orderId]);
    await client.query('COMMIT');
    io.to('operations').emit('order_status_updated', {
      orderId,
      status: orderStatus,
      productionStation: station,
      productionStatus,
    });
    res.json({ success: true, data: { order_id: orderId, production_station: station, production_status: productionStatus, order_status: orderStatus, ...items.rows[0] } });
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      console.error('Kitchen transaction rollback failed:', rollbackError);
    }
    const errorCode = error.code || 'KITCHEN_UPDATE_FAILED';
    console.error('Kitchen station update failed:', {
      orderId,
      station,
      productionStatus,
      code: errorCode,
      constraint: error.constraint,
      detail: error.detail,
      message: error.message,
    });
    res.status(error.statusCode || 500).json({ success: false, code: errorCode, error: error.message || 'ไม่สามารถอัปเดตสถานะห้องครัวได้' });
  } finally { client.release(); }
});

app.put('/api/orders/:id/status', requireAuth, requireRoles('ADMIN', 'STAFF'), requirePermission('orders', 'update'), async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  const allowedStatuses = new Set(['COOKING', 'READY', 'COMPLETED']);

  if (!allowedStatuses.has(status)) {
    return res.status(400).json({ success: false, error: 'สถานะออเดอร์ไม่ถูกต้อง' });
  }

  try {
    const current = await pool.query(
      `SELECT DATE(created_at AT TIME ZONE 'Asia/Bangkok')::text AS business_date
       FROM orders WHERE id = $1`,
      [id]
    );
    if (!current.rows.length) {
      return res.status(404).json({ success: false, error: 'Order not found' });
    }
    await assertBusinessDateOpen(pool, current.rows[0].business_date);
    if (status === 'READY' || status === 'COMPLETED') {
      const readiness = await pool.query(
        `SELECT o.status, COUNT(oi.id) FILTER (WHERE oi.production_status <> 'READY')::int AS pending_station_items
         FROM orders o LEFT JOIN order_items oi ON oi.order_id = o.id
         WHERE o.id = $1 GROUP BY o.id`,
        [id]
      );
      const order = readiness.rows[0];
      const isReadyForDelivery = order?.status === 'READY' && Number(order.pending_station_items || 0) === 0;
      const isReadyForPickup = Number(order?.pending_station_items || 0) === 0;
      if ((status === 'READY' && !isReadyForPickup) || (status === 'COMPLETED' && !isReadyForDelivery)) {
        return res.status(409).json({ success: false, error: status === 'READY' ? 'ครัวยังยืนยันการผลิตไม่ครบ จึงยังตั้งเป็นพร้อมรับสินค้าไม่ได้' : 'ครัวยังยืนยันการผลิตไม่ครบ จึงยังส่งมอบออเดอร์ไม่ได้' });
      }
    }
    const result = await pool.query(
      `UPDATE orders SET status = $1 WHERE id = $2 RETURNING *`,
      [status, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Order not found' });
    }

    const updatedOrder = result.rows[0];

    // ยิง Real-time Event แจ้งเปลี่ยนสถานะ (ไรเดอร์เสมือนขี่รถมารับของ)
    io.to('operations').emit('order_status_updated', {
      orderId: updatedOrder.id,
      orderNo: updatedOrder.order_no,
      status: updatedOrder.status
    });

    res.json({ success: true, data: updatedOrder });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});

// ----------------------------------------------------
// START SERVER
// ----------------------------------------------------
// Server is started after successful DB connection in startServer()
