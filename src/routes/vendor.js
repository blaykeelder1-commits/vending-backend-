const express = require('express');
const Joi = require('joi');
const { query, transaction } = require('../config/database');
const { protect, restrictTo } = require('../middleware/auth');
const { generateQRCodeData, generateQRCodeDataURL } = require('../services/qrCodeService');
const rankingService = require('../services/rankingService');
const logger = require('../utils/logger');

const router = express.Router();

// Apply vendor authentication to all routes
router.use(protect);
router.use(restrictTo('vendor'));

// ========================================
// HELPER: Log machine history
// ========================================
async function logMachineHistory(machineId, vendorId, actionType, details = {}) {
  try {
    await query(
      `INSERT INTO machine_history (machine_id, vendor_id, action_type, details)
       VALUES ($1, $2, $3, $4)`,
      [machineId, vendorId, actionType, JSON.stringify(details)]
    );
  } catch (err) {
    logger.error('Error logging machine history', { error: err.message });
    // Don't throw - history logging should not break the main operation
  }
}

// Helper: Update last_visit_at timestamp
async function updateLastVisit(machineId) {
  try {
    await query(
      `UPDATE vending_machines SET last_visit_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [machineId]
    );
  } catch (err) {
    logger.error('Error updating last visit', { error: err.message });
  }
}

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
      `SELECT vm.id, vm.machine_name, vm.location, vm.qr_code_data, vm.qr_code_image_url,
              vm.google_sheet_id, vm.qr_token, vm.is_active, vm.created_at, vm.updated_at,
              vm.last_visit_at,
              COUNT(mp.id) as product_count,
              COUNT(CASE WHEN mp.is_performing = true THEN 1 END) as performing_count,
              COUNT(CASE WHEN mp.is_performing = false THEN 1 END) as not_performing_count
       FROM vending_machines vm
       LEFT JOIN machine_products mp ON vm.id = mp.machine_id AND (mp.is_deleted = false OR mp.is_deleted IS NULL)
       WHERE vm.vendor_id = $1 AND (vm.is_deleted = false OR vm.is_deleted IS NULL)
       GROUP BY vm.id
       ORDER BY vm.created_at DESC`,
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
    logger.error('Error fetching machines', { error: error.message });
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

    let result = await query(
      `SELECT id, machine_name, location, qr_code_data, qr_code_image_url,
              google_sheet_id, qr_token, is_active, notes, created_at, updated_at, last_visit_at
       FROM vending_machines
       WHERE id = $1 AND vendor_id = $2 AND (is_deleted = false OR is_deleted IS NULL)`,
      [id, req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Vending machine not found',
      });
    }

    let machine = result.rows[0];

    // Auto-update last_visit_at when machine is accessed
    updateLastVisit(id);

    // Generate qr_token if missing (lazy generation with row-level lock to prevent race condition)
    if (!machine.qr_token) {
      const tokenResult = await transaction(async (client) => {
        // Lock the row to prevent concurrent updates
        const locked = await client.query(
          `SELECT qr_token FROM vending_machines WHERE id = $1 FOR UPDATE`,
          [id]
        );
        // Double-check after acquiring lock (another request may have updated it)
        if (!locked.rows[0].qr_token) {
          await client.query(
            `UPDATE vending_machines SET qr_token = gen_random_uuid() WHERE id = $1`,
            [id]
          );
        }
        return client.query(`SELECT qr_token FROM vending_machines WHERE id = $1`, [id]);
      });
      machine.qr_token = tokenResult.rows[0].qr_token;
    }

    res.json({
      success: true,
      data: { machine },
    });
  } catch (error) {
    logger.error('Error fetching machine', { error: error.message });
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

    // Use transaction to ensure atomic machine creation with QR code
    const finalResult = await transaction(async (client) => {
      // First insert to get the machine ID
      const tempQR = await generateQRCodeData(0); // Temporary
      const result = await client.query(
        `INSERT INTO vending_machines
         (vendor_id, machine_name, location, qr_code_data, google_sheet_id, qr_token, is_active)
         VALUES ($1, $2, $3, $4, $5, gen_random_uuid(), true)
         RETURNING id`,
        [req.user.id, machineName, location, tempQR.qrData, googleSheetId || null]
      );

      const machineId = result.rows[0].id;

      // Generate proper QR code with actual machine ID
      const qrCode = await generateQRCodeData(machineId);
      const qrImageUrl = await generateQRCodeDataURL(qrCode.qrData);

      // Update with correct QR code
      await client.query(
        `UPDATE vending_machines
         SET qr_code_data = $1, qr_code_image_url = $2
         WHERE id = $3`,
        [qrCode.qrData, qrImageUrl, machineId]
      );

      // Fetch the complete machine data
      return client.query(
        `SELECT id, machine_name, location, qr_code_data, qr_code_image_url,
                google_sheet_id, is_active, created_at, updated_at
         FROM vending_machines
         WHERE id = $1`,
        [machineId]
      );
    });

    res.status(201).json({
      success: true,
      message: 'Vending machine created successfully',
      data: { machine: finalResult.rows[0] },
    });
  } catch (error) {
    logger.error('Error creating machine', { error: error.message });
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
    logger.error('Error updating machine', { error: error.message });
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

    const result = await transaction(async (client) => {
      // Soft delete the machine
      const machineResult = await client.query(
        `UPDATE vending_machines SET is_deleted = true, deleted_at = NOW(), is_active = false
         WHERE id = $1 AND vendor_id = $2 AND is_deleted = false
         RETURNING id`,
        [id, req.user.id]
      );

      if (machineResult.rows.length === 0) {
        return null;
      }

      // Soft delete associated machine_products
      await client.query(
        `UPDATE machine_products SET is_deleted = true, deleted_at = NOW()
         WHERE machine_id = $1 AND is_deleted = false`,
        [id]
      );

      return machineResult.rows[0];
    });

    if (!result) {
      return res.status(404).json({
        success: false,
        message: 'Vending machine not found',
      });
    }

    res.json({
      success: true,
      message: 'Vending machine deleted successfully (recoverable for 30 days)',
    });
  } catch (error) {
    logger.error('Error deleting machine', { error: error.message });
    res.status(500).json({
      success: false,
      message: 'Error deleting vending machine',
    });
  }
});

/**
 * GET /api/vendor/machines/:id/qr
 * Get machine QR token and URL
 */
router.get('/machines/:id/qr', async (req, res) => {
  try {
    const { id } = req.params;
    const vendorId = req.user.id;

    const result = await query(
      `SELECT id, qr_token FROM vending_machines WHERE id = $1 AND vendor_id = $2`,
      [id, vendorId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Machine not found'
      });
    }

    let machine = result.rows[0];

    // Generate token if missing
    if (!machine.qr_token) {
      const updateResult = await query(
        `UPDATE vending_machines SET qr_token = gen_random_uuid() WHERE id = $1 RETURNING qr_token`,
        [id]
      );
      machine.qr_token = updateResult.rows[0].qr_token;
    }

    const baseUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    const qr_url = `${baseUrl}/customer/machine/${machine.qr_token}`;

    res.json({
      success: true,
      data: {
        qr_token: machine.qr_token,
        qr_url
      }
    });
  } catch (err) {
    logger.error('Error getting machine QR', { error: err.message });
    res.status(500).json({
      success: false,
      message: 'Server error'
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
      `SELECT id, product_name, description, price, image_url, category,
              is_active, created_at, updated_at
       FROM products
       WHERE vendor_id = $1 AND (is_deleted = false OR is_deleted IS NULL)
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
    logger.error('Error fetching products', { error: error.message });
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
      `SELECT id, product_name, description, price, image_url, category,
              is_active, created_at, updated_at
       FROM products
       WHERE id = $1 AND vendor_id = $2 AND (is_deleted = false OR is_deleted IS NULL)`,
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
    logger.error('Error fetching product', { error: error.message });
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
       (vendor_id, product_name, description, price, image_url, category, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, true)
       RETURNING id, product_name, description, price, image_url, category, is_active, created_at, updated_at`,
      [req.user.id, productName, description || null, price, imageUrl || null, category || null]
    );

    res.status(201).json({
      success: true,
      message: 'Product created successfully',
      data: { product: result.rows[0] },
    });
  } catch (error) {
    logger.error('Error creating product', { error: error.message });
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
    if (value.category !== undefined) {
      updates.push(`category = $${paramCount++}`);
      values.push(value.category || null);
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
    logger.error('Error updating product', { error: error.message });
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
      `UPDATE products SET is_deleted = true, deleted_at = NOW(), is_active = false
       WHERE id = $1 AND vendor_id = $2 AND is_deleted = false
       RETURNING id`,
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
      message: 'Product deleted successfully (recoverable for 30 days)',
    });
  } catch (error) {
    logger.error('Error deleting product', { error: error.message });
    res.status(500).json({
      success: false,
      message: 'Error deleting product',
    });
  }
});

// ========================================
// MACHINE INVENTORY (PLANOGRAM) ROUTES
// ========================================

/**
 * GET /api/vendor/machines/:machineId/inventory
 * Get all products for a specific machine with performance status
 */
router.get('/machines/:machineId/inventory', async (req, res) => {
  try {
    const { machineId } = req.params;

    // Verify machine belongs to vendor
    const machineCheck = await query(
      'SELECT id, machine_name FROM vending_machines WHERE id = $1 AND vendor_id = $2',
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
              mp.is_performing, mp.performance_marked_at, mp.expiration_date,
              mp.expiration_date - CURRENT_DATE as days_until_expiration,
              p.product_name, p.description, p.price, p.image_url, p.category
       FROM machine_products mp
       JOIN products p ON mp.product_id = p.id
       WHERE mp.machine_id = $1 AND (mp.is_deleted = false OR mp.is_deleted IS NULL)
       ORDER BY p.product_name`,
      [machineId]
    );

    // Calculate stats including expiration info
    const expiringProducts = result.rows.filter(r =>
      r.expiration_date && r.days_until_expiration <= 7
    );

    const stats = {
      total: result.rows.length,
      performing: result.rows.filter(r => r.is_performing === true).length,
      notPerforming: result.rows.filter(r => r.is_performing === false).length,
      unmarked: result.rows.filter(r => r.is_performing === null).length,
      expiringSoon: expiringProducts.length,
    };

    res.json({
      success: true,
      data: {
        machine: machineCheck.rows[0],
        inventory: result.rows,
        stats,
        count: result.rows.length,
      },
    });
  } catch (error) {
    logger.error('Error fetching inventory', { error: error.message });
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

    // Check inventory limit (40 products max)
    const countCheck = await query(
      'SELECT COUNT(*) as count FROM machine_products WHERE machine_id = $1',
      [machineId]
    );

    if (parseInt(countCheck.rows[0].count) >= 40) {
      return res.status(400).json({
        success: false,
        message: 'Machine inventory limit reached (40 products max)',
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

    // Get product name for history logging
    const productInfo = await query(
      'SELECT product_name FROM products WHERE id = $1',
      [productId]
    );
    const productName = productInfo.rows[0]?.product_name || 'Unknown';

    const result = await query(
      `INSERT INTO machine_products (machine_id, product_id, current_stock)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [machineId, productId, stockQuantity]
    );

    // Log to machine_history for visit memory
    await logMachineHistory(machineId, req.user.id, 'product_added', {
      product_id: productId,
      product_name: productName,
      initial_stock: stockQuantity,
      inventory_id: result.rows[0].id
    });

    // Update last visit timestamp
    updateLastVisit(machineId);

    res.status(201).json({
      success: true,
      message: 'Product added to machine inventory',
      data: { inventoryItem: result.rows[0] },
    });
  } catch (error) {
    logger.error('Error adding to inventory', { error: error.message });
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
 * Update machine inventory item (stock quantity)
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
    logger.error('Error updating inventory', { error: error.message });
    res.status(500).json({
      success: false,
      message: 'Error updating inventory',
    });
  }
});

/**
 * PUT /api/vendor/machines/:machineId/inventory/:id/performance
 * Set product performance status (Yes/No)
 */
router.put('/machines/:machineId/inventory/:id/performance', async (req, res) => {
  try {
    const { machineId, id } = req.params;
    const schema = Joi.object({
      isPerforming: Joi.boolean().required(),
      notes: Joi.string().max(500).optional(),
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

    const { isPerforming, notes } = value;

    // Get current status and product info for history logging
    const currentItem = await query(
      `SELECT mp.is_performing, mp.product_id, p.product_name
       FROM machine_products mp
       JOIN products p ON mp.product_id = p.id
       WHERE mp.id = $1 AND mp.machine_id = $2`,
      [id, machineId]
    );

    if (currentItem.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Inventory item not found',
      });
    }

    const oldStatus = currentItem.rows[0].is_performing;
    const productId = currentItem.rows[0].product_id;
    const productName = currentItem.rows[0].product_name;

    // Update performance status
    const result = await query(
      `UPDATE machine_products
       SET is_performing = $1, performance_marked_at = CURRENT_TIMESTAMP
       WHERE id = $2 AND machine_id = $3
       RETURNING *`,
      [isPerforming, id, machineId]
    );

    // Log the performance change
    await query(
      `INSERT INTO product_performance_log (machine_product_id, is_performing, marked_by, notes)
       VALUES ($1, $2, $3, $4)`,
      [id, isPerforming, req.user.id, notes || null]
    );

    // Log to machine_history for visit memory
    await logMachineHistory(machineId, req.user.id, 'performance_change', {
      product_id: productId,
      product_name: productName,
      old_status: oldStatus,
      new_status: isPerforming,
      inventory_id: parseInt(id)
    });

    // Update last visit timestamp
    updateLastVisit(machineId);

    res.json({
      success: true,
      message: isPerforming ? 'Product marked as performing well' : 'Product marked as not performing',
      data: { inventoryItem: result.rows[0] },
    });
  } catch (error) {
    logger.error('Error updating performance', { error: error.message });
    res.status(500).json({
      success: false,
      message: 'Error updating performance status',
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

    // Get product info before deletion for history logging
    const productInfo = await query(
      `SELECT mp.product_id, p.product_name, mp.current_stock, mp.is_performing
       FROM machine_products mp
       JOIN products p ON mp.product_id = p.id
       WHERE mp.id = $1 AND mp.machine_id = $2`,
      [id, machineId]
    );

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

    // Log to machine_history for visit memory
    if (productInfo.rows.length > 0) {
      const { product_id, product_name, current_stock, is_performing } = productInfo.rows[0];
      await logMachineHistory(machineId, req.user.id, 'product_removed', {
        product_id,
        product_name,
        stock_at_removal: current_stock,
        was_performing: is_performing,
        reason: 'manual'
      });
    }

    // Update last visit timestamp
    updateLastVisit(machineId);

    res.json({
      success: true,
      message: 'Product removed from inventory',
    });
  } catch (error) {
    logger.error('Error removing from inventory', { error: error.message });
    res.status(500).json({
      success: false,
      message: 'Error removing product from inventory',
    });
  }
});

// ========================================
// PERFORMANCE COMPARISON ROUTES
// ========================================

/**
 * GET /api/vendor/performance-comparison
 * Get performance comparison for a product across all vendor's machines
 */
router.get('/performance-comparison', async (req, res) => {
  try {
    const { productId } = req.query;

    if (!productId) {
      return res.status(400).json({
        success: false,
        message: 'productId query parameter required',
      });
    }

    // Verify product belongs to vendor
    const productCheck = await query(
      'SELECT id, product_name, image_url FROM products WHERE id = $1 AND vendor_id = $2',
      [productId, req.user.id]
    );

    if (productCheck.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Product not found',
      });
    }

    // Get performance across all vendor's machines
    const result = await query(
      `SELECT mp.id, mp.machine_id, mp.is_performing, mp.performance_marked_at, mp.current_stock,
              vm.machine_name, vm.location
       FROM machine_products mp
       JOIN vending_machines vm ON mp.machine_id = vm.id
       WHERE mp.product_id = $1 AND vm.vendor_id = $2
       ORDER BY mp.is_performing DESC NULLS LAST, vm.machine_name`,
      [productId, req.user.id]
    );

    const stats = {
      totalMachines: result.rows.length,
      performing: result.rows.filter(r => r.is_performing === true).length,
      notPerforming: result.rows.filter(r => r.is_performing === false).length,
      unmarked: result.rows.filter(r => r.is_performing === null).length,
    };

    res.json({
      success: true,
      data: {
        product: productCheck.rows[0],
        machines: result.rows,
        stats,
      },
    });
  } catch (error) {
    logger.error('Error fetching performance comparison', { error: error.message });
    res.status(500).json({
      success: false,
      message: 'Error fetching performance comparison',
    });
  }
});

/**
 * GET /api/vendor/top-products
 * Get global Top 50 products across all vendors
 * Uses cached rankings from hourly cron job, falls back to live calculation
 */
router.get('/top-products', async (req, res) => {
  try {
    const result = await rankingService.getTopProducts(50);

    res.json({
      success: true,
      data: {
        topProducts: result.products,
        count: result.products.length,
        lastUpdated: result.lastUpdated,
        fromCache: result.fromCache,
      },
    });
  } catch (error) {
    logger.error('Error fetching top products', { error: error.message });
    res.status(500).json({
      success: false,
      message: 'Error fetching top products',
    });
  }
});

// ============================================
// REDISTRIBUTION PLAN ROUTES
// ============================================

/**
 * GET /api/vendor/redistribution-plan
 * Generate an optimized redistribution plan across all machines
 * Shows what to REMOVE (underperforming) and ADD (performing) at each machine stop
 */
router.get('/redistribution-plan', async (req, res) => {
  try {
    const vendorId = req.user.id;

    // Get all underperforming products and where they perform well
    const redistributionData = await query(
      `WITH product_performance AS (
        SELECT
          mp.product_id,
          p.product_name,
          mp.machine_id,
          vm.machine_name,
          vm.location,
          mp.current_stock,
          mp.is_performing,
          mp.id as inventory_id
        FROM machine_products mp
        JOIN products p ON mp.product_id = p.id
        JOIN vending_machines vm ON mp.machine_id = vm.id
        WHERE vm.vendor_id = $1
          AND mp.is_performing IS NOT NULL
          AND mp.current_stock > 0
      ),
      underperforming AS (
        SELECT * FROM product_performance WHERE is_performing = false
      ),
      performing AS (
        SELECT * FROM product_performance WHERE is_performing = true
      )
      SELECT
        u.product_id,
        u.product_name,
        u.machine_id as source_machine_id,
        u.machine_name as source_machine_name,
        u.location as source_location,
        u.current_stock as source_stock,
        u.inventory_id as source_inventory_id,
        p.machine_id as target_machine_id,
        p.machine_name as target_machine_name,
        p.location as target_location,
        p.current_stock as target_stock
      FROM underperforming u
      JOIN performing p ON u.product_id = p.product_id AND u.machine_id != p.machine_id
      ORDER BY u.machine_name, u.product_name, p.current_stock ASC`,
      [vendorId]
    );

    // Get all machines for the vendor
    const machinesResult = await query(
      `SELECT id, machine_name, location
       FROM vending_machines
       WHERE vendor_id = $1 AND is_active = true
       ORDER BY machine_name`,
      [vendorId]
    );

    // Organize data by machine (route stops)
    const routePlan = {};
    const machines = machinesResult.rows;

    // Initialize route plan for each machine
    machines.forEach(m => {
      routePlan[m.id] = {
        machineId: m.id,
        machineName: m.machine_name,
        location: m.location,
        remove: [],  // Products to PULL OUT (underperforming here)
        add: []      // Products to PUT IN (performing here, coming from elsewhere)
      };
    });

    // Process redistribution data
    const processedMoves = new Set(); // Track to avoid duplicates

    redistributionData.rows.forEach(row => {
      const moveKey = `${row.product_id}-${row.source_machine_id}-${row.target_machine_id}`;

      if (!processedMoves.has(moveKey)) {
        processedMoves.add(moveKey);

        // Add to REMOVE list for source machine
        const existingRemove = routePlan[row.source_machine_id]?.remove.find(
          r => r.productId === row.product_id
        );

        if (!existingRemove && routePlan[row.source_machine_id]) {
          routePlan[row.source_machine_id].remove.push({
            productId: row.product_id,
            productName: row.product_name,
            currentStock: row.source_stock,
            inventoryId: row.source_inventory_id,
            suggestedTargets: [{
              machineId: row.target_machine_id,
              machineName: row.target_machine_name,
              location: row.target_location,
              currentStock: row.target_stock
            }]
          });
        } else if (existingRemove) {
          // Add to suggested targets
          existingRemove.suggestedTargets.push({
            machineId: row.target_machine_id,
            machineName: row.target_machine_name,
            location: row.target_location,
            currentStock: row.target_stock
          });
        }

        // Add to ADD list for target machine
        const existingAdd = routePlan[row.target_machine_id]?.add.find(
          a => a.productId === row.product_id && a.sourceMachineId === row.source_machine_id
        );

        if (!existingAdd && routePlan[row.target_machine_id]) {
          routePlan[row.target_machine_id].add.push({
            productId: row.product_id,
            productName: row.product_name,
            sourceMachineId: row.source_machine_id,
            sourceMachineName: row.source_machine_name,
            sourceLocation: row.source_location,
            availableStock: row.source_stock
          });
        }
      }
    });

    // Convert to array and filter out machines with no actions
    const routeStops = Object.values(routePlan).filter(
      stop => stop.remove.length > 0 || stop.add.length > 0
    );

    // Calculate summary stats
    const totalRemoves = routeStops.reduce((sum, stop) => sum + stop.remove.length, 0);
    const totalAdds = routeStops.reduce((sum, stop) => sum + stop.add.length, 0);

    res.json({
      success: true,
      data: {
        routeStops,
        summary: {
          totalMachinesAffected: routeStops.length,
          totalProductsToRemove: totalRemoves,
          totalProductsToAdd: totalAdds,
          allMachines: machines
        }
      }
    });
  } catch (error) {
    logger.error('Error generating redistribution plan', { error: error.message });
    res.status(500).json({
      success: false,
      message: 'Error generating redistribution plan',
    });
  }
});

// ============================================
// SWIPE POLL ROUTES
// ============================================

/**
 * POST /api/vendor/machines/:machineId/polls
 * Create a swipe poll for a machine (products for customers to vote on)
 * Supports two poll types:
 * - 'performance': Poll about existing products (underperformers)
 * - 'discovery': Poll about potential new products (not yet in inventory)
 */
router.post('/machines/:machineId/polls', async (req, res) => {
  try {
    const { machineId } = req.params;
    const vendorId = req.user.id;

    const schema = Joi.object({
      question: Joi.string().min(5).max(500).default('Which products would you like to see?'),
      pollType: Joi.string().valid('performance', 'discovery').default('performance'),
      products: Joi.array().items(
        Joi.object({
          name: Joi.string().min(1).max(255).required(),
          imageUrl: Joi.string().uri().allow('', null).optional(),
          productId: Joi.number().integer().allow(null).optional(), // For linking to existing products
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

    const { question, pollType, products } = value;

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

    // Deactivate any existing active polls for this machine
    await query(
      `UPDATE polls SET is_active = false, closed_at = NOW() WHERE machine_id = $1 AND is_active = true`,
      [machineId]
    );

    // Create poll with poll_type
    const pollResult = await query(
      `INSERT INTO polls (vendor_id, machine_id, poll_question, is_active, poll_type, is_auto_generated)
       VALUES ($1, $2, $3, true, $4, false)
       RETURNING id, poll_question, created_at, poll_type, is_auto_generated`,
      [vendorId, machineId, question, pollType]
    );

    const poll = pollResult.rows[0];

    // Create poll options (products to swipe on)
    const optionPromises = products.map((product, index) =>
      query(
        `INSERT INTO poll_options (poll_id, option_text, image_url, product_id, display_order)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, option_text, image_url, product_id`,
        [poll.id, product.name, product.imageUrl || null, product.productId || null, index]
      )
    );

    const optionResults = await Promise.all(optionPromises);
    const createdOptions = optionResults.map(r => r.rows[0]);

    res.status(201).json({
      success: true,
      message: pollType === 'discovery'
        ? 'Discovery poll created - gauge interest in new products!'
        : 'Performance poll created successfully',
      data: {
        poll: {
          ...poll,
          pollType: poll.poll_type,
          isAutoGenerated: poll.is_auto_generated,
          products: createdOptions,
        },
      },
    });
  } catch (error) {
    logger.error('Error creating poll', { error: error.message });
    res.status(500).json({
      success: false,
      message: 'Error creating poll',
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
      'SELECT id, machine_name FROM vending_machines WHERE id = $1 AND vendor_id = $2',
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
              p.poll_type, p.is_auto_generated,
              COUNT(DISTINCT po.id) as product_count,
              COUNT(DISTINCT pv.id) as total_votes
       FROM polls p
       LEFT JOIN poll_options po ON p.id = po.poll_id
       LEFT JOIN poll_votes pv ON p.id = pv.poll_id
       WHERE p.machine_id = $1
       GROUP BY p.id
       ORDER BY p.created_at DESC`,
      [machineId]
    );

    res.json({
      success: true,
      data: {
        machine: machineCheck.rows[0],
        polls: pollsResult.rows.map(poll => ({
          ...poll,
          pollType: poll.poll_type || 'performance',
          isAutoGenerated: poll.is_auto_generated || false,
        })),
        count: pollsResult.rows.length,
      },
    });
  } catch (error) {
    logger.error('Error fetching polls', { error: error.message });
    res.status(500).json({
      success: false,
      message: 'Error fetching polls',
    });
  }
});

/**
 * GET /api/vendor/machines/:machineId/swipe-results
 * Get swipe poll results for a machine
 */
router.get('/machines/:machineId/swipe-results', async (req, res) => {
  try {
    const { machineId } = req.params;
    const vendorId = req.user.id;

    // Verify machine belongs to vendor
    const machineCheck = await query(
      'SELECT id, machine_name FROM vending_machines WHERE id = $1 AND vendor_id = $2',
      [machineId, vendorId]
    );

    if (machineCheck.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Machine not found',
      });
    }

    // Get active poll
    const pollResult = await query(
      `SELECT id, poll_question, created_at, poll_type, is_auto_generated FROM polls
       WHERE machine_id = $1 AND is_active = true
       ORDER BY created_at DESC LIMIT 1`,
      [machineId]
    );

    if (pollResult.rows.length === 0) {
      return res.json({
        success: true,
        data: {
          machine: machineCheck.rows[0],
          poll: null,
          results: [],
          message: 'No active poll for this machine',
        },
      });
    }

    const pollRow = pollResult.rows[0];
    const poll = {
      ...pollRow,
      pollType: pollRow.poll_type || 'performance',
      isAutoGenerated: pollRow.is_auto_generated || false,
    };

    // Get results
    const resultsQuery = await query(
      `SELECT
        po.id,
        po.option_text as product_name,
        po.image_url,
        COUNT(CASE WHEN pv.vote_type = 'like' THEN 1 END) as swipe_right,
        COUNT(CASE WHEN pv.vote_type = 'dislike' THEN 1 END) as swipe_left,
        COUNT(pv.id) as total_votes
       FROM poll_options po
       LEFT JOIN poll_votes pv ON po.id = pv.poll_option_id
       WHERE po.poll_id = $1
       GROUP BY po.id, po.option_text, po.image_url
       ORDER BY swipe_right DESC, total_votes DESC`,
      [poll.id]
    );

    const totalVotes = resultsQuery.rows.reduce((sum, row) => sum + parseInt(row.total_votes), 0);

    res.json({
      success: true,
      data: {
        machine: machineCheck.rows[0],
        poll,
        results: resultsQuery.rows.map(row => ({
          ...row,
          approvalRate: row.total_votes > 0
            ? Math.round((row.swipe_right / row.total_votes) * 100)
            : 0,
        })),
        totalVotes,
      },
    });
  } catch (error) {
    logger.error('Error fetching swipe results', { error: error.message });
    res.status(500).json({
      success: false,
      message: 'Error fetching swipe results',
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
      'SELECT id, poll_question, machine_id, created_at, poll_type, is_auto_generated FROM polls WHERE id = $1 AND vendor_id = $2',
      [pollId, vendorId]
    );

    if (pollCheck.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Poll not found',
      });
    }

    const pollRow = pollCheck.rows[0];
    const poll = {
      ...pollRow,
      pollType: pollRow.poll_type || 'performance',
      isAutoGenerated: pollRow.is_auto_generated || false,
    };

    // Get results
    const resultsQuery = await query(
      `SELECT
        po.id as option_id,
        po.option_text as product_name,
        po.image_url,
        COUNT(CASE WHEN pv.vote_type = 'like' THEN 1 END) as swipe_right,
        COUNT(CASE WHEN pv.vote_type = 'dislike' THEN 1 END) as swipe_left,
        COUNT(pv.id) as total_votes
       FROM poll_options po
       LEFT JOIN poll_votes pv ON po.id = pv.poll_option_id
       WHERE po.poll_id = $1
       GROUP BY po.id, po.option_text, po.image_url
       ORDER BY swipe_right DESC`,
      [pollId]
    );

    const totalVotes = resultsQuery.rows.reduce((sum, row) => sum + parseInt(row.total_votes), 0);

    // Get machine name
    const machineResult = await query(
      `SELECT machine_name FROM vending_machines WHERE id = $1`,
      [poll.machine_id]
    );

    res.json({
      success: true,
      data: {
        poll: {
          id: poll.id,
          poll_question: poll.poll_question,
          machine_name: machineResult.rows[0]?.machine_name || 'Unknown Machine',
          pollType: poll.pollType,
          isAutoGenerated: poll.isAutoGenerated,
        },
        results: resultsQuery.rows.map(row => ({
          ...row,
          approval_percent: row.total_votes > 0
            ? Math.round((row.swipe_right / row.total_votes) * 100)
            : 0,
        })),
        totalVotes,
      },
    });
  } catch (error) {
    logger.error('Error fetching poll results', { error: error.message });
    res.status(500).json({
      success: false,
      message: 'Error fetching poll results',
    });
  }
});

