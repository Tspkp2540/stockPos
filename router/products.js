const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { requireRoles } = require('../middleware/auth');
const configuredLowStockThreshold = Number(process.env.MENU_LOW_STOCK_THRESHOLD);
const menuLowStockThreshold = Number.isInteger(configuredLowStockThreshold) && configuredLowStockThreshold > 0
  ? configuredLowStockThreshold
  : 5;

const normalizeBarcode = (value) => {
  const barcode = String(value || '').trim().slice(0, 80);
  return barcode || null;
};

const normalizeChannelSettings = (settings) => {
  if (settings === undefined) return null;
  if (!Array.isArray(settings)) throw new Error('Channel settings must be a list');
  const seenChannels = new Set();
  return settings.map((setting) => {
    const channelId = Number(setting?.channel_id);
    if (!Number.isInteger(channelId) || channelId <= 0 || seenChannels.has(channelId)) {
      throw new Error('Channel setting data is invalid');
    }
    seenChannels.add(channelId);
    const rawPrice = setting?.price_retail;
    const priceRetail = rawPrice === '' || rawPrice === null || rawPrice === undefined
      ? null
      : Number(rawPrice);
    if (priceRetail !== null && (!Number.isFinite(priceRetail) || priceRetail < 0)) {
      throw new Error('Channel price is invalid');
    }
    return {
      channelId,
      isActive: setting?.is_active !== false,
      priceRetail,
    };
  });
};

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

const saveChannelSettings = async (client, productId, settings) => {
  if (settings === null) return;
  if (settings.length) {
    const result = await client.query(
      'SELECT id FROM channels WHERE id = ANY($1::bigint[])',
      [settings.map((setting) => setting.channelId)],
    );
    if (result.rows.length !== settings.length) throw new Error('ไม่พบช่องทางขายที่เลือก');
  }
  await client.query('DELETE FROM product_channel_settings WHERE product_id = $1', [productId]);
  for (const setting of settings) {
    await client.query(
      `INSERT INTO product_channel_settings (product_id, channel_id, is_active, price_retail)
       VALUES ($1, $2, $3, $4)`,
      [productId, setting.channelId, setting.isActive, setting.priceRetail],
    );
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
        ), '[]'::json) AS modifier_groups,
        COALESCE((
          SELECT JSON_AGG(
            JSON_BUILD_OBJECT(
              'channel_id', pcs.channel_id,
              'is_active', pcs.is_active,
              'price_retail', pcs.price_retail
            ) ORDER BY pcs.channel_id
          )
          FROM product_channel_settings pcs
          WHERE pcs.product_id = p.id
        ), '[]'::json) AS channel_settings,
        CASE
          WHEN p.is_sold_out THEN FALSE
          WHEN NOT EXISTS (SELECT 1 FROM recipes tracked_recipe WHERE tracked_recipe.product_id = p.id) THEN TRUE
          WHEN EXISTS (
            SELECT 1
            FROM recipes availability_recipe
            WHERE availability_recipe.product_id = p.id
              AND availability_recipe.quantity_used > COALESCE((
                SELECT SUM(inventory_lot.remaining_quantity)
                FROM inventory_lots inventory_lot
                WHERE inventory_lot.ingredient_id = availability_recipe.ingredient_id
                  AND inventory_lot.remaining_quantity > 0
                  AND (inventory_lot.expiry_date IS NULL OR inventory_lot.expiry_date >= CURRENT_DATE)
              ), 0)
          ) THEN FALSE
          ELSE TRUE
        END AS is_available,
        CASE
          WHEN p.is_sold_out THEN 'MANUALLY_SOLD_OUT'
          WHEN NOT EXISTS (SELECT 1 FROM recipes tracked_recipe WHERE tracked_recipe.product_id = p.id) THEN 'NOT_TRACKED'
          WHEN EXISTS (
            SELECT 1
            FROM recipes availability_recipe
            WHERE availability_recipe.product_id = p.id
              AND availability_recipe.quantity_used > COALESCE((
                SELECT SUM(inventory_lot.remaining_quantity)
                FROM inventory_lots inventory_lot
                WHERE inventory_lot.ingredient_id = availability_recipe.ingredient_id
                  AND inventory_lot.remaining_quantity > 0
                  AND (inventory_lot.expiry_date IS NULL OR inventory_lot.expiry_date >= CURRENT_DATE)
              ), 0)
          ) THEN 'INSUFFICIENT_STOCK'
          ELSE 'AVAILABLE'
        END AS availability_reason,
        (
          SELECT MIN(FLOOR(
            COALESCE((
              SELECT SUM(inventory_lot.remaining_quantity)
              FROM inventory_lots inventory_lot
              WHERE inventory_lot.ingredient_id = availability_recipe.ingredient_id
                AND inventory_lot.remaining_quantity > 0
                AND (inventory_lot.expiry_date IS NULL OR inventory_lot.expiry_date >= CURRENT_DATE)
            ), 0) / NULLIF(availability_recipe.quantity_used, 0)
          ))
          FROM recipes availability_recipe
          WHERE availability_recipe.product_id = p.id
        ) AS available_quantity
      FROM products p
      LEFT JOIN recipes r ON p.id = r.product_id
      LEFT JOIN ingredients i ON r.ingredient_id = i.id
      GROUP BY p.id
      ORDER BY p.id ASC;
    `;
    const result = await pool.query(query);
    const products = result.rows.map((product) => {
      const availableQuantity = Number(product.available_quantity);
      const isLowStock = product.is_available === true
        && product.availability_reason === 'AVAILABLE'
        && Number.isFinite(availableQuantity)
        && availableQuantity > 0
        && availableQuantity <= menuLowStockThreshold;
      return {
        ...product,
        low_stock_threshold: menuLowStockThreshold,
        is_low_stock: isLowStock,
      };
    });
    res.json({ success: true, data: products });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.use(requireRoles('ADMIN'));

// PATCH /api/products/:id/availability - ปิด/เปิดขายเมนูชั่วคราว
router.patch('/:id/availability', async (req, res) => {
  if (typeof req.body?.is_sold_out !== 'boolean') {
    return res.status(400).json({ success: false, error: 'is_sold_out must be true or false' });
  }
  try {
    const result = await pool.query(
      'UPDATE products SET is_sold_out = $1 WHERE id = $2 RETURNING *',
      [req.body.is_sold_out, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ success: false, error: 'Product not found' });
    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 📌 POST /api/products - เพิ่มสินค้าใหม่
router.post('/', async (req, res) => {
  const { name, category, barcode, price_retail, price_wholesale, counts_as_loyalty_cup, recipe = [], modifiers = [], channel_settings } = req.body;
  if (!name || !Number.isFinite(Number(price_retail)) || !Array.isArray(recipe) || recipe.length === 0 || recipe.some((item) => !item.ingredient_id || !Number.isFinite(Number(item.quantity_used)) || Number(item.quantity_used) <= 0)) {
    return res.status(400).json({ success: false, error: 'Menu must include at least one valid ingredient recipe' });
  }
  let normalizedModifiers;
  let normalizedChannelSettings;
  try {
    normalizedModifiers = normalizeModifiers(modifiers);
    normalizedChannelSettings = normalizeChannelSettings(channel_settings);
  } catch (error) {
    return res.status(400).json({ success: false, error: error.message });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `INSERT INTO products (name, category, barcode, price_retail, price_wholesale, counts_as_loyalty_cup)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [name, category, normalizeBarcode(barcode), price_retail, price_wholesale || null, counts_as_loyalty_cup === true]
    );
    for (const ingredient of recipe) {
      await client.query(
        'INSERT INTO recipes (product_id, ingredient_id, quantity_used) VALUES ($1, $2, $3)',
        [result.rows[0].id, ingredient.ingredient_id, Number(ingredient.quantity_used)]
      );
    }
    await saveModifiers(client, result.rows[0].id, normalizedModifiers);
    await saveChannelSettings(client, result.rows[0].id, normalizedChannelSettings);
    await client.query('COMMIT');
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (error) {
    await client.query('ROLLBACK');
    if (error.code === '23505') return res.status(409).json({ success: false, error: 'Barcode already exists' });
    res.status(500).json({ success: false, error: error.message });
  } finally {
    client.release();
  }
});

