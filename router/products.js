const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { requireRoles } = require('../middleware/auth');

const normalizeModifiers = (modifiers = []) => {
  if (!Array.isArray(modifiers)) throw new Error('Modifiers must be a list');
  return modifiers.map((group, groupIndex) => {
    const name = String(group?.name || '').trim().slice(0, 100);
    const minSelection = Number(group?.min_selection ?? 0);
    const maxSelection = Number(group?.max_selection ?? 1);
    const options = Array.isArray(group?.options) ? group.options : [];
    if (!name || !Number.isInteger(minSelection) || minSelection < 0 || !Number.isInteger(maxSelection) || maxSelection < 1 || minSelection > maxSelection || !options.length) {
      throw new Error('Modifier group data is invalid');
    }
    return {
      name,
      minSelection,
      maxSelection,
      displayOrder: groupIndex,
      options: options.map((option, optionIndex) => {
        const optionName = String(option?.name || '').trim().slice(0, 100);
        const priceAdjustment = Number(option?.price_adjustment ?? 0);
        if (!optionName || !Number.isFinite(priceAdjustment)) throw new Error('Modifier option data is invalid');
        return { name: optionName, priceAdjustment, displayOrder: optionIndex };
      })
    };
  });
};

const saveModifiers = async (client, productId, groups) => {
  for (const group of groups) {
    const groupResult = await client.query(
      `INSERT INTO product_modifier_groups (product_id, name, min_selection, max_selection, display_order)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [productId, group.name, group.minSelection, group.maxSelection, group.displayOrder]
    );
    for (const option of group.options) {
      await client.query(
        `INSERT INTO product_modifier_options (modifier_group_id, name, price_adjustment, display_order)
         VALUES ($1, $2, $3, $4)`,
        [groupResult.rows[0].id, option.name, option.priceAdjustment, option.displayOrder]
      );
    }
  }
};

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
        ) FILTER (WHERE i.id IS NOT NULL) AS recipe,
        COALESCE((
          SELECT JSON_AGG(
            JSON_BUILD_OBJECT(
              'id', mg.id,
              'name', mg.name,
              'min_selection', mg.min_selection,
              'max_selection', mg.max_selection,
              'display_order', mg.display_order,
              'options', COALESCE((
                SELECT JSON_AGG(
                  JSON_BUILD_OBJECT(
                    'id', mo.id,
                    'name', mo.name,
                    'price_adjustment', mo.price_adjustment,
                    'is_active', mo.is_active,
                    'display_order', mo.display_order
                  ) ORDER BY mo.display_order, mo.id
                )
                FROM product_modifier_options mo
                WHERE mo.modifier_group_id = mg.id
              ), '[]'::json)
            ) ORDER BY mg.display_order, mg.id
          )
          FROM product_modifier_groups mg
          WHERE mg.product_id = p.id
        ), '[]'::json) AS modifier_groups
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
  const { name, category, price_retail, price_wholesale, recipe = [], modifiers = [] } = req.body;
  if (!name || !Number.isFinite(Number(price_retail)) || !Array.isArray(recipe) || recipe.length === 0 || recipe.some((item) => !item.ingredient_id || !Number.isFinite(Number(item.quantity_used)) || Number(item.quantity_used) <= 0)) {
    return res.status(400).json({ success: false, error: 'Menu must include at least one valid ingredient recipe' });
  }
  let normalizedModifiers;
  try {
    normalizedModifiers = normalizeModifiers(modifiers);
  } catch (error) {
    return res.status(400).json({ success: false, error: error.message });
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
    await saveModifiers(client, result.rows[0].id, normalizedModifiers);
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
  const { name, category, price_retail, price_wholesale, recipe = [], modifiers = [] } = req.body;
  if (!name || !Number.isFinite(Number(price_retail)) || !Array.isArray(recipe) || recipe.length === 0 || recipe.some((item) => !item.ingredient_id || !Number.isFinite(Number(item.quantity_used)) || Number(item.quantity_used) <= 0)) {
    return res.status(400).json({ success: false, error: 'Menu must include at least one valid ingredient recipe' });
  }
  let normalizedModifiers;
  try {
    normalizedModifiers = normalizeModifiers(modifiers);
  } catch (error) {
    return res.status(400).json({ success: false, error: error.message });
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
    await client.query('DELETE FROM product_modifier_groups WHERE product_id = $1', [req.params.id]);
    for (const ingredient of recipe) {
      await client.query(
        'INSERT INTO recipes (product_id, ingredient_id, quantity_used) VALUES ($1, $2, $3)',
        [req.params.id, ingredient.ingredient_id, Number(ingredient.quantity_used)]
      );
    }
    await saveModifiers(client, req.params.id, normalizedModifiers);
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