// ========================================
// POLL SUMMARY (AGGREGATED ACROSS ALL MACHINES)
// ========================================

/**
 * GET /api/vendor/poll-summary
 * Get aggregated poll results across ALL vendor machines, grouped by product name
 */
router.get('/poll-summary', async (req, res) => {
  try {
    const vendorId = req.user.id;

    const result = await query(
      `SELECT
        po.option_text AS product_name,
        COUNT(CASE WHEN pv.vote_type = 'like' THEN 1 END)::int AS likes,
        COUNT(CASE WHEN pv.vote_type = 'dislike' THEN 1 END)::int AS dislikes,
        COUNT(pv.id)::int AS total_votes,
        COUNT(DISTINCT p.machine_id)::int AS machines_polled,
        CASE WHEN COUNT(pv.id) > 0
          THEN ROUND((COUNT(CASE WHEN pv.vote_type = 'like' THEN 1 END)::numeric / COUNT(pv.id)) * 100)
          ELSE 0
        END AS approval_rate
       FROM poll_options po
       JOIN polls p ON po.poll_id = p.id
       LEFT JOIN poll_votes pv ON po.id = pv.poll_option_id
       WHERE p.vendor_id = $1
       GROUP BY po.option_text
       ORDER BY approval_rate DESC, total_votes DESC`,
      [vendorId]
    );

    res.json({
      success: true,
      data: {
        products: result.rows,
        count: result.rows.length,
      },
    });
  } catch (error) {
    logger.error('Error fetching poll summary', { error: error.message });
    res.status(500).json({
      success: false,
      message: 'Error fetching poll summary',
    });
  }
});

