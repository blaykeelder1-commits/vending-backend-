const express = require('express');
const Joi = require('joi');
const { query } = require('../config/database');
const { protect, restrictTo } = require('../middleware/auth');
const { generateQRCodeData, generateQRCodeDataURL } = require('../services/qrCodeService');

const router = express.Router();

// Apply vendor authentication to all routes
router.use(protect);
router.use(restrictTo('vendor'));

// ========================================
// VENDING MACHINES ROUTES
// ========================================

/**
 * GET /api/vendor/machines
 * Get all vending machines for the authenticated vendor
 */
router.get('/machines', async (req, res) => {
  try {
    const result = await query(
      `SELECT id, machine_name, location, qr_code_data, qr_code_image_url,
              google_sheet_id, is_active, created_at, updated_at
       FROM vending_machines
       WHERE vendor_id = $1
       ORDER BY created_at DESC`,
      [req.user.id]
    );

    res.json({
      success: true,
      data: {
        machines: result.rows,
        count: result.rows.length,
      },
    });
  } catch (error) {
    console.error('Error fetching machines:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching vending machines',
    });
  }
});

/**
 * GET /api/vendor/machines/:id
 * Get a specific vending machine
 */
router.get('/machines/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const result = await query(
      `SELECT id, machine_name, location, qr_code_data, qr_code_image_url,
              google_sheet_id, is_active, created_at, updated_at
       FROM vending_machines
       WHERE id = $1 AND vendor_id = $2`,
      [id, req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Vending machine not found',
      });
    }

    res.json({
      success: true,
      data: { machine: result.rows[0] },
    });
  } catch (error) {
    console.error('Error fetching machine:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching vending machine',
    });
  }
});

/**
 * POST /api/vendor/machines
 * Create a new vending machine
 */
router.post('/machines', async (req, res) => {
  try {
    const schema = Joi.object({
      machineName: Joi.string().min(2).max(255).required(),
      location: Joi.string().max(500).required(),
      googleSheetId: Joi.string().max(255).optional(),
    });

    const { error, value } = schema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message,
      });
    }

    const { machineName, location, googleSheetId } = value;

    // First insert to get the machine ID
    const tempQR = await generateQRCodeData(0); // Temporary
    const result = await query(
      `INSERT INTO vending_machines
       (vendor_id, machine_name, location, qr_code_data, google_sheet_id, is_active)
       VALUES ($1, $2, $3, $4, $5, true)
       RETURNING id`,
      [req.user.id, machineName, location, tempQR.qrData, googleSheetId || null]
    );

    const machineId = result.rows[0].id;

    // Generate proper QR code with actual machine ID
    const qrCode = await generateQRCodeData(machineId);
    const qrImageUrl = await generateQRCodeDataURL(qrCode.qrData);

    // Update with correct QR code
    await query(
      `UPDATE vending_machines
       SET qr_code_data = $1, qr_code_image_url = $2
       WHERE id = $3`,
      [qrCode.qrData, qrImageUrl, machineId]
    );

    // Fetch the complete machine data
    const finalResult = await query(
      `SELECT id, machine_name, location, qr_code_data, qr_code_image_url,
              google_sheet_id, is_active, created_at, updated_at
       FROM vending_machines
       WHERE id = $1`,
      [machineId]
    );

    res.status(201).json({
      success: true,
      message: 'Vending machine created successfully',
      data: { machine: finalResult.rows[0] },
    });
  } catch (error) {
    console.error('Error creating machine:', error);
    res.status(500).json({
      success: false,
      message: 'Error creating vending machine',
    });
  }
});

/**
 * PUT /api/vendor/machines/:id
 * Update a vending machine
 */