// PUT /api/products/:id - แก้ไขเมนูและสูตรวัตถุดิบ
router.put('/:id', async (req, res) => {
  const { name, category, barcode, price_retail, price_wholesale, counts_as_loyalty_cup, recipe = [], modifiers = [], channel_settings } = req.body;
  if (!name || !Number.isFinite(Number(price_retail)) || !Array.isArray(recipe) || recipe.length === 0 || recipe.some((item) => !item.ingredient_id || !Number.isFinite(Number(item.quantity_used)) || Number(item.quantity_used) <= 0)) {
    return res.status(400).json({ success: false, error: 'Menu must include at least one valid ingredient recipe' });
  }
  let normalizedModifiers;
  let normalizedChannelSettings;
  try {
    normalizedModifiers = normalizeModifiers(modifiers);
    normalizedChannelSettings = normalizeChannelSettings(channel_settings);
  } catch (error) {
    return res.status(400).json({ success: false, error: error.message });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query(
      'SELECT id, price_retail FROM products WHERE id = $1 FOR UPDATE',
      [req.params.id]
    );
    if (!existing.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, error: 'Product not found' });
    }
    req.auditSummary = {
      product_name: String(name).trim(),
      price_retail: Number(price_retail),
      price_changed: Math.abs(Number(existing.rows[0].price_retail || 0) - Number(price_retail)) > 0.000001,
    };
    const result = await client.query(
      `UPDATE products SET name = $1, category = $2, barcode = $3, price_retail = $4, price_wholesale = $5, counts_as_loyalty_cup = $6
       WHERE id = $7 RETURNING *`,
      [name, category, normalizeBarcode(barcode), price_retail, price_wholesale || null, counts_as_loyalty_cup === true, req.params.id]
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
    await saveChannelSettings(client, req.params.id, normalizedChannelSettings);
    await client.query('COMMIT');
    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    await client.query('ROLLBACK');
    if (error.code === '23505') return res.status(409).json({ success: false, error: 'Barcode already exists' });
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