// ========================================
// PRODUCT REDISTRIBUTION ROUTES
// ========================================

/**
 * GET /api/vendor/machines/:machineId/redistribution-targets
 * Get other machines where a product is performing well (for redistribution)
 */
router.get('/machines/:machineId/redistribution-targets', async (req, res) => {
  try {
    const { machineId } = req.params;
    const { productId } = req.query;

    if (!productId) {
      return res.status(400).json({
        success: false,
        message: 'productId query parameter is required',
      });
    }

    // Verify machine belongs to vendor
    const machineCheck = await query(
      'SELECT id, machine_name FROM vending_machines WHERE id = $1 AND vendor_id = $2',
      [machineId, req.user.id]
    );

    if (machineCheck.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Machine not found',
      });
    }

    // Get product info
    const productCheck = await query(
      'SELECT id, product_name, price FROM products WHERE id = $1 AND vendor_id = $2',
      [productId, req.user.id]
    );

    if (productCheck.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Product not found',
      });
    }

    // Get source machine inventory for this product
    const sourceInventory = await query(
      `SELECT current_stock, is_performing
       FROM machine_products
       WHERE machine_id = $1 AND product_id = $2`,
      [machineId, productId]
    );

    // Get other machines where this product exists and is performing well
    const targetMachines = await query(
      `SELECT
         vm.id as machine_id,
         vm.machine_name,
         vm.location,
         mp.current_stock,
         mp.is_performing,
         mp.performance_marked_at
       FROM vending_machines vm
       LEFT JOIN machine_products mp ON vm.id = mp.machine_id AND mp.product_id = $1
       WHERE vm.vendor_id = $2
         AND vm.id != $3
         AND vm.is_active = true
       ORDER BY
         CASE WHEN mp.is_performing = true THEN 0 ELSE 1 END,
         mp.current_stock ASC NULLS LAST`,
      [productId, req.user.id, machineId]
    );

    res.json({
      success: true,
      data: {
        product: productCheck.rows[0],
        sourceMachine: {
          id: parseInt(machineId),
          machine_name: machineCheck.rows[0].machine_name,
          current_stock: sourceInventory.rows[0]?.current_stock || 0,
          is_performing: sourceInventory.rows[0]?.is_performing,
        },
        targetMachines: targetMachines.rows.map(m => ({
          machine_id: m.machine_id,
          machine_name: m.machine_name,
          location: m.location,
          current_stock: m.current_stock || 0,
          is_performing: m.is_performing,
          performance_marked_at: m.performance_marked_at,
          has_product: m.current_stock !== null,
        })),
      },
    });
  } catch (error) {
    logger.error('Error fetching redistribution targets', { error: error.message });
    res.status(500).json({
      success: false,
      message: 'Error fetching redistribution targets',
    });
  }
});

