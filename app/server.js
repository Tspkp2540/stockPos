require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');
const pool = require('../config/db');

const app = express();
const server = http.createServer(app);
const ordersRouter = require('../router/orders');
const inventoryRouter = require('../router/inventory');
const productsRouter = require('../router/products');

const startServer = async () => {
  try {
    const client = await pool.connect();
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

// Register routers after middleware
app.use('/api/inventory', inventoryRouter);
app.use('/api/orders', ordersRouter);
app.use('/api/products', productsRouter);

const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE']
  }
});

// 2. จัดการการเชื่อมต่อ WebSockets (สำหรับ Real-time 3D Scene Updates)
io.on('connection', (socket) => {
  console.log(`🔌 Client Connected: ${socket.id}`);

  socket.on('disconnect', () => {
    console.log(`❌ Client Disconnected: ${socket.id}`);
  });
});

// ----------------------------------------------------
// API ROUTES
// ----------------------------------------------------

// 📌 Health Check Endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date() });
});

// 📌 GET /api/channels - ดึงรายชื่อช่องทางขาย (% GP)
app.get('/api/channels', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM channels ORDER BY id ASC');
    res.json({ success: true, data: result.rows });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 📌 GET /api/orders - ดึงรายการออเดอร์ล่าสุด
app.get('/api/orders', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, order_no, channel_id, status, gross_amount, net_revenue, created_at
       FROM orders
       ORDER BY created_at DESC
       LIMIT 100`
    );
    res.json({ success: true, data: result.rows });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 📌 GET /api/inventory - ดึงรายการวัตถุดิบ + ตรวจสอบสินค้าใกล้หมด/ใกล้หมดอายุ
app.get('/api/inventory', async (req, res) => {
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

// 📌 GET /api/financial-summary - ดึงยอดสรุปการเงินวันนี้ (Gross, GP, COGS, Net Profit)
app.get('/api/financial-summary', async (req, res) => {
  try {
    const query = `
      SELECT 
        COALESCE(SUM(gross_amount), 0) AS total_gross,
        COALESCE(SUM(gp_amount), 0) AS total_gp,
        COALESCE(SUM(net_revenue), 0) AS total_net_revenue,
        COALESCE(SUM(total_cogs), 0) AS total_cogs,
        COALESCE(SUM(net_profit), 0) AS total_net_profit,
        COUNT(id) AS total_orders
      FROM orders
      WHERE DATE(created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Bangkok') = CURRENT_DATE;
    `;
    const result = await pool.query(query);
    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 📌 POST /api/orders - รับออเดอร์ใหม่ (ตัดสต็อคตามสูตร BOM, หัก GP และยิง Socket.io)
app.post('/api/orders', async (req, res) => {
  const { order_no, channel_id, items } = req.body;
  // ตัวอย่าง items: [ { product_id: 1, qty: 2, price: 50.00 } ]

  if (!order_no || !channel_id || !items || !items.length) {
    return res.status(400).json({ success: false, error: 'Missing required order data' });
  }

  const client = await pool.connect();

  try {
    // เริ่มต้น Database Transaction
    await client.query('BEGIN');

    // 1. ดึงข้อมูลช่องทางขาย (% GP)
    const channelRes = await client.query('SELECT name, gp_percent FROM channels WHERE id = $1', [channel_id]);
    if (channelRes.rows.length === 0) {
      throw new Error('Invalid channel_id');
    }
    const channelName = channelRes.rows[0].name;
    const gpPercent = parseFloat(channelRes.rows[0].gp_percent);

    let grossAmount = 0;
    let totalCogs = 0;

    // 2. สร้าง Order เริ่มต้น
    const orderRes = await client.query(
      `INSERT INTO orders (order_no, channel_id, gross_amount, net_revenue, status)
       VALUES ($1, $2, 0, 0, 'COOKING') RETURNING id`,
      [order_no, channel_id]
    );
    const orderId = orderRes.rows[0].id;

    // 3. วนลูปประมวลผลสินค้าแต่ละรายการ
    for (const item of items) {
      const subtotal = item.qty * item.price;
      grossAmount += subtotal;

      // 3.1 บันทึกรายการลง order_items
      await client.query(
        `INSERT INTO order_items (order_id, product_id, quantity, unit_price, subtotal)
         VALUES ($1, $2, $3, $4, $5)`,
        [orderId, item.product_id, item.qty, item.price, subtotal]
      );

      // 3.2 ตัดสต็อควัตถุดิบตามสูตร (BOM - Bill of Materials)
      await client.query(
        `UPDATE ingredients ing
         SET stock_qty = ing.stock_qty - (r.quantity_used * $1),
             updated_at = CURRENT_TIMESTAMP
         FROM recipes r
         WHERE ing.id = r.ingredient_id AND r.product_id = $2`,
        [item.qty, item.product_id]
      );

      // 3.3 คำนวณต้นทุนวัตถุดิบ (COGS) ของรายการนี้
      const cogsRes = await client.query(
        `SELECT COALESCE(SUM(r.quantity_used * i.cost_per_unit * $1), 0) AS item_cogs
         FROM recipes r
         JOIN ingredients i ON r.ingredient_id = i.id
         WHERE r.product_id = $2`,
        [item.qty, item.product_id]
      );
      totalCogs += parseFloat(cogsRes.rows[0].item_cogs);
    }

    // 4. คำนวณ GP, รายรับสุทธิ, และกำไรสุทธิ
    const gpAmount = grossAmount * (gpPercent / 100);
    const netRevenue = grossAmount - gpAmount;
    const netProfit = netRevenue - totalCogs;

    // 5. อัปเดตข้อมูลสรุปกลับลงในออเดอร์
    const updatedOrderRes = await client.query(
      `UPDATE orders 
       SET gross_amount = $1, gp_amount = $2, net_revenue = $3, total_cogs = $4, net_profit = $5
       WHERE id = $6 RETURNING *`,
      [grossAmount, gpAmount, netRevenue, totalCogs, netProfit, orderId]
    );

    // ยืนยันการทำ Transaction ลง Database
    await client.query('COMMIT');

    const createdOrder = updatedOrderRes.rows[0];

    // 6. ส่ง Real-time Event ให้ทุก Client (หน้าเว็บ 3D / หน้า POS / หน้า Kitchen)
    io.emit('new_order_created', {
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
    res.status(500).json({ success: false, error: error.message });
  } finally {
    client.release();
  }
});

// 📌 PUT /api/orders/:id/status - อัปเดตสถานะออเดอร์ (เช่น COOKING -> COMPLETED)
app.put('/api/orders/:id/status', async (req, res) => {
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
    io.emit('order_status_updated', {
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