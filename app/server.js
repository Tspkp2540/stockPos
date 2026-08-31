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
    await client.query('CREATE INDEX IF NOT EXISTS orders_customer_phone_created_at_idx ON orders(customer_phone, created_at DESC)');
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
                  'quantity', oi.quantity
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
              COALESCE(
                JSON_AGG(JSON_BUILD_OBJECT(
                  'product_id', oi.product_id,
                  'name', p.name,
                  'quantity', oi.quantity,
                  'unit_price', oi.unit_price,
                  'subtotal', oi.subtotal
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
      const subtotal = quantity * unitPrice;
      subtotalAmount += subtotal;

      // 3.1 บันทึกรายการลง order_items
      await client.query(
        `INSERT INTO order_items (order_id, product_id, quantity, unit_price, subtotal)
         VALUES ($1, $2, $3, $4, $5)`,
        [orderId, item.product_id, quantity, unitPrice, subtotal]
      );

      // 3.2 ตัดสต็อควัตถุดิบตามสูตร (BOM - Bill of Materials)
      await client.query(
        `UPDATE ingredients ing
         SET stock_qty = ing.stock_qty - (r.quantity_used * $1),
             updated_at = CURRENT_TIMESTAMP
         FROM recipes r
         WHERE ing.id = r.ingredient_id AND r.product_id = $2`,
        [quantity, item.product_id]
      );

      // 3.3 คำนวณต้นทุนวัตถุดิบ (COGS) ของรายการนี้
      const cogsRes = await client.query(
        `SELECT COALESCE(SUM(r.quantity_used * i.cost_per_unit * $1), 0) AS item_cogs
         FROM recipes r
         JOIN ingredients i ON r.ingredient_id = i.id
         WHERE r.product_id = $2`,
        [quantity, item.product_id]
      );
      totalCogs += parseFloat(cogsRes.rows[0].item_cogs);
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

    // คืนสต็อกของ record เดิมก่อน แล้วจึงตรวจสอบและตัดตามรายการใหม่
    await client.query(
      `UPDATE ingredients ing
       SET stock_qty = ing.stock_qty + (r.quantity_used * oi.quantity), updated_at = CURRENT_TIMESTAMP
       FROM order_items oi
       JOIN recipes r ON r.product_id = oi.product_id
       WHERE oi.order_id = $1 AND ing.id = r.ingredient_id`,
      [id]
    );
    await client.query('DELETE FROM order_items WHERE order_id = $1', [id]);

    let subtotalAmount = 0;
    let totalCogs = 0;
    for (const item of normalizedItems) {
      const productResult = await client.query('SELECT id FROM products WHERE id = $1', [item.product_id]);
      if (!productResult.rows.length) throw new Error(`Product #${item.product_id} not found`);
      const recipeResult = await client.query(
        `SELECT r.ingredient_id, r.quantity_used, i.name, i.stock_qty, i.cost_per_unit
         FROM recipes r JOIN ingredients i ON i.id = r.ingredient_id
         WHERE r.product_id = $1 FOR UPDATE`,
        [item.product_id]
      );
      for (const recipeItem of recipeResult.rows) {
        const requiredQty = Number(recipeItem.quantity_used) * item.qty;
        if (Number(recipeItem.stock_qty) < requiredQty) throw new Error(`Insufficient stock for ${recipeItem.name}`);
        totalCogs += requiredQty * Number(recipeItem.cost_per_unit || 0);
      }
      const quantity = Number(item.qty);
      const unitPrice = Number(item.price);
      if (!Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(unitPrice) || unitPrice < 0) {
        throw requestError('Order item quantity and price are invalid');
      }
      const subtotal = quantity * unitPrice;
      subtotalAmount += subtotal;
      await client.query(
        'INSERT INTO order_items (order_id, product_id, quantity, unit_price, subtotal) VALUES ($1, $2, $3, $4, $5)',
        [id, item.product_id, quantity, unitPrice, subtotal]
      );
      await client.query(
        `UPDATE ingredients ing SET stock_qty = ing.stock_qty - (r.quantity_used * $1), updated_at = CURRENT_TIMESTAMP
         FROM recipes r WHERE ing.id = r.ingredient_id AND r.product_id = $2`,
        [quantity, item.product_id]
      );
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
      await client.query(
        `UPDATE ingredients ing
         SET stock_qty = ing.stock_qty + (r.quantity_used * oi.quantity), updated_at = CURRENT_TIMESTAMP
         FROM order_items oi
         JOIN recipes r ON r.product_id = oi.product_id
         WHERE oi.order_id = $1 AND ing.id = r.ingredient_id`,
        [id]
      );
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

// 📌 PUT /api/orders/:id/status - อัปเดตสถานะออเดอร์ (เช่น COOKING -> COMPLETED)
app.put('/api/orders/:id/status', requireAuth, requireRoles('ADMIN', 'STAFF'), async (req, res) => {
  const { id } = req.params;
  const { status } = req.body; // 'COOKING', 'COMPLETED', 'CANCELLED'

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
