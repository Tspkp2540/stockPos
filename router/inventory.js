const express = require('express');
const router = express.Router();
const pool = require('../config/db');

// 📌 GET /api/inventory - ดึงรายการวัตถุดิบทั้งหมด
router.get('/', async (req, res) => {
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

// POST /api/inventory - เพิ่มวัตถุดิบใหม่
router.post('/', async (req, res) => {
  const { name, unit, stock_qty, cost_per_unit, min_stock_alert, expiry_date } = req.body;
  const stock = Number(stock_qty || 0);

  if (!name || !unit || !Number.isFinite(stock) || stock < 0) {
    return res.status(400).json({ success: false, error: 'Invalid inventory payload' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO ingredients (name, unit, stock_qty, cost_per_unit, min_stock_alert, expiry_date)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *,
       CASE WHEN stock_qty <= min_stock_alert THEN true ELSE false END AS is_low_stock`,
      [name, unit, stock, Number(cost_per_unit || 0), Number(min_stock_alert || 0), expiry_date || null]
    );
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 📌 POST /api/inventory/restock - เติมสต็อควัตถุดิบ
router.post('/restock', async (req, res) => {
  const { ingredient_id, qty_to_add, new_cost_per_unit } = req.body;

  if (!ingredient_id || !qty_to_add || qty_to_add <= 0) {
    return res.status(400).json({ success: false, error: 'Invalid payload' });
  }

  try {
    // อัปเดตสต็อค และปรับราคาต้นทุนใหม่ (ถ้ามีระบุ)
    const query = new_cost_per_unit
      ? `UPDATE ingredients 
         SET stock_qty = stock_qty + $1, cost_per_unit = $2, updated_at = CURRENT_TIMESTAMP 
         WHERE id = $3 RETURNING *`
      : `UPDATE ingredients 
         SET stock_qty = stock_qty + $1, updated_at = CURRENT_TIMESTAMP 
         WHERE id = $2 RETURNING *`;

    const values = new_cost_per_unit 
      ? [qty_to_add, new_cost_per_unit, ingredient_id] 
      : [qty_to_add, ingredient_id];

    const result = await pool.query(query, values);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Ingredient not found' });
    }

    res.json({
      success: true,
      message: 'Restocked successfully',
      data: result.rows[0]
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;