/**
 * POST /api/vendor/redistribution
 * Execute a product redistribution between machines
 */
router.post('/redistribution', async (req, res) => {
  try {
    const schema = Joi.object({
      sourceMachineId: Joi.number().integer().required(),
      targetMachineId: Joi.number().integer().required(),
      productId: Joi.number().integer().required(),
      quantity: Joi.number().integer().min(1).required(),
      reason: Joi.string().max(500).optional(),
    });

    const { error, value } = schema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message,
      });
    }

    const { sourceMachineId, targetMachineId, productId, quantity, reason } = value;

    if (sourceMachineId === targetMachineId) {
      return res.status(400).json({
        success: false,
        message: 'Source and target machines must be different',
      });
    }

    // Execute redistribution in a transaction
    const result = await transaction(async (client) => {
      // Verify both machines belong to vendor
      const machinesCheck = await client.query(
        `SELECT id, machine_name FROM vending_machines
         WHERE id IN ($1, $2) AND vendor_id = $3`,
        [sourceMachineId, targetMachineId, req.user.id]
      );

      if (machinesCheck.rows.length !== 2) {
        throw new Error('One or both machines not found or not owned by vendor');
      }

      // Verify product belongs to vendor
      const productCheck = await client.query(
        'SELECT id, product_name FROM products WHERE id = $1 AND vendor_id = $2',
        [productId, req.user.id]
      );

      if (productCheck.rows.length === 0) {
        throw new Error('Product not found');
      }

      // Get source inventory with lock
      const sourceInventory = await client.query(
        `SELECT id, current_stock FROM machine_products
         WHERE machine_id = $1 AND product_id = $2 FOR UPDATE`,
        [sourceMachineId, productId]
      );

      if (sourceInventory.rows.length === 0) {
        throw new Error('Product not found in source machine');
      }

      const sourceStock = sourceInventory.rows[0].current_stock;
      if (sourceStock < quantity) {
        throw new Error(`Insufficient stock. Source has ${sourceStock}, requested ${quantity}`);
      }

      // Get or create target inventory
      let targetInventory = await client.query(
        `SELECT id, current_stock FROM machine_products
         WHERE machine_id = $1 AND product_id = $2 FOR UPDATE`,
        [targetMachineId, productId]
      );

      let targetStockBefore = 0;
      let targetInventoryId;

      if (targetInventory.rows.length === 0) {
        // Check product limit (40 max per machine)
        const countCheck = await client.query(
          'SELECT COUNT(*) as count FROM machine_products WHERE machine_id = $1',
          [targetMachineId]
        );

        if (parseInt(countCheck.rows[0].count) >= 40) {
          throw new Error('Target machine has reached maximum product limit (40)');
        }

        // Create new inventory entry
        const newEntry = await client.query(
          `INSERT INTO machine_products (machine_id, product_id, current_stock)
           VALUES ($1, $2, 0) RETURNING id, current_stock`,
          [targetMachineId, productId]
        );
        targetInventoryId = newEntry.rows[0].id;
        targetStockBefore = 0;
      } else {
        targetInventoryId = targetInventory.rows[0].id;
        targetStockBefore = targetInventory.rows[0].current_stock;
      }

      // Update source stock
      const newSourceStock = sourceStock - quantity;

      if (newSourceStock === 0) {
        // Remove product from source machine entirely when fully transferred
        await client.query(
          'DELETE FROM machine_products WHERE id = $1',
          [sourceInventory.rows[0].id]
        );
      } else {
        await client.query(
          'UPDATE machine_products SET current_stock = $1 WHERE id = $2',
          [newSourceStock, sourceInventory.rows[0].id]
        );
      }

      // Update target stock
      await client.query(
        'UPDATE machine_products SET current_stock = current_stock + $1 WHERE id = $2',
        [quantity, targetInventoryId]
      );

      // Record redistribution in audit log
      await client.query(
        `INSERT INTO product_redistributions
         (source_machine_id, target_machine_id, product_id, quantity_transferred,
          reason, performed_by, source_stock_before, source_stock_after,
          target_stock_before, target_stock_after)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          sourceMachineId, targetMachineId, productId, quantity,
          reason || null, req.user.id,
          sourceStock, sourceStock - quantity,
          targetStockBefore, targetStockBefore + quantity
        ]
      );

      return {
        product: productCheck.rows[0],
        quantity,
        sourceStockBefore: sourceStock,
        sourceStockAfter: sourceStock - quantity,
        targetStockBefore,
        targetStockAfter: targetStockBefore + quantity,
      };
    });

    res.json({
      success: true,
      message: `Successfully transferred ${result.quantity} units of ${result.product.product_name}`,
      data: result,
    });
  } catch (error) {
    logger.error('Error executing redistribution', { error: error.message });
    res.status(error.message.includes('not found') || error.message.includes('Insufficient') ? 400 : 500).json({
      success: false,
      message: error.message || 'Error executing redistribution',
    });
  }
});

/**
 * GET /api/vendor/redistribution-history
 * Get redistribution history for audit purposes
 */
router.get('/redistribution-history', async (req, res) => {
  try {
    const { machineId, limit = 50 } = req.query;

    let whereClause = 'WHERE pr.performed_by = $1';
    const params = [req.user.id];

    if (machineId) {
      whereClause += ' AND (pr.source_machine_id = $2 OR pr.target_machine_id = $2)';
      params.push(machineId);
    }

    const result = await query(
      `SELECT
         pr.id,
         pr.quantity_transferred,
         pr.reason,
         pr.source_stock_before,
         pr.source_stock_after,
         pr.target_stock_before,
         pr.target_stock_after,
         pr.created_at,
         p.id as product_id,
         p.product_name,
         sm.id as source_machine_id,
         sm.machine_name as source_machine_name,
         tm.id as target_machine_id,
         tm.machine_name as target_machine_name
       FROM product_redistributions pr
       JOIN products p ON pr.product_id = p.id
       JOIN vending_machines sm ON pr.source_machine_id = sm.id
       JOIN vending_machines tm ON pr.target_machine_id = tm.id
       ${whereClause}
       ORDER BY pr.created_at DESC
       LIMIT $${params.length + 1}`,
      [...params, parseInt(limit)]
    );

    res.json({
      success: true,
      data: {
        redistributions: result.rows,
        count: result.rows.length,
      },
    });
  } catch (error) {
    logger.error('Error fetching redistribution history', { error: error.message });
    res.status(500).json({
      success: false,
      message: 'Error fetching redistribution history',
    });
  }
});

// ============================================
// MACHINE NOTES ROUTES
// ============================================

/**
 * PUT /api/vendor/machines/:id/notes
 * Update notes for a specific machine
 */
router.put('/machines/:id/notes', async (req, res) => {
  try {
    const { id } = req.params;
    const vendorId = req.user.id;

    const schema = Joi.object({
      notes: Joi.string().allow('', null).max(2000),
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
      [id, vendorId]
    );

    if (machineCheck.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Machine not found',
      });
    }

    // Update notes
    const result = await query(
      `UPDATE vending_machines SET notes = $1, updated_at = NOW()
       WHERE id = $2
       RETURNING id, machine_name, notes`,
      [value.notes || null, id]
    );

    res.json({
      success: true,
      message: 'Notes updated',
      data: { machine: result.rows[0] },
    });
  } catch (error) {
    logger.error('Error updating machine notes', { error: error.message });
    res.status(500).json({
      success: false,
      message: 'Error updating notes',
    });
  }
});

// ============================================
// MACHINE VISIT HISTORY ROUTES
// ============================================

/**
 * GET /api/vendor/machines/:machineId/changes-since-visit
 * Get summary of changes since last visit for "Since Last Visit" card
 */
router.get('/machines/:machineId/changes-since-visit', async (req, res) => {
  try {
    const { machineId } = req.params;
    const vendorId = req.user.id;

    // Verify machine belongs to vendor and get last visit timestamp
    const machineCheck = await query(
      'SELECT id, last_visit_at FROM vending_machines WHERE id = $1 AND vendor_id = $2',
      [machineId, vendorId]
    );

    if (machineCheck.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Machine not found',
      });
    }

    const lastVisitAt = machineCheck.rows[0].last_visit_at;

    // If no previous visit, return empty changes
    if (!lastVisitAt) {
      return res.json({
        success: true,
        data: {
          lastVisitAt: null,
          hasHistory: false,
          summary: {
            performanceChanges: 0,
            productsAdded: 0,
            productsRemoved: 0,
            totalChanges: 0
          },
          changes: []
        }
      });
    }

    // Get count of changes since last visit by type
    const summaryResult = await query(
      `SELECT action_type, COUNT(*) as count
       FROM machine_history
       WHERE machine_id = $1 AND created_at > $2
       GROUP BY action_type`,
      [machineId, lastVisitAt]
    );

    const summary = {
      performanceChanges: 0,
      productsAdded: 0,
      productsRemoved: 0,
      stockUpdates: 0,
      noteUpdates: 0,
      totalChanges: 0
    };

    summaryResult.rows.forEach(row => {
      const count = parseInt(row.count);
      summary.totalChanges += count;
      switch (row.action_type) {
        case 'performance_change':
          summary.performanceChanges = count;
          break;
        case 'product_added':
          summary.productsAdded = count;
          break;
        case 'product_removed':
          summary.productsRemoved = count;
          break;
        case 'stock_updated':
          summary.stockUpdates = count;
          break;
        case 'note_updated':
          summary.noteUpdates = count;
          break;
      }
    });

    // Get detailed changes (most recent 20)
    const changesResult = await query(
      `SELECT action_type, details, created_at
       FROM machine_history
       WHERE machine_id = $1 AND created_at > $2
       ORDER BY created_at DESC
       LIMIT 20`,
      [machineId, lastVisitAt]
    );

    res.json({
      success: true,
      data: {
        lastVisitAt,
        hasHistory: true,
        summary,
        changes: changesResult.rows.map(row => ({
          actionType: row.action_type,
          details: row.details,
          createdAt: row.created_at
        }))
      }
    });
  } catch (error) {
    logger.error('Error fetching changes since visit', { error: error.message });
    res.status(500).json({
      success: false,
      message: 'Error fetching visit changes',
    });
  }
});

/**
 * GET /api/vendor/machines/:machineId/history
 * Get full history for a machine (for detailed view)
 */
router.get('/machines/:machineId/history', async (req, res) => {
  try {
    const { machineId } = req.params;
    const { limit = 50, offset = 0 } = req.query;
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

    const result = await query(
      `SELECT id, action_type, details, created_at
       FROM machine_history
       WHERE machine_id = $1
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [machineId, parseInt(limit), parseInt(offset)]
    );

    const countResult = await query(
      'SELECT COUNT(*) as total FROM machine_history WHERE machine_id = $1',
      [machineId]
    );

    res.json({
      success: true,
      data: {
        history: result.rows,
        total: parseInt(countResult.rows[0].total),
        limit: parseInt(limit),
        offset: parseInt(offset)
      }
    });
  } catch (error) {
    logger.error('Error fetching machine history', { error: error.message });
    res.status(500).json({
      success: false,
      message: 'Error fetching machine history',
    });
  }
});

