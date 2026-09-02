require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');
const pool = require('../config/db');
const { hashPassword, verifyPassword, needsPasswordUpgrade, createToken, verifyToken, requireAuth, requireRoles } = require('../middleware/auth');

const app = express();
const server = http.createServer(app);
const ordersRouter = require('../router/orders');
const inventoryRouter = require('../router/inventory');
const productsRouter = require('../router/products');
const purchaseOrdersRouter = require('../router/purchaseOrders');
const { addInventoryLot, consumeLots, restoreOrderLots } = require('../utils/inventoryLots');

const isValidRecordDate = (value) => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};

const selectedRecordDate = (value) => isValidRecordDate(value) ? value : null;
const normalizePhone = (value) => String(value || '').replace(/\D/g, '');
const isValidPhone = (value) => /^\d{9,15}$/.test(value);
const publicUser = (user) => ({ id: Number(user.id), username: user.username, name: user.full_name, phone: user.phone || '', role: String(user.role).toLowerCase() });
const normalizeCouponCode = (value) => String(value || '').trim().toUpperCase().replace(/\s+/g, '');
const requestError = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const paymentMethods = new Set(['CASH', 'QR', 'TRANSFER', 'CARD', 'OTHER']);
const normalizePaymentMethod = (value) => {
  const method = String(value || 'OTHER').trim().toUpperCase();
  if (!paymentMethods.has(method)) throw requestError('Payment method is invalid');
  return method;
};
const couponDiscountFor = (coupon, amount) => {
  const base = Math.max(0, Number(amount) || 0);
  const value = Math.max(0, Number(coupon.discount_value) || 0);
  const rawDiscount = coupon.discount_type === 'PERCENT' ? base * Math.min(value, 100) / 100 : value;
  const maxDiscount = Number(coupon.max_discount_amount || 0);
  return Math.min(base, maxDiscount > 0 ? Math.min(rawDiscount, maxDiscount) : rawDiscount);
};
const validateCouponForAmount = (coupon, amount) => {
  if (!coupon || !coupon.is_active) throw requestError('Coupon is not available');
  if (coupon.valid_from && new Date(coupon.valid_from) > new Date()) throw requestError('Coupon has not started yet');
  if (coupon.valid_until && new Date(coupon.valid_until) < new Date()) throw requestError('Coupon has expired');
  if (coupon.usage_limit !== null && Number(coupon.used_count) >= Number(coupon.usage_limit)) throw requestError('Coupon usage limit has been reached');
  if (Number(amount) < Number(coupon.min_order_amount || 0)) throw requestError(`Coupon requires a minimum order of ${Number(coupon.min_order_amount).toFixed(2)}`);
  return couponDiscountFor(coupon, amount);
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
    await client.query('ALTER TABLE IF EXISTS orders ADD COLUMN IF NOT EXISTS user_id BIGINT REFERENCES users(id)');
    await client.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS phone VARCHAR(20)');
    await client.query('CREATE UNIQUE INDEX IF NOT EXISTS users_phone_unique ON users(phone) WHERE phone IS NOT NULL');
    await client.query('ALTER TABLE IF EXISTS orders ADD COLUMN IF NOT EXISTS customer_name VARCHAR(120)');
    await client.query('ALTER TABLE IF EXISTS orders ADD COLUMN IF NOT EXISTS customer_nickname VARCHAR(80)');
    await client.query('ALTER TABLE IF EXISTS orders ADD COLUMN IF NOT EXISTS customer_phone VARCHAR(20)');
    await client.query('ALTER TABLE IF EXISTS orders ADD COLUMN IF NOT EXISTS queue_no INTEGER');
    await client.query('ALTER TABLE IF EXISTS products ADD COLUMN IF NOT EXISTS is_sold_out BOOLEAN NOT NULL DEFAULT FALSE');
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
        status VARCHAR(12) NOT NULL DEFAULT 'PAID' CHECK (status IN ('PAID', 'VOIDED')),
        paid_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS cash_shifts_one_open_per_user_idx
      ON cash_shifts(opened_by) WHERE status = 'OPEN'
    `);
    await client.query('CREATE INDEX IF NOT EXISTS order_payments_cash_shift_idx ON order_payments(cash_shift_id, status)');
    await client.query('CREATE INDEX IF NOT EXISTS orders_customer_phone_created_at_idx ON orders(customer_phone, created_at DESC)');
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
app.use(cors({ origin: '*' }));
app.use(express.json());

// Disable caching for API responses to avoid 304 Not Modified in clients
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.set('Surrogate-Control', 'no-store');
  next();
});

const authConfigured = (res) => {
  if (process.env.AUTH_SECRET) return true;
  res.status(503).json({ success: false, error: 'Authentication is not configured' });
  return false;
};

app.post('/api/auth/register', async (req, res) => {
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
       VALUES ($1, $2, $3, 'USER', $4) RETURNING id, username, full_name, phone, role`,
      [username, fullName, hashPassword(password), phone]
    );
    const user = result.rows[0];
    res.status(201).json({ success: true, data: { user: publicUser(user), token: createToken(user) } });
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ success: false, error: 'Username or phone is already in use' });
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  if (!authConfigured(res)) return;
  const username = String(req.body?.username || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  try {
    const result = await pool.query('SELECT id, username, full_name, phone, password_hash, role FROM users WHERE username = $1', [username]);
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

app.get('/api/auth/me', requireAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT id, username, full_name, phone, role FROM users WHERE id = $1', [req.user.sub]);
    if (!result.rows.length) return res.status(401).json({ success: false, error: 'Session is no longer valid' });
    res.json({ success: true, data: publicUser(result.rows[0]) });
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

app.post('/api/coupons/validate', requireAuth, requireRoles('ADMIN', 'STAFF'), async (req, res) => {
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

app.get('/api/coupons', requireAuth, requireRoles('ADMIN'), async (req, res) => {
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

app.post('/api/coupons', requireAuth, requireRoles('ADMIN'), async (req, res) => {
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

// Register routers after middleware
app.use('/api/inventory', requireAuth, requireRoles('ADMIN'), inventoryRouter);
app.use('/api/purchase-orders', requireAuth, requireRoles('ADMIN'), purchaseOrdersRouter);
app.use('/api/orders', requireAuth, ordersRouter);
app.use('/api/products', requireAuth, requireRoles('ADMIN', 'STAFF'), productsRouter);

const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE']
  }
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

// Dashboard สาธารณะ: แสดงออเดอร์ล่าสุดทั้งหมด หรือกรองด้วยเบอร์โทรได้
app.post('/api/public/orders/lookup', async (req, res) => {
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
       GROUP BY o.id, c.name
       ORDER BY o.created_at DESC
       LIMIT 50`,
      [phone || null]
    );
    res.json({ success: true, data: result.rows });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 📌 Health Check Endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date() });
});

// 📌 GET /api/channels - ดึงรายชื่อช่องทางขาย (% GP)
app.get('/api/channels', requireAuth, requireRoles('ADMIN', 'STAFF'), async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM channels ORDER BY id ASC');
    res.json({ success: true, data: result.rows });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

const shiftWithCashSales = `
  SELECT cs.*, COALESCE(SUM(op.paid_amount) FILTER (
    WHERE op.payment_method = 'CASH' AND op.status = 'PAID'
  ), 0) AS cash_sales
  FROM cash_shifts cs
  LEFT JOIN order_payments op ON op.cash_shift_id = cs.id
`;

app.get('/api/shifts/current', requireAuth, requireRoles('ADMIN', 'STAFF'), async (req, res) => {
  try {
    const result = await pool.query(
      `${shiftWithCashSales}
       WHERE cs.opened_by = $1 AND cs.status = 'OPEN'
       GROUP BY cs.id
       ORDER BY cs.opened_at DESC
       LIMIT 1`,
      [req.user.sub]
    );
    res.json({ success: true, data: result.rows[0] || null });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/shifts', requireAuth, requireRoles('ADMIN'), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT cs.*, opened_user.full_name AS opened_by_name, COALESCE(SUM(op.paid_amount) FILTER (
        WHERE op.payment_method = 'CASH' AND op.status = 'PAID'
      ), 0) AS cash_sales
       FROM cash_shifts cs
       LEFT JOIN order_payments op ON op.cash_shift_id = cs.id
       LEFT JOIN users opened_user ON opened_user.id = cs.opened_by
       WHERE cs.status IN ('OPEN', 'CLOSED')
       GROUP BY cs.id, opened_user.full_name
       ORDER BY cs.opened_at DESC
       LIMIT 50`
    );
    res.json({ success: true, data: result.rows });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/shifts/open', requireAuth, requireRoles('ADMIN', 'STAFF'), async (req, res) => {
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

app.post('/api/shifts/:id/close', requireAuth, requireRoles('ADMIN', 'STAFF'), async (req, res) => {
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
      `SELECT COALESCE(SUM(paid_amount), 0) AS cash_sales
       FROM order_payments
       WHERE cash_shift_id = $1 AND payment_method = 'CASH' AND status = 'PAID'`,
      [shift.id]
    );
    const cashSales = Number(cashResult.rows[0].cash_sales || 0);
    const expectedCash = Number(shift.opening_cash || 0) + cashSales;
    const differenceAmount = closingCash - expectedCash;
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
app.get('/api/orders', requireAuth, async (req, res) => {
  const isUser = req.user.role === 'USER';
  const userId = isUser ? req.user.sub : null;
  const limitClause = isUser ? '' : 'LIMIT 100';
  try {
    const result = await pool.query(
      `SELECT o.id, o.order_no, o.queue_no, o.customer_name, o.customer_nickname, o.customer_phone, o.channel_id, c.name AS channel_name, o.status,
              o.subtotal_amount, o.discount_amount, o.manual_discount_amount, o.coupon_discount_amount,
              o.coupon_code, o.coupon_id, o.gross_amount, o.gp_amount, o.total_cogs, o.net_revenue, o.net_profit, o.created_at,
              COALESCE((
                SELECT JSON_BUILD_OBJECT(
                  'payment_method', op.payment_method,
                  'paid_amount', op.paid_amount,
                  'amount_received', op.amount_received,
                  'change_amount', op.change_amount,
                  'status', op.status,
                  'paid_at', op.paid_at
                )
                FROM order_payments op
                WHERE op.order_id = o.id
                LIMIT 1
              ), 'null'::json) AS payment,
              COALESCE(
                JSON_AGG(JSON_BUILD_OBJECT(
                  'product_id', oi.product_id,
                  'name', p.name,
                  'quantity', oi.quantity,
                  'unit_price', oi.unit_price,
                  'subtotal', oi.subtotal,
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
app.get('/api/financial-summary', requireAuth, requireRoles('ADMIN'), async (req, res) => {
  const recordDate = selectedRecordDate(req.query?.date);
  try {
    const query = `
      SELECT 
        COALESCE(SUM(gross_amount), 0) AS total_gross,
        COALESCE(SUM(gp_amount), 0) AS total_gp,
        COALESCE(SUM(net_revenue), 0) AS total_net_revenue,
        COALESCE(SUM(total_cogs), 0) AS total_cogs,
        COALESCE(SUM(net_profit), 0) AS total_net_profit,
        COUNT(id) AS total_orders,
        (SELECT COALESCE(SUM(amount), 0) FROM expenses
         WHERE DATE(created_at AT TIME ZONE 'Asia/Bangkok') = COALESCE($1::date, (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Bangkok')::date)) AS total_expenses
      FROM orders
      WHERE DATE(created_at AT TIME ZONE 'Asia/Bangkok') = COALESCE($1::date, (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Bangkok')::date);
    `;
    const result = await pool.query(query, [recordDate]);
    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/expenses - บันทึกค่าใช้จ่ายประจำวัน
app.post('/api/expenses', requireAuth, requireRoles('ADMIN'), async (req, res) => {
  const amount = Number(req.body?.amount);
  const category = String(req.body?.category || 'OPERATING_EXPENSE').trim();
  const description = String(req.body?.description || '').trim();
  const recordDate = selectedRecordDate(req.body?.record_date);

  if (!Number.isFinite(amount) || amount <= 0 || !category) {
    return res.status(400).json({ success: false, error: 'Invalid expense payload' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO expenses (amount, category, description, created_at)
       VALUES ($1, $2, $3, COALESCE($4::date::timestamp AT TIME ZONE 'Asia/Bangkok', CURRENT_TIMESTAMP))
       RETURNING *`,
      [amount, category, description, recordDate]
    );
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/expenses - รายการค่าใช้จ่ายทั้งหมด
app.get('/api/expenses', requireAuth, requireRoles('ADMIN'), async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM expenses ORDER BY created_at DESC');
    res.json({ success: true, data: result.rows });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// PUT /api/expenses/:id - แก้ไขรายการค่าใช้จ่าย
app.put('/api/expenses/:id', requireAuth, requireRoles('ADMIN'), async (req, res) => {
  const amount = Number(req.body?.amount);
  const category = String(req.body?.category || '').trim();
  const description = String(req.body?.description || '').trim();
  const recordDate = selectedRecordDate(req.body?.record_date);
  if (!Number.isFinite(amount) || amount <= 0 || !category) {
    return res.status(400).json({ success: false, error: 'Invalid expense payload' });
  }
  try {
    const result = await pool.query(
      `UPDATE expenses
       SET amount = $1, category = $2, description = $3,
           created_at = COALESCE($4::date::timestamp AT TIME ZONE 'Asia/Bangkok', created_at)
       WHERE id = $5 RETURNING *`,
      [amount, category, description, recordDate, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ success: false, error: 'Expense not found' });
    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// DELETE /api/expenses/:id - ลบรายการค่าใช้จ่าย
app.delete('/api/expenses/:id', requireAuth, requireRoles('ADMIN'), async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM expenses WHERE id = $1 RETURNING id', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ success: false, error: 'Expense not found' });
    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 📌 POST /api/orders - รับออเดอร์ใหม่ (ตัดสต็อคตามสูตร BOM, หัก GP และยิง Socket.io)
app.post('/api/orders', requireAuth, requireRoles('ADMIN', 'STAFF'), async (req, res) => {
  const { order_no, channel_id, items } = req.body;
  const recordDate = selectedRecordDate(req.body?.record_date);
  const customerName = String(req.body?.customer_name || req.body?.customer_nickname || '').trim().slice(0, 120);
  const customerNickname = String(req.body?.customer_nickname || customerName).trim().slice(0, 80);
  const customerPhone = normalizePhone(req.body?.customer_phone);
  const requestedManualDiscount = Math.max(
    0,
    Number(req.body?.manual_discount_amount ?? req.body?.discount_amount) || 0
  );
  const requestedCouponCode = normalizeCouponCode(req.body?.coupon_code);
  let paymentMethod;
  try {
    paymentMethod = normalizePaymentMethod(req.body?.payment_method);
  } catch (error) {
    return res.status(error.statusCode || 400).json({ success: false, error: error.message });
  }
  const requestedAmountReceived = req.body?.amount_received;
  // ตัวอย่าง items: [ { product_id: 1, qty: 2, price: 50.00 } ]

  if (!order_no || !channel_id || !items || !items.length) {
    return res.status(400).json({ success: false, error: 'Missing required order data' });
  }
  if (customerPhone && !isValidPhone(customerPhone)) {
    return res.status(400).json({ success: false, error: 'Customer phone number is invalid' });
  }

  const client = await pool.connect();

  try {
    // เริ่มต้น Database Transaction
    await client.query('BEGIN');

    // 1. ดึงข้อมูลช่องทางขาย (% GP)
    const channelRes = await client.query('SELECT name, gp_percent FROM channels WHERE id = $1', [channel_id]);
    if (channelRes.rows.length === 0) {
      throw requestError('Invalid channel_id');
    }
    const channelName = channelRes.rows[0].name;
    const gpPercent = parseFloat(channelRes.rows[0].gp_percent);
    // Serialize queue allocation so that two orders created together cannot receive the same queue.
    await client.query('SELECT pg_advisory_xact_lock(910246)');
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

    // 2. สร้าง Order เริ่มต้น
    const orderRes = await client.query(
      `INSERT INTO orders (order_no, channel_id, gross_amount, net_revenue, status, created_at, customer_name, customer_nickname, customer_phone, queue_no)
       VALUES ($1, $2, 0, 0, 'COOKING', COALESCE($3::date::timestamp AT TIME ZONE 'Asia/Bangkok', CURRENT_TIMESTAMP), $4, $5, $6, $7)
       RETURNING id`,
      [order_no, channel_id, recordDate, customerName || null, customerNickname || null, customerPhone || null, queueNo]
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
        'SELECT id, name, is_sold_out FROM products WHERE id = $1 FOR KEY SHARE',
        [item.product_id]
      );
      const product = productResult.rows[0];
      if (!product) throw requestError('Product not found', 404);
      if (product.is_sold_out) throw requestError(`${product.name} is temporarily unavailable`, 409);
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
        `INSERT INTO order_items (order_id, product_id, quantity, unit_price, subtotal)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [orderId, item.product_id, quantity, finalUnitPrice, subtotal]
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
      couponDiscountAmount = validateCouponForAmount(coupon, couponBaseAmount);
      couponId = coupon.id;
      couponCode = coupon.code;
      await client.query('UPDATE coupons SET used_count = used_count + 1 WHERE id = $1', [couponId]);
    }

    const discountAmount = manualDiscountAmount + couponDiscountAmount;
    const grossAmount = Math.max(0, subtotalAmount - discountAmount);

    const paidAmount = grossAmount;
    let amountReceived = paidAmount;
    let changeAmount = 0;
    let cashShiftId = null;
    if (paymentMethod === 'CASH') {
      amountReceived = requestedAmountReceived === undefined || requestedAmountReceived === null || requestedAmountReceived === ''
        ? paidAmount
        : Number(requestedAmountReceived);
      if (!Number.isFinite(amountReceived) || amountReceived < paidAmount) {
        throw requestError('Cash received must cover the order total');
      }
      changeAmount = amountReceived - paidAmount;
      if (paidAmount > 0) {
        const activeShift = await client.query(
          `SELECT id FROM cash_shifts
           WHERE opened_by = $1 AND status = 'OPEN'
           FOR UPDATE`,
          [req.user.sub]
        );
        if (!activeShift.rows.length) {
          throw requestError('Open a cash shift before accepting a cash payment', 409);
        }
        cashShiftId = activeShift.rows[0].id;
      }
    }

    // 4. คำนวณ GP, รายรับสุทธิ, และกำไรสุทธิจากยอดหลังหักส่วนลด
    const gpAmount = grossAmount * (gpPercent / 100);
    const netRevenue = grossAmount - gpAmount;
    const netProfit = netRevenue - totalCogs;

    // 5. อัปเดตข้อมูลสรุปกลับลงในออเดอร์
    const updatedOrderRes = await client.query(
      `UPDATE orders
       SET subtotal_amount = $1, manual_discount_amount = $2, coupon_discount_amount = $3,
           discount_amount = $4, coupon_code = $5, coupon_id = $6,
           gross_amount = $7, gp_amount = $8, net_revenue = $9, total_cogs = $10, net_profit = $11
       WHERE id = $12 RETURNING *`,
      [
        subtotalAmount,
        manualDiscountAmount,
        couponDiscountAmount,
        discountAmount,
        couponCode,
        couponId,
        grossAmount,
        gpAmount,
        netRevenue,
        totalCogs,
        netProfit,
        orderId,
      ]
    );

    await client.query(
      `INSERT INTO order_payments
       (order_id, cash_shift_id, paid_by, payment_method, paid_amount, amount_received, change_amount)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [orderId, cashShiftId, req.user.sub, paymentMethod, paidAmount, amountReceived, changeAmount]
    );

    // ยืนยันการทำ Transaction ลง Database
    await client.query('COMMIT');

    const createdOrder = updatedOrderRes.rows[0];

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
app.put('/api/orders/:id', requireAuth, requireRoles('ADMIN', 'STAFF'), async (req, res) => {
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
      'SELECT id, status, manual_discount_amount, coupon_discount_amount FROM orders WHERE id = $1 FOR UPDATE',
      [id]
    );
    if (!orderResult.rows.length) throw new Error('Order not found');
    if (orderResult.rows[0].status === 'CANCELLED') throw new Error('Cancelled sales records cannot be edited');

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
           amount_received = CASE WHEN payment_method = 'CASH' THEN GREATEST(amount_received, $1) ELSE $1 END,
           change_amount = CASE WHEN payment_method = 'CASH' THEN GREATEST(amount_received, $1) - $1 ELSE 0 END
       WHERE order_id = $2 AND status = 'PAID'`,
      [grossAmount, id]
    );
    await client.query('COMMIT');
    io.to('operations').emit('order_updated', { order: updated.rows[0] });
    res.json({ success: true, data: updated.rows[0] });
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(error.message === 'Order not found' ? 404 : 400).json({ success: false, error: error.message });
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
    const orderResult = await client.query('SELECT id, status FROM orders WHERE id = $1 FOR UPDATE', [id]);
    if (!orderResult.rows.length) throw new Error('Order not found');
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
    }
    await client.query('DELETE FROM order_items WHERE order_id = $1', [id]);
    await client.query('DELETE FROM orders WHERE id = $1', [id]);
    await client.query('COMMIT');
    io.emit('order_deleted', { orderId: Number(id) });
    res.json({ success: true, data: { id: Number(id) } });
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(error.message === 'Order not found' ? 404 : 400).json({ success: false, error: error.message });
  } finally {
    client.release();
  }
});

// 📌 PUT /api/orders/:id/status - อัปเดตสถานะออเดอร์ (COOKING -> READY -> COMPLETED)
app.put('/api/orders/:id/status', requireAuth, requireRoles('ADMIN', 'STAFF'), async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  const allowedStatuses = new Set(['COOKING', 'READY', 'COMPLETED']);

  if (!allowedStatuses.has(status)) {
    return res.status(400).json({ success: false, error: 'สถานะออเดอร์ไม่ถูกต้อง' });
  }

  try {
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
    res.status(500).json({ success: false, error: error.message });
  }
});

// ----------------------------------------------------
// START SERVER
// ----------------------------------------------------
// Server is started after successful DB connection in startServer()