router.put('/machines/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const schema = Joi.object({
      machineName: Joi.string().min(2).max(255).optional(),
      location: Joi.string().max(500).optional(),
      googleSheetId: Joi.string().max(255).allow('').optional(),
      isActive: Joi.boolean().optional(),
    });

    const { error, value } = schema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message,
      });
    }

    // Check machine exists and belongs to vendor
    const checkResult = await query(
      'SELECT id FROM vending_machines WHERE id = $1 AND vendor_id = $2',
      [id, req.user.id]
    );

    if (checkResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Vending machine not found',
      });
    }

    // Build update query dynamically
    const updates = [];
    const values = [];
    let paramCount = 1;

    if (value.machineName !== undefined) {
      updates.push(`machine_name = $${paramCount++}`);
      values.push(value.machineName);
    }
    if (value.location !== undefined) {
      updates.push(`location = $${paramCount++}`);
      values.push(value.location);
    }
    if (value.googleSheetId !== undefined) {
      updates.push(`google_sheet_id = $${paramCount++}`);
      values.push(value.googleSheetId || null);
    }
    if (value.isActive !== undefined) {
      updates.push(`is_active = $${paramCount++}`);
      values.push(value.isActive);
    }

    if (updates.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No fields to update',
      });
    }

    values.push(id);
    const updateQuery = `UPDATE vending_machines SET ${updates.join(', ')} WHERE id = $${paramCount} RETURNING *`;

    const result = await query(updateQuery, values);

    res.json({
      success: true,
      message: 'Vending machine updated successfully',
      data: { machine: result.rows[0] },
    });
  } catch (error) {
    console.error('Error updating machine:', error);
    res.status(500).json({
      success: false,
      message: 'Error updating vending machine',
    });
  }
});

/**
 * DELETE /api/vendor/machines/:id
 * Delete a vending machine
 */
router.delete('/machines/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const result = await query(
      'DELETE FROM vending_machines WHERE id = $1 AND vendor_id = $2 RETURNING id',
      [id, req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Vending machine not found',
      });
    }

    res.json({
      success: true,
      message: 'Vending machine deleted successfully',
    });
  } catch (error) {
    console.error('Error deleting machine:', error);
    res.status(500).json({
      success: false,
      message: 'Error deleting vending machine',
    });
  }
});

// ========================================
// PRODUCTS ROUTES
// ========================================

/**
 * GET /api/vendor/products
 * Get all products for the vendor
 */
router.get('/products', async (req, res) => {
  try {
    const result = await query(
      `SELECT id, product_name, description, price, image_url,
              is_active, created_at, updated_at
       FROM products
       WHERE vendor_id = $1
       ORDER BY product_name`,
      [req.user.id]
    );

    res.json({
      success: true,
      data: {
        products: result.rows,
        count: result.rows.length,
      },
    });
  } catch (error) {
    console.error('Error fetching products:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching products',
    });
  }
});

/**
 * GET /api/vendor/products/:id
 * Get a specific product
 */
router.get('/products/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const result = await query(
      `SELECT id, product_name, description, price, image_url,
              is_active, created_at, updated_at
       FROM products
       WHERE id = $1 AND vendor_id = $2`,
      [id, req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Product not found',
      });
    }

    res.json({
      success: true,
      data: { product: result.rows[0] },
    });
  } catch (error) {
    console.error('Error fetching product:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching product',
    });
  }
});

/**
 * POST /api/vendor/products
 * Create a new product
 */
router.post('/products', async (req, res) => {
  try {
    const schema = Joi.object({
      productName: Joi.string().min(2).max(255).required(),
      description: Joi.string().max(1000).optional(),
      price: Joi.number().min(0).precision(2).required(),
      imageUrl: Joi.string().uri().optional(),
      category: Joi.string().max(100).optional(),
    });

    const { error, value } = schema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message,
      });
    }

    const { productName, description, price, imageUrl, category } = value;

    const result = await query(
      `INSERT INTO products
       (vendor_id, product_name, description, price, image_url, is_active)
       VALUES ($1, $2, $3, $4, $5, true)
       RETURNING id, product_name, description, price, image_url, is_active, created_at, updated_at`,
      [req.user.id, productName, description || null, price, imageUrl || null]
    );

    res.status(201).json({
      success: true,
      message: 'Product created successfully',
      data: { product: result.rows[0] },
    });
  } catch (error) {
    console.error('Error creating product:', error);
    res.status(500).json({
      success: false,
      message: 'Error creating product',
    });
  }
});

/**
 * PUT /api/vendor/products/:id
 * Update a product
 */
