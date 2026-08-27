const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { requireRoles } = require('../middleware/auth');

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

router.use(requireRoles('ADMIN'));

// 📌 POST /api/products - เพิ่มสินค้าใหม่
router.post('/', async (req, res) => {
  const { name, category, price_retail, price_wholesale, recipe = [] } = req.body;
  if (!name || !Number.isFinite(Number(price_retail)) || !Array.isArray(recipe) || recipe.length === 0 || recipe.some((item) => !item.ingredient_id || !Number.isFinite(Number(item.quantity_used)) || Number(item.quantity_used) <= 0)) {
    return res.status(400).json({ success: false, error: 'Menu must include at least one valid ingredient recipe' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `INSERT INTO products (name, category, price_retail, price_wholesale)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [name, category, price_retail, price_wholesale || null]
    );
    for (const ingredient of recipe) {
      await client.query(
        'INSERT INTO recipes (product_id, ingredient_id, quantity_used) VALUES ($1, $2, $3)',
        [result.rows[0].id, ingredient.ingredient_id, Number(ingredient.quantity_used)]
      );
    }
    await client.query('COMMIT');
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(500).json({ success: false, error: error.message });
  } finally {
    client.release();
  }
});

// PUT /api/products/:id - แก้ไขเมนูและสูตรวัตถุดิบ
router.put('/:id', async (req, res) => {
  const { name, category, price_retail, price_wholesale, recipe = [] } = req.body;
  if (!name || !Number.isFinite(Number(price_retail)) || !Array.isArray(recipe) || recipe.length === 0 || recipe.some((item) => !item.ingredient_id || !Number.isFinite(Number(item.quantity_used)) || Number(item.quantity_used) <= 0)) {
    return res.status(400).json({ success: false, error: 'Menu must include at least one valid ingredient recipe' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `UPDATE products SET name = $1, category = $2, price_retail = $3, price_wholesale = $4
       WHERE id = $5 RETURNING *`,
      [name, category, price_retail, price_wholesale || null, req.params.id]
    );
    if (!result.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, error: 'Product not found' });
    }
    await client.query('DELETE FROM recipes WHERE product_id = $1', [req.params.id]);
    for (const ingredient of recipe) {
      await client.query(
        'INSERT INTO recipes (product_id, ingredient_id, quantity_used) VALUES ($1, $2, $3)',
        [req.params.id, ingredient.ingredient_id, Number(ingredient.quantity_used)]
      );
    }
    await client.query('COMMIT');
    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(500).json({ success: false, error: error.message });
  } finally {
    client.release();
  }
});

// DELETE /api/products/:id - ลบเมนูและสูตร
router.delete('/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM recipes WHERE product_id = $1', [req.params.id]);
    const result = await client.query('DELETE FROM products WHERE id = $1 RETURNING id', [req.params.id]);
    if (!result.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, error: 'Product not found' });
    }
    await client.query('COMMIT');
    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(500).json({ success: false, error: error.message });
  } finally {
    client.release();
  }
});

module.exports = router;