// ============================================
// PRODUCT SUGGESTIONS ROUTES
// ============================================

/**
 * GET /api/vendor/suggestions
 * Get all product suggestions across all machines
 */
router.get('/suggestions', async (req, res) => {
  try {
    const vendorId = req.user.id;
    const { status, machineId } = req.query;

    let whereClause = 'WHERE vm.vendor_id = $1';
    const params = [vendorId];

    if (status) {
      params.push(status);
      whereClause += ` AND ps.status = $${params.length}`;
    }

    if (machineId) {
      params.push(machineId);
      whereClause += ` AND ps.machine_id = $${params.length}`;
    }

    const result = await query(
      `SELECT ps.id, ps.machine_id, ps.suggestion_text, ps.status,
              ps.vendor_notes, ps.created_at, ps.reviewed_at,
              vm.machine_name, vm.location
       FROM product_suggestions ps
       JOIN vending_machines vm ON ps.machine_id = vm.id
       ${whereClause}
       ORDER BY ps.created_at DESC
       LIMIT 100`,
      params
    );

    // Get counts by status
    const countsResult = await query(
      `SELECT ps.status, COUNT(*) as count
       FROM product_suggestions ps
       JOIN vending_machines vm ON ps.machine_id = vm.id
       WHERE vm.vendor_id = $1
       GROUP BY ps.status`,
      [vendorId]
    );

    const counts = { pending: 0, reviewed: 0, added: 0, dismissed: 0 };
    countsResult.rows.forEach(row => {
      counts[row.status] = parseInt(row.count);
    });

    res.json({
      success: true,
      data: {
        suggestions: result.rows,
        counts,
        total: result.rows.length,
      },
    });
  } catch (error) {
    logger.error('Error fetching suggestions', { error: error.message });
    res.status(500).json({
      success: false,
      message: 'Error fetching suggestions',
    });
  }
});

