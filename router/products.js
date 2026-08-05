const express = require('express');
const router = express.Router();
const pool = require('../config/db');

// 📌 GET /api/products - ดึงรายการสินค้าทั้งหมด พร้อมสูตรอาหาร (BOM)
router.get('/', async (req, res) => {
  try {
    const query = `
      SELECT p.*, 
        JSON_AGG(
          JSON_BUILD_OBJECT(
            'ingredient_id', i.id,
            'ingredient_name', i.name,
            'quantity_used', r.quantity_used,
            'unit', i.unit,
            'cost_per_unit', i.cost_per_unit
          )
        ) FILTER (WHERE i.id IS NOT NULL) AS recipe
      FROM products p
      LEFT JOIN recipes r ON p.id = r.product_id
      LEFT JOIN ingredients i ON r.ingredient_id = i.id
      GROUP BY p.id
      ORDER BY p.id ASC;
    `;
    const result = await pool.query(query);
    res.json({ success: true, data: result.rows });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 📌 POST /api/products - เพิ่มสินค้าใหม่
router.post('/', async (req, res) => {
  const { name, category, price_retail, price_wholesale } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO products (name, category, price_retail, price_wholesale)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [name, category, price_retail, price_wholesale || null]
    );
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;