router.put('/products/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const schema = Joi.object({
      productName: Joi.string().min(2).max(255).optional(),
      description: Joi.string().max(1000).allow('').optional(),
      price: Joi.number().min(0).precision(2).optional(),
      imageUrl: Joi.string().uri().allow('').optional(),
      category: Joi.string().max(100).allow('').optional(),
      isActive: Joi.boolean().optional(),
    });

    const { error, value } = schema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message,
      });
    }

    // Check product exists and belongs to vendor
    const checkResult = await query(
      'SELECT id FROM products WHERE id = $1 AND vendor_id = $2',
      [id, req.user.id]
    );

    if (checkResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Product not found',
      });
    }

    // Build update query dynamically
    const updates = [];
    const values = [];
    let paramCount = 1;

    if (value.productName !== undefined) {
      updates.push(`product_name = $${paramCount++}`);
      values.push(value.productName);
    }
    if (value.description !== undefined) {
      updates.push(`description = $${paramCount++}`);
      values.push(value.description || null);
    }
    if (value.price !== undefined) {
      updates.push(`price = $${paramCount++}`);
      values.push(value.price);
    }
    if (value.imageUrl !== undefined) {
      updates.push(`image_url = $${paramCount++}`);
      values.push(value.imageUrl || null);
    }
    if (value.isActive !== undefined) {
      updates.push(`is_active = $${paramCount++}`);
      values.push(value.isActive);
    }

    if (updates.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No fields to update',
      });
    }

    values.push(id);
    const updateQuery = `UPDATE products SET ${updates.join(', ')} WHERE id = $${paramCount} RETURNING *`;

    const result = await query(updateQuery, values);

    res.json({
      success: true,
      message: 'Product updated successfully',
      data: { product: result.rows[0] },
    });
  } catch (error) {
    console.error('Error updating product:', error);
    res.status(500).json({
      success: false,
      message: 'Error updating product',
    });
  }
});

/**
 * DELETE /api/vendor/products/:id
 * Delete a product
 */
router.delete('/products/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const result = await query(
      'DELETE FROM products WHERE id = $1 AND vendor_id = $2 RETURNING id',
      [id, req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Product not found',
      });
    }

    res.json({
      success: true,
      message: 'Product deleted successfully',
    });
  } catch (error) {
    console.error('Error deleting product:', error);
    res.status(500).json({
      success: false,
      message: 'Error deleting product',
    });
  }
});

// ========================================
// MACHINE INVENTORY (MACHINE PRODUCTS) ROUTES
// ========================================

/**
 * GET /api/vendor/machines/:machineId/inventory
 * Get all products for a specific machine
 */
router.get('/machines/:machineId/inventory', async (req, res) => {
  try {
    const { machineId } = req.params;

    // Verify machine belongs to vendor
    const machineCheck = await query(
      'SELECT id FROM vending_machines WHERE id = $1 AND vendor_id = $2',
      [machineId, req.user.id]
    );

    if (machineCheck.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Vending machine not found',
      });
    }

    const result = await query(
      `SELECT mp.id, mp.machine_id, mp.product_id, mp.current_stock,
              p.product_name, p.description, p.price, p.image_url
       FROM machine_products mp
       JOIN products p ON mp.product_id = p.id
       WHERE mp.machine_id = $1
       ORDER BY p.product_name`,
      [machineId]
    );

    res.json({
      success: true,
      data: {
        inventory: result.rows,
        count: result.rows.length,
      },
    });
  } catch (error) {
    console.error('Error fetching inventory:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching machine inventory',
    });
  }
});

/**
 * POST /api/vendor/machines/:machineId/inventory
 * Add a product to a machine's inventory
 */