/**
 * PUT /api/vendor/suggestions/:id
 * Update suggestion status (reviewed, added, dismissed)
 */
router.put('/suggestions/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const vendorId = req.user.id;

    const schema = Joi.object({
      status: Joi.string().valid('pending', 'reviewed', 'added', 'dismissed').required(),
      vendorNotes: Joi.string().allow('', null).max(500),
    });

    const { error, value } = schema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message,
      });
    }

    // Verify suggestion belongs to vendor's machine
    const suggestionCheck = await query(
      `SELECT ps.id FROM product_suggestions ps
       JOIN vending_machines vm ON ps.machine_id = vm.id
       WHERE ps.id = $1 AND vm.vendor_id = $2`,
      [id, vendorId]
    );

    if (suggestionCheck.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Suggestion not found',
      });
    }

    // Update suggestion
    const result = await query(
      `UPDATE product_suggestions
       SET status = $1, vendor_notes = $2, reviewed_at = NOW()
       WHERE id = $3
       RETURNING id, suggestion_text, status, vendor_notes, reviewed_at`,
      [value.status, value.vendorNotes || null, id]
    );

    res.json({
      success: true,
      message: 'Suggestion updated',
      data: { suggestion: result.rows[0] },
    });
  } catch (error) {
    logger.error('Error updating suggestion', { error: error.message });
    res.status(500).json({
      success: false,
      message: 'Error updating suggestion',
    });
  }
});

// ============================================
// EXPIRATION TRACKING ROUTES
// ============================================

/**
 * GET /api/vendor/expiring-products
 * Get products expiring within the next 14 days
 */
router.get('/expiring-products', async (req, res) => {
  try {
    const vendorId = req.user.id;
    const { days = 14 } = req.query;

    const result = await query(
      `SELECT mp.id as inventory_id, mp.machine_id, mp.product_id,
              mp.current_stock, mp.expiration_date,
              mp.expiration_date - CURRENT_DATE as days_until_expiration,
              p.product_name, p.image_url,
              vm.machine_name, vm.location
       FROM machine_products mp
       JOIN products p ON mp.product_id = p.id
       JOIN vending_machines vm ON mp.machine_id = vm.id
       WHERE vm.vendor_id = $1
         AND mp.expiration_date IS NOT NULL
         AND mp.expiration_date <= CURRENT_DATE + INTERVAL '1 day' * $2
         AND mp.current_stock > 0
       ORDER BY mp.expiration_date ASC`,
      [vendorId, parseInt(days)]
    );

    // Categorize by urgency
    const expired = result.rows.filter(r => r.days_until_expiration < 0);
    const expiringSoon = result.rows.filter(r => r.days_until_expiration >= 0 && r.days_until_expiration <= 3);
    const expiringLater = result.rows.filter(r => r.days_until_expiration > 3);

    res.json({
      success: true,
      data: {
        products: result.rows,
        summary: {
          expired: expired.length,
          expiringSoon: expiringSoon.length,
          expiringLater: expiringLater.length,
          total: result.rows.length,
        },
        categories: {
          expired,
          expiringSoon,
          expiringLater,
        },
      },
    });
  } catch (error) {
    logger.error('Error fetching expiring products', { error: error.message });
    res.status(500).json({
      success: false,
      message: 'Error fetching expiring products',
    });
  }
});

/**
 * PUT /api/vendor/machines/:machineId/inventory/:id/expiration
 * Update expiration date for an inventory item
 */
router.put('/machines/:machineId/inventory/:id/expiration', async (req, res) => {
  try {
    const { machineId, id } = req.params;
    const vendorId = req.user.id;

    const schema = Joi.object({
      expirationDate: Joi.date().allow(null),
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
      [machineId, vendorId]
    );

    if (machineCheck.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Machine not found',
      });
    }

    // Update expiration date
    const result = await query(
      `UPDATE machine_products
       SET expiration_date = $1, updated_at = NOW()
       WHERE id = $2 AND machine_id = $3
       RETURNING id, product_id, expiration_date`,
      [value.expirationDate || null, id, machineId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Inventory item not found',
      });
    }

    res.json({
      success: true,
      message: 'Expiration date updated',
      data: { item: result.rows[0] },
    });
  } catch (error) {
    logger.error('Error updating expiration date', { error: error.message });
    res.status(500).json({
      success: false,
      message: 'Error updating expiration date',
    });
  }
});

module.exports = router;