router.post('/machines/:machineId/inventory', async (req, res) => {
  try {
    const { machineId } = req.params;
    const schema = Joi.object({
      productId: Joi.number().integer().required(),
      stockQuantity: Joi.number().integer().min(0).required(),
    });

    const { error, value } = schema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message,
      });
    }

    // Verify machine belongs to vendor
    const machineCheck = await query(
      'SELECT id FROM vending_machines WHERE id = $1 AND vendor_id = $2',
      [machineId, req.user.id]
    );

    if (machineCheck.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Vending machine not found',
      });
    }

    // Verify product belongs to vendor
    const productCheck = await query(
      'SELECT id FROM products WHERE id = $1 AND vendor_id = $2',
      [value.productId, req.user.id]
    );

    if (productCheck.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Product not found',
      });
    }

    const { productId, stockQuantity } = value;

    const result = await query(
      `INSERT INTO machine_products (machine_id, product_id, current_stock)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [machineId, productId, stockQuantity]
    );

    res.status(201).json({
      success: true,
      message: 'Product added to machine inventory',
      data: { inventoryItem: result.rows[0] },
    });
  } catch (error) {
    console.error('Error adding to inventory:', error);
    if (error.message && error.message.includes('unique')) {
      return res.status(409).json({
        success: false,
        message: 'Product already exists in this machine',
      });
    }
    res.status(500).json({
      success: false,
      message: 'Error adding product to inventory',
    });
  }
});

/**
 * PUT /api/vendor/machines/:machineId/inventory/:id
 * Update machine inventory item
 */
router.put('/machines/:machineId/inventory/:id', async (req, res) => {
  try {
    const { machineId, id } = req.params;
    const schema = Joi.object({
      stockQuantity: Joi.number().integer().min(0).optional(),
    });

    const { error, value } = schema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message,
      });
    }

    // Verify machine belongs to vendor
    const machineCheck = await query(
      'SELECT id FROM vending_machines WHERE id = $1 AND vendor_id = $2',
      [machineId, req.user.id]
    );

    if (machineCheck.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Vending machine not found',
      });
    }

    // Build update query
    const updates = [];
    const values = [];
    let paramCount = 1;

    if (value.stockQuantity !== undefined) {
      updates.push(`current_stock = $${paramCount++}`);
      values.push(value.stockQuantity);
    }

    if (updates.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No fields to update',
      });
    }

    values.push(id, machineId);
    const updateQuery = `UPDATE machine_products SET ${updates.join(', ')} WHERE id = $${paramCount} AND machine_id = $${paramCount + 1} RETURNING *`;

    const result = await query(updateQuery, values);

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Inventory item not found',
      });
    }

    res.json({
      success: true,
      message: 'Inventory updated successfully',
      data: { inventoryItem: result.rows[0] },
    });
  } catch (error) {
    console.error('Error updating inventory:', error);
    res.status(500).json({
      success: false,
      message: 'Error updating inventory',
    });
  }
});

/**
 * DELETE /api/vendor/machines/:machineId/inventory/:id
 * Remove a product from machine inventory
 */
router.delete('/machines/:machineId/inventory/:id', async (req, res) => {
  try {
    const { machineId, id } = req.params;

    // Verify machine belongs to vendor
    const machineCheck = await query(
      'SELECT id FROM vending_machines WHERE id = $1 AND vendor_id = $2',
      [machineId, req.user.id]
    );

    if (machineCheck.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Vending machine not found',
      });
    }

    const result = await query(
      'DELETE FROM machine_products WHERE id = $1 AND machine_id = $2 RETURNING id',
      [id, machineId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Inventory item not found',
      });
    }

    res.json({
      success: true,
      message: 'Product removed from inventory',
    });
  } catch (error) {
    console.error('Error removing from inventory:', error);
    res.status(500).json({
      success: false,
      message: 'Error removing product from inventory',
    });
  }
});

// ========================================
// DISCOUNT CODES ROUTES
// ========================================

/**
 * GET /api/vendor/machines/:machineId/discounts
 * Get all discount codes for a specific machine
 */
router.get('/machines/:machineId/discounts', async (req, res) => {
  try {
    const { machineId } = req.params;

    // Verify machine belongs to vendor
    const machineCheck = await query(
      'SELECT id FROM vending_machines WHERE id = $1 AND vendor_id = $2',
      [machineId, req.user.id]
    );

    if (machineCheck.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Vending machine not found',
      });
    }

    const result = await query(
      `SELECT dc.id, dc.machine_id, dc.product_id, dc.code, dc.discount_type,
              dc.discount_value, dc.max_uses, dc.current_uses, dc.valid_from,
              dc.valid_until, dc.is_active, dc.created_at,
              p.product_name, p.price
       FROM discount_codes dc
       LEFT JOIN products p ON dc.product_id = p.id
       WHERE dc.machine_id = $1 AND dc.vendor_id = $2
       ORDER BY dc.created_at DESC`,
      [machineId, req.user.id]
    );

    res.json({
      success: true,
      data: {
        discounts: result.rows,
        count: result.rows.length,
      },
    });
  } catch (error) {
    console.error('Error fetching discounts:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching discount codes',
    });
  }
});

/**
 * POST /api/vendor/machines/:machineId/discounts
 * Create a new discount code for a machine
 */
router.post('/machines/:machineId/discounts', async (req, res) => {
  try {
    const { machineId } = req.params;
    const schema = Joi.object({
      productId: Joi.number().integer().optional().allow(null),
      code: Joi.string().min(3).max(50).required(),
      percentOff: Joi.number().min(0).max(100).required(),
      startsAt: Joi.date().optional(),
      endsAt: Joi.date().optional(),
      maxUses: Joi.number().integer().min(1).optional().allow(null),
    });

    const { error, value } = schema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message,
      });
    }

    // Verify machine belongs to vendor
    const machineCheck = await query(
      'SELECT id FROM vending_machines WHERE id = $1 AND vendor_id = $2',
      [machineId, req.user.id]
    );

    if (machineCheck.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Vending machine not found',
      });
    }

    // If productId specified, verify product belongs to vendor
    if (value.productId) {
      const productCheck = await query(
        'SELECT id FROM products WHERE id = $1 AND vendor_id = $2',
        [value.productId, req.user.id]
      );

      if (productCheck.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'Product not found',
        });
      }
    }

    const { productId, code, percentOff, startsAt, endsAt, maxUses } = value;

    const result = await query(
      `INSERT INTO discount_codes
       (vendor_id, machine_id, product_id, code, discount_type, discount_value,
        valid_from, valid_until, max_uses, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, true)
       RETURNING *`,
      [
        req.user.id,
        machineId,
        productId || null,
        code.toUpperCase(),
        'percentage',
        percentOff,
        startsAt || null,
        endsAt || null,
        maxUses || null,
      ]
    );

    res.status(201).json({
      success: true,
      message: 'Discount code created successfully',
      data: { discount: result.rows[0] },
    });
  } catch (error) {
    console.error('Error creating discount:', error);
    if (error.message && error.message.includes('unique')) {
      return res.status(409).json({
        success: false,
        message: 'Discount code already exists',
      });
    }
    res.status(500).json({
      success: false,
      message: 'Error creating discount code',
    });
  }
});

/**
 * DELETE /api/vendor/machines/:machineId/discounts/:discountId
 * Delete a discount code
 */
router.delete('/machines/:machineId/discounts/:discountId', async (req, res) => {
  try {
    const { machineId, discountId } = req.params;

    // Verify machine belongs to vendor
    const machineCheck = await query(
      'SELECT id FROM vending_machines WHERE id = $1 AND vendor_id = $2',
      [machineId, req.user.id]
    );

    if (machineCheck.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Vending machine not found',
      });
    }

    const result = await query(
      'DELETE FROM discount_codes WHERE id = $1 AND machine_id = $2 AND vendor_id = $3 RETURNING id',
      [discountId, machineId, req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Discount code not found',
      });
    }

    res.json({
      success: true,
      message: 'Discount code deleted successfully',
    });
  } catch (error) {
    console.error('Error deleting discount:', error);
    res.status(500).json({
      success: false,
      message: 'Error deleting discount code',
    });
  }
});

// ============================================
// POLL ROUTES
// ============================================

/**
 * POST /api/vendor/machines/:machineId/polls
 * Create a poll for a machine
 */
router.post('/machines/:machineId/polls', async (req, res) => {
  try {
    const { machineId } = req.params;
    const vendorId = req.user.id;

    const schema = Joi.object({
      question: Joi.string().min(5).max(500).required(),
      options: Joi.array().items(
        Joi.object({
          text: Joi.string().min(1).max(255).required(),
          imageUrl: Joi.string().uri().allow('', null).optional(),
        })
      ).min(2).max(20).required(),
    });

    const { error, value } = schema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message,
      });
    }

    const { question, options } = value;

    // Verify machine belongs to vendor
    const machineCheck = await query(
      'SELECT id FROM vending_machines WHERE id = $1 AND vendor_id = $2',
      [machineId, vendorId]
    );

    if (machineCheck.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Machine not found',
      });
    }

    // Create poll
    const pollResult = await query(
      `INSERT INTO polls (vendor_id, machine_id, poll_question, is_active)
       VALUES ($1, $2, $3, true)
       RETURNING id, poll_question, created_at`,
      [vendorId, machineId, question]
    );

    const poll = pollResult.rows[0];

    // Create poll options
    const optionPromises = options.map((option, index) =>
      query(
        `INSERT INTO poll_options (poll_id, option_text, image_url, display_order)
         VALUES ($1, $2, $3, $4)
         RETURNING id, option_text, image_url`,
        [poll.id, option.text, option.imageUrl || null, index]
      )
    );

    const optionResults = await Promise.all(optionPromises);
    const createdOptions = optionResults.map(r => r.rows[0]);

    res.status(201).json({
      success: true,
      message: 'Poll created successfully',
      data: {
        poll: {
          ...poll,
          options: createdOptions,
        },
      },
    });
  } catch (error) {
    console.error('Error creating poll:', error);
    res.status(500).json({
      success: false,
      message: 'Error creating poll',
    });
  }
});

/**
 * GET /api/vendor/polls/:pollId/results
 * Get aggregated poll results
 */
router.get('/polls/:pollId/results', async (req, res) => {
  try {
    const { pollId } = req.params;
    const vendorId = req.user.id;

    // Verify poll belongs to vendor
    const pollCheck = await query(
      'SELECT id, poll_question, machine_id, created_at FROM polls WHERE id = $1 AND vendor_id = $2',
      [pollId, vendorId]
    );

    if (pollCheck.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Poll not found',
      });
    }

    const poll = pollCheck.rows[0];

    // Get results from view
    const resultsQuery = await query(
      `SELECT option_id, option_text, image_url, approve_count, deny_count,
              total_votes, approve_percent
       FROM poll_results
       WHERE poll_id = $1
       ORDER BY approve_percent DESC, total_votes DESC`,
      [pollId]
    );

    const totalVotes = resultsQuery.rows.reduce((sum, row) => sum + parseInt(row.total_votes), 0);

    res.json({
      success: true,
      data: {
        poll: {
          id: poll.id,
          question: poll.poll_question,
          machineId: poll.machine_id,
          createdAt: poll.created_at,
        },
        results: resultsQuery.rows,
        totalVotes,
      },
    });
  } catch (error) {
    console.error('Error fetching poll results:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching poll results',
    });
  }
});

/**
 * GET /api/vendor/machines/:machineId/polls
 * Get all polls for a machine
 */
router.get('/machines/:machineId/polls', async (req, res) => {
  try {
    const { machineId } = req.params;
    const vendorId = req.user.id;

    // Verify machine belongs to vendor
    const machineCheck = await query(
      'SELECT id FROM vending_machines WHERE id = $1 AND vendor_id = $2',
      [machineId, vendorId]
    );

    if (machineCheck.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Machine not found',
      });
    }

    const pollsResult = await query(
      `SELECT p.id, p.poll_question, p.is_active, p.created_at,
              COUNT(DISTINCT pv.id) as total_votes
       FROM polls p
       LEFT JOIN poll_votes pv ON p.id = pv.poll_id
       WHERE p.machine_id = $1
       GROUP BY p.id
       ORDER BY p.created_at DESC`,
      [machineId]
    );

    res.json({
      success: true,
      data: {
        polls: pollsResult.rows,
        count: pollsResult.rows.length,
      },
    });
  } catch (error) {
    console.error('Error fetching polls:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching polls',
    });
  }
});

module.exports = router;
