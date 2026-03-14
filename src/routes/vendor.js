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

// Helper: Verify machine belongs to vendor (returns true or sends 404 response)
async function verifyMachineOwnership(machineId, vendorId, res) {
  const result = await query(
    'SELECT id FROM vending_machines WHERE id = $1 AND vendor_id = $2',
    [machineId, vendorId]
  );
  if (result.rows.length === 0) {
    res.status(404).json({ success: false, message: 'Vending machine not found' });
    return false;
  }
  return true;
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
    if (!await verifyMachineOwnership(id, req.user.id, res)) return;

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

    // Get inventory with performance history counts from product_performance_log
    const result = await query(
      `SELECT mp.id, mp.machine_id, mp.product_id, mp.current_stock,
              mp.is_performing, mp.performance_marked_at, mp.expiration_date,
              mp.expiration_date - CURRENT_DATE as days_until_expiration,
              p.product_name, p.description, p.price, p.image_url, p.category,
              COALESCE(ph.yes_count, 0)::int as performance_yes_count,
              COALESCE(ph.no_count, 0)::int as performance_no_count
       FROM machine_products mp
       JOIN products p ON mp.product_id = p.id
       LEFT JOIN (
         SELECT machine_product_id,
                COUNT(*) FILTER (WHERE is_performing = true) as yes_count,
                COUNT(*) FILTER (WHERE is_performing = false) as no_count
         FROM product_performance_log
         WHERE machine_product_id IN (SELECT id FROM machine_products WHERE machine_id = $1)
         GROUP BY machine_product_id
       ) ph ON mp.id = ph.machine_product_id
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
      sourceType: Joi.string().valid('warehouse', 'direct').default('warehouse'),
    });

    const { error, value } = schema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message,
      });
    }

    // Verify machine belongs to vendor
    if (!await verifyMachineOwnership(machineId, req.user.id, res)) return;

    // Check inventory limit (40 products max)
    const countCheck = await query(
      'SELECT COUNT(*) as count FROM machine_products WHERE machine_id = $1',
      [machineId]
    );

    if (parseInt(countCheck.rows[0].count) >= 60) {
      return res.status(400).json({
        success: false,
        message: 'Machine inventory limit reached (60 products max)',
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

    const { productId, stockQuantity, sourceType } = value;

    // Get product name for history logging
    const productInfo = await query(
      'SELECT product_name FROM products WHERE id = $1',
      [productId]
    );
    const productName = productInfo.rows[0]?.product_name || 'Unknown';

    const vendorId = req.user.id;

    // Use transaction for warehouse deduction
    const result = await transaction(async (client) => {
      // If sourcing from warehouse and adding stock, deduct from central inventory
      if (sourceType === 'warehouse' && stockQuantity > 0) {
        const centralRow = await client.query(
          `SELECT id, quantity_on_hand FROM vendor_inventory
           WHERE vendor_id = $1 AND product_id = $2 FOR UPDATE`,
          [vendorId, productId]
        );

        // Grace condition: if no vendor_inventory row exists, proceed without deduction
        if (centralRow.rows.length > 0) {
          const centralStock = centralRow.rows[0].quantity_on_hand;
          if (centralStock < stockQuantity) {
            throw new Error(`Insufficient stock on hand. Available: ${centralStock}, requested: ${stockQuantity}`);
          }

          await client.query(
            `UPDATE vendor_inventory
             SET quantity_on_hand = quantity_on_hand - $1, updated_at = CURRENT_TIMESTAMP
             WHERE vendor_id = $2 AND product_id = $3`,
            [stockQuantity, vendorId, productId]
          );

          await client.query(
            `INSERT INTO inventory_transactions
             (vendor_id, product_id, transaction_type, quantity, quantity_before, quantity_after, machine_id, notes)
             VALUES ($1, $2, 'dispersal_to_machine', $3, $4, $5, $6, $7)`,
            [vendorId, productId, -stockQuantity, centralStock, centralStock - stockQuantity, machineId, `Added to machine with ${stockQuantity} units`]
          );
        }
      } else if (sourceType === 'direct' && stockQuantity > 0) {
        // Log direct-to-machine transaction for audit (no deduction)
        await client.query(
          `INSERT INTO inventory_transactions
           (vendor_id, product_id, transaction_type, quantity, quantity_before, quantity_after, machine_id, notes)
           VALUES ($1, $2, 'direct_to_machine', $3, 0, 0, $4, $5)`,
          [vendorId, productId, stockQuantity, machineId, 'Direct purchase to machine']
        );
      }

      const insertResult = await client.query(
        `INSERT INTO machine_products (machine_id, product_id, current_stock)
         VALUES ($1, $2, $3)
         RETURNING *`,
        [machineId, productId, stockQuantity]
      );

      return insertResult.rows[0];
    });

    // Log to machine_history for visit memory
    await logMachineHistory(machineId, req.user.id, 'product_added', {
      product_id: productId,
      product_name: productName,
      initial_stock: stockQuantity,
      source_type: sourceType,
      inventory_id: result.id
    });

    // Update last visit timestamp
    updateLastVisit(machineId);

    res.status(201).json({
      success: true,
      message: 'Product added to machine inventory',
      data: { inventoryItem: result },
    });
  } catch (error) {
    logger.error('Error adding to inventory', { error: error.message });
    if (error.message && error.message.includes('unique')) {
      return res.status(409).json({
        success: false,
        message: 'Product already exists in this machine',
      });
    }
    if (error.message && error.message.includes('Insufficient stock on hand')) {
      return res.status(400).json({
        success: false,
        message: error.message,
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
      sourceType: Joi.string().valid('warehouse', 'direct').default('warehouse'),
    });

    const { error, value } = schema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message,
      });
    }

    // Verify machine belongs to vendor
    if (!await verifyMachineOwnership(machineId, req.user.id, res)) return;

    if (value.stockQuantity === undefined) {
      return res.status(400).json({
        success: false,
        message: 'No fields to update',
      });
    }

    const vendorId = req.user.id;
    const { stockQuantity, sourceType } = value;

    const result = await transaction(async (client) => {
      // Get current stock level and product_id
      const current = await client.query(
        `SELECT id, current_stock, product_id FROM machine_products
         WHERE id = $1 AND machine_id = $2 FOR UPDATE`,
        [id, machineId]
      );

      if (current.rows.length === 0) {
        throw new Error('NOT_FOUND');
      }

      const currentStock = current.rows[0].current_stock;
      const productId = current.rows[0].product_id;
      const delta = stockQuantity - currentStock;

      // If stock is increasing, handle warehouse deduction
      if (delta > 0) {
        if (sourceType === 'warehouse') {
          const centralRow = await client.query(
            `SELECT id, quantity_on_hand FROM vendor_inventory
             WHERE vendor_id = $1 AND product_id = $2 FOR UPDATE`,
            [vendorId, productId]
          );

          // Grace condition: if no vendor_inventory row exists, proceed without deduction
          if (centralRow.rows.length > 0) {
            const centralStock = centralRow.rows[0].quantity_on_hand;
            if (centralStock < delta) {
              throw new Error(`Insufficient stock on hand. Available: ${centralStock}, requested: ${delta}`);
            }

            await client.query(
              `UPDATE vendor_inventory
               SET quantity_on_hand = quantity_on_hand - $1, updated_at = CURRENT_TIMESTAMP
               WHERE vendor_id = $2 AND product_id = $3`,
              [delta, vendorId, productId]
            );

            await client.query(
              `INSERT INTO inventory_transactions
               (vendor_id, product_id, transaction_type, quantity, quantity_before, quantity_after, machine_id, notes)
               VALUES ($1, $2, 'dispersal_to_machine', $3, $4, $5, $6, $7)`,
              [vendorId, productId, -delta, centralStock, centralStock - delta, machineId, `Restocked machine: ${currentStock} -> ${stockQuantity}`]
            );
          }
        } else if (sourceType === 'direct') {
          await client.query(
            `INSERT INTO inventory_transactions
             (vendor_id, product_id, transaction_type, quantity, quantity_before, quantity_after, machine_id, notes)
             VALUES ($1, $2, 'direct_to_machine', $3, 0, 0, $4, $5)`,
            [vendorId, productId, delta, machineId, `Direct restock: ${currentStock} -> ${stockQuantity}`]
          );
        }
      } else if (delta < 0) {
        // Stock decreased — record as sold/consumed from machine
        const sold = Math.abs(delta);
        await client.query(
          `INSERT INTO inventory_transactions
           (vendor_id, product_id, transaction_type, quantity, quantity_before, quantity_after, machine_id, notes)
           VALUES ($1, $2, 'sold_from_machine', $3, $4, $5, $6, $7)`,
          [vendorId, productId, -sold, currentStock, stockQuantity, machineId, `Sold/consumed: ${currentStock} -> ${stockQuantity} (${sold} units)`]
        );
      }

      const updateResult = await client.query(
        `UPDATE machine_products SET current_stock = $1 WHERE id = $2 AND machine_id = $3 RETURNING *`,
        [stockQuantity, id, machineId]
      );

      return updateResult.rows[0];
    });

    res.json({
      success: true,
      message: 'Inventory updated successfully',
      data: { inventoryItem: result },
    });
  } catch (error) {
    if (error.message === 'NOT_FOUND') {
      return res.status(404).json({
        success: false,
        message: 'Inventory item not found',
      });
    }
    if (error.message && error.message.includes('Insufficient stock on hand')) {
      return res.status(400).json({
        success: false,
        message: error.message,
      });
    }
    logger.error('Error updating inventory', { error: error.message });
    res.status(500).json({
      success: false,
      message: 'Error updating inventory',
    });
  }
});

/**
 * POST /api/vendor/machines/:machineId/visit-restock
 * Batch reconcile inventory and restock when visiting a machine
 */
router.post('/machines/:machineId/visit-restock', async (req, res) => {
  try {
    const { machineId } = req.params;
    const vendorId = req.user.id;

    // Validate request body
    const schema = Joi.object({
      items: Joi.array().items(
        Joi.object({
          inventoryId: Joi.number().integer().required(),
          remaining: Joi.number().integer().min(0).required(),
          restockQuantity: Joi.number().integer().min(0).required(),
        })
      ).min(1).required(),
    });

    const { error, value } = schema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message,
      });
    }

    // Verify machine belongs to vendor
    if (!await verifyMachineOwnership(machineId, vendorId, res)) return;

    const result = await transaction(async (client) => {
      const processedItems = [];
      let totalSold = 0;
      let totalRestocked = 0;
      let warehouseDeducted = 0;

      for (const item of value.items) {
        const { inventoryId, remaining, restockQuantity } = item;

        // Look up machine_products row and verify ownership
        const mpResult = await client.query(
          `SELECT mp.id, mp.current_stock, mp.product_id, p.product_name
           FROM machine_products mp
           JOIN products p ON mp.product_id = p.id
           WHERE mp.id = $1 AND mp.machine_id = $2 AND p.vendor_id = $3
             AND (mp.is_deleted = false OR mp.is_deleted IS NULL)
           FOR UPDATE`,
          [inventoryId, machineId, vendorId]
        );

        if (mpResult.rows.length === 0) {
          throw new Error(`INVALID_ITEM:${inventoryId}`);
        }

        const { current_stock: currentStock, product_id: productId, product_name: productName } = mpResult.rows[0];
        let runningStock = currentStock;

        // Step 1: Reconcile sold units
        const sold = currentStock > remaining ? currentStock - remaining : 0;
        if (sold > 0) {
          await client.query(
            `INSERT INTO inventory_transactions
             (vendor_id, product_id, transaction_type, quantity, quantity_before, quantity_after, machine_id, notes)
             VALUES ($1, $2, 'sold_from_machine', $3, $4, $5, $6, $7)`,
            [vendorId, productId, -sold, currentStock, remaining, machineId,
             `Visit reconciliation: ${currentStock} -> ${remaining} (${sold} sold)`]
          );
          totalSold += sold;
        }

        // Update current_stock to remaining
        runningStock = remaining;
        await client.query(
          `UPDATE machine_products SET current_stock = $1 WHERE id = $2 AND machine_id = $3`,
          [remaining, inventoryId, machineId]
        );

        // Step 2: Restock
        let restockType = null;
        if (restockQuantity > 0) {
          // Try to deduct from vendor_inventory
          const centralRow = await client.query(
            `SELECT id, quantity_on_hand FROM vendor_inventory
             WHERE vendor_id = $1 AND product_id = $2 FOR UPDATE`,
            [vendorId, productId]
          );

          if (centralRow.rows.length > 0 && centralRow.rows[0].quantity_on_hand >= restockQuantity) {
            // Deduct from warehouse
            const centralStock = centralRow.rows[0].quantity_on_hand;
            await client.query(
              `UPDATE vendor_inventory
               SET quantity_on_hand = quantity_on_hand - $1, updated_at = CURRENT_TIMESTAMP
               WHERE vendor_id = $2 AND product_id = $3`,
              [restockQuantity, vendorId, productId]
            );

            await client.query(
              `INSERT INTO inventory_transactions
               (vendor_id, product_id, transaction_type, quantity, quantity_before, quantity_after, machine_id, notes)
               VALUES ($1, $2, 'dispersal_to_machine', $3, $4, $5, $6, $7)`,
              [vendorId, productId, restockQuantity, remaining, remaining + restockQuantity, machineId,
               `Visit restock: ${remaining} -> ${remaining + restockQuantity}`]
            );

            restockType = 'dispersal_to_machine';
            warehouseDeducted += restockQuantity;
          } else {
            // No warehouse row or insufficient stock — log as direct_to_machine
            await client.query(
              `INSERT INTO inventory_transactions
               (vendor_id, product_id, transaction_type, quantity, quantity_before, quantity_after, machine_id, notes)
               VALUES ($1, $2, 'direct_to_machine', $3, $4, $5, $6, $7)`,
              [vendorId, productId, restockQuantity, remaining, remaining + restockQuantity, machineId,
               `Visit restock (direct): ${remaining} -> ${remaining + restockQuantity}`]
            );

            restockType = 'direct_to_machine';
          }

          // Add restock to machine stock
          await client.query(
            `UPDATE machine_products SET current_stock = current_stock + $1 WHERE id = $2 AND machine_id = $3`,
            [restockQuantity, inventoryId, machineId]
          );

          runningStock = remaining + restockQuantity;
          totalRestocked += restockQuantity;
        }

        processedItems.push({
          inventoryId,
          productName,
          previousStock: currentStock,
          remaining,
          sold,
          restocked: restockQuantity,
          newStock: runningStock,
          restockType,
        });
      }

      return { processedItems, totalSold, totalRestocked, warehouseDeducted };
    });

    // Log machine_history entry
    await logMachineHistory(machineId, vendorId, 'visit', {
      productsReconciled: result.processedItems.length,
      totalSold: result.totalSold,
      totalRestocked: result.totalRestocked,
      warehouseDeducted: result.warehouseDeducted,
      items: result.processedItems.map(i => ({
        inventoryId: i.inventoryId,
        productName: i.productName,
        sold: i.sold,
        restocked: i.restocked,
        newStock: i.newStock,
      })),
    });

    // Update last visit timestamp
    updateLastVisit(machineId);

    res.json({
      success: true,
      data: {
        summary: {
          productsReconciled: result.processedItems.length,
          totalSold: result.totalSold,
          totalRestocked: result.totalRestocked,
          warehouseDeducted: result.warehouseDeducted,
        },
        items: result.processedItems,
      },
    });
  } catch (error) {
    if (error.message && error.message.startsWith('INVALID_ITEM:')) {
      const badId = error.message.split(':')[1];
      return res.status(400).json({
        success: false,
        message: `Inventory item ${badId} not found in this machine`,
      });
    }
    logger.error('Error processing visit-restock', { error: error.message });
    res.status(500).json({
      success: false,
      message: 'Error processing visit restock',
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
    if (!await verifyMachineOwnership(machineId, req.user.id, res)) return;

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
 * POST /api/vendor/machines/:machineId/performance-commit
 * Batch commit all performance marks for a visit
 */
router.post('/machines/:machineId/performance-commit', async (req, res) => {
  try {
    const { machineId } = req.params;
    const schema = Joi.object({
      marks: Joi.array().items(
        Joi.object({
          inventoryId: Joi.number().integer().required(),
          isPerforming: Joi.boolean().required(),
        })
      ).min(1).required(),
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
      'SELECT id, machine_name FROM vending_machines WHERE id = $1 AND vendor_id = $2',
      [machineId, req.user.id]
    );

    if (machineCheck.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Vending machine not found',
      });
    }

    const { marks } = value;

    const result = await transaction(async (client) => {
      // Verify all inventory IDs belong to this machine and get product names
      const inventoryIds = marks.map(m => m.inventoryId);
      const inventoryCheck = await client.query(
        `SELECT mp.id, mp.product_id, p.product_name
         FROM machine_products mp
         JOIN products p ON mp.product_id = p.id
         WHERE mp.id = ANY($1) AND mp.machine_id = $2
           AND (mp.is_deleted = false OR mp.is_deleted IS NULL)`,
        [inventoryIds, machineId]
      );

      if (inventoryCheck.rows.length !== inventoryIds.length) {
        throw new Error('One or more inventory items not found in this machine');
      }

      const inventoryMap = {};
      for (const row of inventoryCheck.rows) {
        inventoryMap[row.id] = row;
      }

      // Process each mark: log to performance_log, then reset is_performing to NULL
      for (const mark of marks) {
        const item = inventoryMap[mark.inventoryId];

        // Insert into performance log
        await client.query(
          `INSERT INTO product_performance_log (machine_product_id, is_performing, marked_by)
           VALUES ($1, $2, $3)`,
          [mark.inventoryId, mark.isPerforming, req.user.id]
        );

        // Update is_performing with the committed value and timestamp
        await client.query(
          `UPDATE machine_products
           SET is_performing = $2, performance_marked_at = CURRENT_TIMESTAMP
           WHERE id = $1`,
          [mark.inventoryId, mark.isPerforming]
        );
      }

      // Log to machine_history
      const details = marks.map(m => ({
        inventory_id: m.inventoryId,
        product_id: inventoryMap[m.inventoryId].product_id,
        product_name: inventoryMap[m.inventoryId].product_name,
        is_performing: m.isPerforming,
      }));

      await client.query(
        `INSERT INTO machine_history (machine_id, vendor_id, action_type, details)
         VALUES ($1, $2, $3, $4)`,
        [machineId, req.user.id, 'performance_commit', JSON.stringify({ marks: details })]
      );

      // Update last_visit_at
      await client.query(
        `UPDATE vending_machines SET last_visit_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [machineId]
      );

      // Return updated inventory with tally counts
      const updatedInventory = await client.query(
        `SELECT mp.id, mp.machine_id, mp.product_id, mp.current_stock,
                mp.is_performing, mp.performance_marked_at, mp.expiration_date,
                mp.expiration_date - CURRENT_DATE as days_until_expiration,
                p.product_name, p.description, p.price, p.image_url, p.category,
                COALESCE(ph.yes_count, 0)::int as performance_yes_count,
                COALESCE(ph.no_count, 0)::int as performance_no_count
         FROM machine_products mp
         JOIN products p ON mp.product_id = p.id
         LEFT JOIN (
           SELECT machine_product_id,
                  COUNT(*) FILTER (WHERE is_performing = true) as yes_count,
                  COUNT(*) FILTER (WHERE is_performing = false) as no_count
           FROM product_performance_log
           WHERE machine_product_id IN (SELECT id FROM machine_products WHERE machine_id = $1)
           GROUP BY machine_product_id
         ) ph ON mp.id = ph.machine_product_id
         WHERE mp.machine_id = $1 AND (mp.is_deleted = false OR mp.is_deleted IS NULL)
         ORDER BY p.product_name`,
        [machineId]
      );

      return updatedInventory.rows;
    });

    res.json({
      success: true,
      message: `Visit committed: ${marks.length} product(s) marked`,
      data: { inventory: result },
    });
  } catch (error) {
    logger.error('Error committing performance visit', { error: error.message });
    res.status(error.message.includes('not found') ? 400 : 500).json({
      success: false,
      message: error.message || 'Error committing performance visit',
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
    if (!await verifyMachineOwnership(machineId, req.user.id, res)) return;

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
    if (!await verifyMachineOwnership(machineId, vendorId, res)) return;

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
// SHOPPING LIST (Performance-Based)
// ========================================

/**
 * GET /api/vendor/shopping-list
 * Products performing well across all machines, based on vendor performance marks
 */
router.get('/shopping-list', async (req, res) => {
  try {
    const vendorId = req.user.id;

    const result = await query(
      `SELECT
         p.product_name,
         p.category,
         COUNT(*) FILTER (WHERE ppl.is_performing = true) as total_yes,
         COUNT(*) FILTER (WHERE ppl.is_performing = false) as total_no,
         COUNT(*) as total_marks,
         COUNT(DISTINCT mp.machine_id) as machine_count,
         ROUND(
           COUNT(*) FILTER (WHERE ppl.is_performing = true) * 100.0 / NULLIF(COUNT(*), 0)
         ) as approval_rate
       FROM product_performance_log ppl
       JOIN machine_products mp ON ppl.machine_product_id = mp.id
       JOIN products p ON mp.product_id = p.id
       JOIN vending_machines vm ON mp.machine_id = vm.id
       WHERE vm.vendor_id = $1
         AND (mp.is_deleted = false OR mp.is_deleted IS NULL)
       GROUP BY p.id, p.product_name, p.category
       HAVING COUNT(*) >= 5 AND COUNT(*) FILTER (WHERE ppl.is_performing = true) >= 1
       ORDER BY COUNT(*) FILTER (WHERE ppl.is_performing = true) DESC,
                ROUND(COUNT(*) FILTER (WHERE ppl.is_performing = true) * 100.0 / NULLIF(COUNT(*), 0)) DESC`,
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
    logger.error('Error fetching shopping list', { error: error.message });
    res.status(500).json({
      success: false,
      message: 'Error fetching shopping list',
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

        if (parseInt(countCheck.rows[0].count) >= 60) {
          throw new Error('Target machine has reached maximum product limit (60)');
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
 * POST /api/vendor/redistribution/batch
 * Execute multiple product redistributions atomically
 */
router.post('/redistribution/batch', async (req, res) => {
  try {
    const moveSchema = Joi.object({
      sourceMachineId: Joi.number().integer().required(),
      targetMachineId: Joi.number().integer().required(),
      productId: Joi.number().integer().required(),
      quantity: Joi.number().integer().min(1).required(),
    });

    const schema = Joi.object({
      moves: Joi.array().items(moveSchema).min(1).max(50).required(),
      reason: Joi.string().max(500).optional(),
    });

    const { error, value } = schema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message,
      });
    }

    const { moves, reason } = value;

    // Validate no move has same source and target
    for (let i = 0; i < moves.length; i++) {
      if (moves[i].sourceMachineId === moves[i].targetMachineId) {
        return res.status(400).json({
          success: false,
          message: `Move ${i + 1}: Source and target machines must be different`,
        });
      }
    }

    const result = await transaction(async (client) => {
      // Bulk-verify all unique machines belong to vendor
      const allMachineIds = [...new Set(moves.flatMap(m => [m.sourceMachineId, m.targetMachineId]))];
      const machinesCheck = await client.query(
        `SELECT id, machine_name FROM vending_machines
         WHERE id = ANY($1) AND vendor_id = $2`,
        [allMachineIds, req.user.id]
      );
      if (machinesCheck.rows.length !== allMachineIds.length) {
        throw new Error('One or more machines not found or not owned by vendor');
      }
      const machineNames = Object.fromEntries(machinesCheck.rows.map(r => [r.id, r.machine_name]));

      // Bulk-verify all unique products belong to vendor
      const allProductIds = [...new Set(moves.map(m => m.productId))];
      const productsCheck = await client.query(
        'SELECT id, product_name FROM products WHERE id = ANY($1) AND vendor_id = $2',
        [allProductIds, req.user.id]
      );
      if (productsCheck.rows.length !== allProductIds.length) {
        throw new Error('One or more products not found or not owned by vendor');
      }
      const productNames = Object.fromEntries(productsCheck.rows.map(r => [r.id, r.product_name]));

      const moveResults = [];
      let totalUnitsTransferred = 0;

      for (let i = 0; i < moves.length; i++) {
        const move = moves[i];

        // Get source inventory with lock — reads committed writes from prior moves in this txn
        const sourceInventory = await client.query(
          `SELECT id, current_stock FROM machine_products
           WHERE machine_id = $1 AND product_id = $2 FOR UPDATE`,
          [move.sourceMachineId, move.productId]
        );

        if (sourceInventory.rows.length === 0) {
          throw new Error(`Move ${i + 1}: Product "${productNames[move.productId]}" not found in source machine "${machineNames[move.sourceMachineId]}"`);
        }

        const sourceStock = sourceInventory.rows[0].current_stock;

        if (sourceStock < move.quantity) {
          throw new Error(`Move ${i + 1}: Insufficient stock for "${productNames[move.productId]}" in "${machineNames[move.sourceMachineId]}". Available: ${sourceStock}, requested: ${move.quantity}`);
        }

        // Get or create target inventory
        let targetInventory = await client.query(
          `SELECT id, current_stock FROM machine_products
           WHERE machine_id = $1 AND product_id = $2 FOR UPDATE`,
          [move.targetMachineId, move.productId]
        );

        let targetStockBefore;
        let targetInventoryId;

        if (targetInventory.rows.length === 0) {
          const countCheck = await client.query(
            'SELECT COUNT(*) as count FROM machine_products WHERE machine_id = $1',
            [move.targetMachineId]
          );

          if (parseInt(countCheck.rows[0].count) >= 60) {
            throw new Error(`Move ${i + 1}: Target machine "${machineNames[move.targetMachineId]}" has reached maximum product limit (60)`);
          }

          const newEntry = await client.query(
            `INSERT INTO machine_products (machine_id, product_id, current_stock)
             VALUES ($1, $2, 0) RETURNING id, current_stock`,
            [move.targetMachineId, move.productId]
          );
          targetInventoryId = newEntry.rows[0].id;
          targetStockBefore = 0;
        } else {
          targetInventoryId = targetInventory.rows[0].id;
          targetStockBefore = targetInventory.rows[0].current_stock;
        }

        const newSourceStock = sourceStock - move.quantity;

        // Update source stock
        if (newSourceStock === 0) {
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
        const newTargetStock = targetStockBefore + move.quantity;
        await client.query(
          'UPDATE machine_products SET current_stock = $1 WHERE id = $2',
          [newTargetStock, targetInventoryId]
        );

        // Record in audit log
        await client.query(
          `INSERT INTO product_redistributions
           (source_machine_id, target_machine_id, product_id, quantity_transferred,
            reason, performed_by, source_stock_before, source_stock_after,
            target_stock_before, target_stock_after)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [
            move.sourceMachineId, move.targetMachineId, move.productId, move.quantity,
            reason || null, req.user.id,
            sourceStock, newSourceStock,
            targetStockBefore, newTargetStock
          ]
        );

        totalUnitsTransferred += move.quantity;
        moveResults.push({
          productName: productNames[move.productId],
          quantity: move.quantity,
          sourceMachine: machineNames[move.sourceMachineId],
          targetMachine: machineNames[move.targetMachineId],
          sourceStockBefore: sourceStock,
          sourceStockAfter: newSourceStock,
          targetStockBefore,
          targetStockAfter: newTargetStock,
        });
      }

      return { totalMoves: moves.length, totalUnitsTransferred, moves: moveResults };
    });

    res.json({
      success: true,
      message: `Successfully completed ${result.totalMoves} transfers (${result.totalUnitsTransferred} total units)`,
      data: result,
    });
  } catch (error) {
    logger.error('Error executing batch redistribution', { error: error.message });
    res.status(error.message.includes('not found') || error.message.includes('Insufficient') || error.message.includes('Move ') ? 400 : 500).json({
      success: false,
      message: error.message || 'Error executing batch redistribution',
    });
  }
});

/**
 * GET /api/vendor/machines/:machineId/auto-distribute
 * Suggest redistribution moves for non-performing products based on performance data
 */
router.get('/machines/:machineId/auto-distribute', async (req, res) => {
  try {
    const machineId = parseInt(req.params.machineId);

    // Verify machine ownership
    const machineCheck = await query(
      'SELECT id, machine_name FROM vending_machines WHERE id = $1 AND vendor_id = $2',
      [machineId, req.user.id]
    );
    if (machineCheck.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Machine not found' });
    }

    // Get non-performing products in this machine
    const nonPerforming = await query(
      `SELECT mp.product_id, p.product_name, mp.current_stock
       FROM machine_products mp
       JOIN products p ON mp.product_id = p.id
       WHERE mp.machine_id = $1 AND mp.is_performing = false AND mp.current_stock > 0
       ORDER BY p.product_name`,
      [machineId]
    );

    if (nonPerforming.rows.length === 0) {
      return res.json({
        success: true,
        data: { moves: [], summary: { totalProducts: 0, totalUnits: 0, skipped: [] } },
      });
    }

    // Get all other active machines for this vendor
    const otherMachines = await query(
      'SELECT id, machine_name FROM vending_machines WHERE vendor_id = $1 AND id != $2 AND is_active = true ORDER BY machine_name',
      [req.user.id, machineId]
    );

    // For each non-performing product, find where it performs well across other machines
    // Use performance log history + current is_performing flag
    const productIds = nonPerforming.rows.map(r => r.product_id);
    const performanceData = await query(
      `SELECT mp.machine_id, mp.product_id, mp.current_stock, mp.is_performing,
              vm.machine_name,
              (SELECT COUNT(*) FROM product_performance_log ppl
               JOIN machine_products mp2 ON ppl.machine_product_id = mp2.id
               WHERE mp2.machine_id = mp.machine_id AND mp2.product_id = mp.product_id
               AND ppl.is_performing = true) as positive_marks,
              (SELECT COUNT(*) FROM product_performance_log ppl
               JOIN machine_products mp2 ON ppl.machine_product_id = mp2.id
               WHERE mp2.machine_id = mp.machine_id AND mp2.product_id = mp.product_id
               AND ppl.is_performing = false) as negative_marks
       FROM machine_products mp
       JOIN vending_machines vm ON mp.machine_id = vm.id
       WHERE mp.product_id = ANY($1) AND vm.vendor_id = $2 AND mp.machine_id != $3
         AND vm.is_active = true
       ORDER BY mp.product_id, positive_marks DESC`,
      [productIds, req.user.id, machineId]
    );

    // Build a map: productId → [{ machineId, machineName, positiveMarks, negativeMarks, isPerforming, currentStock }]
    const perfMap = {};
    performanceData.rows.forEach(r => {
      if (!perfMap[r.product_id]) perfMap[r.product_id] = [];
      perfMap[r.product_id].push({
        machineId: r.machine_id,
        machineName: r.machine_name,
        currentStock: r.current_stock,
        isPerforming: r.is_performing,
        positiveMarks: parseInt(r.positive_marks),
        negativeMarks: parseInt(r.negative_marks),
      });
    });

    const moves = [];
    const skipped = [];

    for (const product of nonPerforming.rows) {
      const targets = perfMap[product.product_id] || [];

      // Filter to machines where product is currently performing OR has more positive than negative marks
      const goodTargets = targets.filter(t =>
        t.isPerforming === true || (t.positiveMarks > t.negativeMarks && t.positiveMarks > 0)
      );

      // Also include machines that don't have this product yet (potential new placement)
      // but only if there are no performing targets at all
      const otherMachineIds = otherMachines.rows.map(m => m.id);
      const machinesWithProduct = targets.map(t => t.machineId);
      const machinesWithout = otherMachines.rows.filter(m => !machinesWithProduct.includes(m.id));

      let finalTargets = goodTargets.length > 0 ? goodTargets : [];

      if (finalTargets.length === 0) {
        // No performing targets — skip this product
        skipped.push({
          productId: product.product_id,
          productName: product.product_name.trim(),
          stock: product.current_stock,
          reason: 'Not performing well in any machine',
        });
        continue;
      }

      // Sort targets: currently performing first, then by positive marks desc, then lowest stock first
      finalTargets.sort((a, b) => {
        if (a.isPerforming && !b.isPerforming) return -1;
        if (!a.isPerforming && b.isPerforming) return 1;
        if (b.positiveMarks !== a.positiveMarks) return b.positiveMarks - a.positiveMarks;
        return a.currentStock - b.currentStock;
      });

      // Distribute evenly across targets
      let remaining = product.current_stock;
      const numTargets = finalTargets.length;
      const baseAmount = Math.floor(remaining / numTargets);
      let extra = remaining % numTargets;

      for (const target of finalTargets) {
        if (remaining <= 0) break;
        const qty = baseAmount + (extra > 0 ? 1 : 0);
        if (extra > 0) extra--;
        if (qty > 0) {
          moves.push({
            sourceMachineId: machineId,
            targetMachineId: target.machineId,
            productId: product.product_id,
            productName: product.product_name.trim(),
            quantity: qty,
            targetMachineName: target.machineName.trim(),
            targetCurrentStock: target.currentStock,
            targetIsPerforming: target.isPerforming,
            targetPositiveMarks: target.positiveMarks,
          });
          remaining -= qty;
        }
      }
    }

    res.json({
      success: true,
      data: {
        sourceMachine: machineCheck.rows[0].machine_name.trim(),
        moves,
        summary: {
          totalProducts: nonPerforming.rows.length - skipped.length,
          totalUnits: moves.reduce((sum, m) => sum + m.quantity, 0),
          totalMoves: moves.length,
          skipped,
        },
      },
    });
  } catch (error) {
    logger.error('Error generating auto-distribute suggestions', { error: error.message });
    res.status(500).json({
      success: false,
      message: 'Error generating auto-distribute suggestions',
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
    if (!await verifyMachineOwnership(id, vendorId, res)) return;

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

/**
 * POST /api/vendor/machines/:id/notes
 * Add a new note entry for a machine
 */
router.post('/machines/:id/notes', async (req, res) => {
  try {
    const { id } = req.params;
    const vendorId = req.user.id;

    const schema = Joi.object({
      content: Joi.string().min(1).max(2000).required(),
    });

    const { error, value } = schema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message,
      });
    }

    if (!await verifyMachineOwnership(id, vendorId, res)) return;

    const result = await query(
      `INSERT INTO machine_notes (machine_id, vendor_id, content)
       VALUES ($1, $2, $3)
       RETURNING id, content, created_at`,
      [id, vendorId, value.content]
    );

    // Also update the machine's notes field with the latest note
    await query(
      `UPDATE vending_machines SET notes = $1, updated_at = NOW() WHERE id = $2`,
      [value.content, id]
    );

    res.status(201).json({
      success: true,
      message: 'Note added',
      data: { note: result.rows[0] },
    });
  } catch (error) {
    logger.error('Error adding machine note', { error: error.message });
    res.status(500).json({
      success: false,
      message: 'Error adding note',
    });
  }
});

/**
 * GET /api/vendor/machines/:id/notes
 * Get all notes for a machine (newest first)
 */
router.get('/machines/:id/notes', async (req, res) => {
  try {
    const { id } = req.params;
    const vendorId = req.user.id;

    if (!await verifyMachineOwnership(id, vendorId, res)) return;

    const result = await query(
      `SELECT id, content, created_at
       FROM machine_notes
       WHERE machine_id = $1
       ORDER BY created_at DESC`,
      [id]
    );

    res.json({
      success: true,
      data: { notes: result.rows },
    });
  } catch (error) {
    logger.error('Error fetching machine notes', { error: error.message });
    res.status(500).json({
      success: false,
      message: 'Error fetching notes',
    });
  }
});

/**
 * DELETE /api/vendor/machines/:id/notes/:noteId
 * Delete a specific note
 */
router.delete('/machines/:id/notes/:noteId', async (req, res) => {
  try {
    const { id, noteId } = req.params;
    const vendorId = req.user.id;

    if (!await verifyMachineOwnership(id, vendorId, res)) return;

    const result = await query(
      `DELETE FROM machine_notes WHERE id = $1 AND machine_id = $2 AND vendor_id = $3 RETURNING id`,
      [noteId, id, vendorId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: 'Note not found',
      });
    }

    res.json({
      success: true,
      message: 'Note deleted',
    });
  } catch (error) {
    logger.error('Error deleting machine note', { error: error.message });
    res.status(500).json({
      success: false,
      message: 'Error deleting note',
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
    if (!await verifyMachineOwnership(machineId, vendorId, res)) return;

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
    if (!await verifyMachineOwnership(machineId, vendorId, res)) return;

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

// ========================================
// CENTRAL INVENTORY ROUTES
// ========================================

/**
 * GET /api/vendor/inventory
 * List all central inventory with low-stock flags and summary
 */
router.get('/inventory', async (req, res) => {
  try {
    const vendorId = req.user.id;

    const result = await query(
      `SELECT vi.id, vi.product_id, vi.quantity_on_hand, vi.reorder_threshold,
              vi.created_at, vi.updated_at,
              p.product_name, p.category, p.image_url, p.price,
              COALESCE(field.in_field, 0)::int as in_field,
              (vi.quantity_on_hand + COALESCE(field.in_field, 0))::int as total_stock,
              CASE
                WHEN vi.quantity_on_hand = 0 THEN 'out'
                WHEN vi.quantity_on_hand <= vi.reorder_threshold THEN 'low'
                ELSE 'ok'
              END as stock_status,
              COALESCE(sales.sold_30d, 0)::int as sold_30d,
              COALESCE(sales.sold_7d, 0)::int as sold_7d,
              COALESCE(perf.machines_performing, 0)::int as machines_performing,
              COALESCE(perf.machines_total, 0)::int as machines_stocked
       FROM vendor_inventory vi
       JOIN products p ON vi.product_id = p.id
       LEFT JOIN (
         SELECT mp.product_id, SUM(mp.current_stock) as in_field
         FROM machine_products mp
         JOIN vending_machines vm ON mp.machine_id = vm.id
         WHERE vm.vendor_id = $1
           AND (mp.is_deleted = false OR mp.is_deleted IS NULL)
           AND (vm.is_deleted = false OR vm.is_deleted IS NULL)
         GROUP BY mp.product_id
       ) field ON vi.product_id = field.product_id
       LEFT JOIN (
         SELECT product_id,
                SUM(CASE WHEN created_at >= NOW() - INTERVAL '30 days' THEN ABS(quantity) ELSE 0 END) as sold_30d,
                SUM(CASE WHEN created_at >= NOW() - INTERVAL '7 days' THEN ABS(quantity) ELSE 0 END) as sold_7d
         FROM inventory_transactions
         WHERE vendor_id = $1 AND transaction_type = 'sold_from_machine'
         GROUP BY product_id
       ) sales ON vi.product_id = sales.product_id
       LEFT JOIN (
         SELECT mp.product_id,
                COUNT(*) as machines_total,
                COUNT(CASE WHEN mp.is_performing = true THEN 1 END) as machines_performing
         FROM machine_products mp
         JOIN vending_machines vm ON mp.machine_id = vm.id
         WHERE vm.vendor_id = $1
           AND (mp.is_deleted = false OR mp.is_deleted IS NULL)
           AND (vm.is_deleted = false OR vm.is_deleted IS NULL)
         GROUP BY mp.product_id
       ) perf ON vi.product_id = perf.product_id
       WHERE vi.vendor_id = $1
         AND (p.is_deleted = false OR p.is_deleted IS NULL)
       ORDER BY
         CASE
           WHEN vi.quantity_on_hand = 0 THEN 0
           WHEN vi.quantity_on_hand <= vi.reorder_threshold THEN 1
           ELSE 2
         END,
         p.product_name`,
      [vendorId]
    );

    // Calculate suggested reorder for each product
    result.rows.forEach(item => {
      const dailyRate = item.sold_30d > 0 ? item.sold_30d / 30 : 0;
      // Suggest enough to cover ~2 weeks of sales, rounded up to nearest 5
      const rawSuggestion = Math.ceil(dailyRate * 14);
      const suggested = rawSuggestion > 0 ? Math.ceil(rawSuggestion / 5) * 5 : 0;
      // Factor in performance: if performing well across machines, bump suggestion
      const perfRatio = item.machines_stocked > 0 ? item.machines_performing / item.machines_stocked : 0;
      const perfMultiplier = perfRatio >= 0.5 ? 1.2 : perfRatio > 0 ? 1.0 : 0.8;
      item.suggested_reorder = suggested > 0 ? Math.ceil(suggested * perfMultiplier) : item.reorder_threshold;
    });

    const totalInField = result.rows.reduce((sum, r) => sum + r.in_field, 0);
    const totalOnHand = result.rows.reduce((sum, r) => sum + r.quantity_on_hand, 0);

    const summary = {
      totalProducts: result.rows.length,
      outOfStock: result.rows.filter(r => r.stock_status === 'out').length,
      lowStock: result.rows.filter(r => r.stock_status === 'low').length,
      healthy: result.rows.filter(r => r.stock_status === 'ok').length,
      totalOnHand: totalOnHand,
      totalInField: totalInField,
      totalAll: totalOnHand + totalInField,
    };

    res.json({
      success: true,
      data: {
        inventory: result.rows,
        summary,
      },
    });
  } catch (error) {
    logger.error('Error fetching central inventory', { error: error.message });
    res.status(500).json({
      success: false,
      message: 'Error fetching central inventory',
    });
  }
});

/**
 * POST /api/vendor/inventory/purchase
 * Log a bulk purchase (upserts vendor_inventory, creates transaction)
 */
router.post('/inventory/purchase', async (req, res) => {
  try {
    const schema = Joi.object({
      productId: Joi.number().integer().required(),
      quantity: Joi.number().integer().min(1).required(),
      notes: Joi.string().max(500).allow('', null).optional(),
    });

    const { error, value } = schema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message,
      });
    }

    const vendorId = req.user.id;
    const { productId, quantity, notes } = value;

    // Verify product belongs to vendor
    const productCheck = await query(
      'SELECT id, product_name FROM products WHERE id = $1 AND vendor_id = $2',
      [productId, vendorId]
    );
    if (productCheck.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Product not found' });
    }

    const result = await transaction(async (client) => {
      // Upsert vendor_inventory
      const existing = await client.query(
        `SELECT id, quantity_on_hand FROM vendor_inventory
         WHERE vendor_id = $1 AND product_id = $2 FOR UPDATE`,
        [vendorId, productId]
      );

      let quantityBefore = 0;
      let inventoryRow;

      if (existing.rows.length === 0) {
        inventoryRow = await client.query(
          `INSERT INTO vendor_inventory (vendor_id, product_id, quantity_on_hand)
           VALUES ($1, $2, $3)
           RETURNING *`,
          [vendorId, productId, quantity]
        );
        quantityBefore = 0;
      } else {
        quantityBefore = existing.rows[0].quantity_on_hand;
        inventoryRow = await client.query(
          `UPDATE vendor_inventory
           SET quantity_on_hand = quantity_on_hand + $1, updated_at = CURRENT_TIMESTAMP
           WHERE vendor_id = $2 AND product_id = $3
           RETURNING *`,
          [quantity, vendorId, productId]
        );
      }

      // Log transaction
      await client.query(
        `INSERT INTO inventory_transactions
         (vendor_id, product_id, transaction_type, quantity, quantity_before, quantity_after, notes)
         VALUES ($1, $2, 'purchase', $3, $4, $5, $6)`,
        [vendorId, productId, quantity, quantityBefore, quantityBefore + quantity, notes || null]
      );

      return inventoryRow.rows[0];
    });

    res.status(201).json({
      success: true,
      message: `Purchased ${quantity} units of ${productCheck.rows[0].product_name}`,
      data: { inventory: result },
    });
  } catch (error) {
    logger.error('Error logging purchase', { error: error.message });
    res.status(500).json({
      success: false,
      message: 'Error logging purchase',
    });
  }
});

/**
 * POST /api/vendor/inventory/adjust
 * Manual adjustment with required reason
 */
router.post('/inventory/adjust', async (req, res) => {
  try {
    const schema = Joi.object({
      productId: Joi.number().integer().required(),
      quantity: Joi.number().integer().required(), // positive or negative
      notes: Joi.string().min(1).max(500).required(), // reason required
    });

    const { error, value } = schema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message,
      });
    }

    const vendorId = req.user.id;
    const { productId, quantity, notes } = value;

    const result = await transaction(async (client) => {
      const existing = await client.query(
        `SELECT id, quantity_on_hand FROM vendor_inventory
         WHERE vendor_id = $1 AND product_id = $2 FOR UPDATE`,
        [vendorId, productId]
      );

      if (existing.rows.length === 0) {
        throw new Error('Product not found in central inventory. Log a purchase first.');
      }

      const quantityBefore = existing.rows[0].quantity_on_hand;
      const quantityAfter = quantityBefore + quantity;

      if (quantityAfter < 0) {
        throw new Error(`Adjustment would result in negative stock (${quantityBefore} + ${quantity} = ${quantityAfter})`);
      }

      const inventoryRow = await client.query(
        `UPDATE vendor_inventory
         SET quantity_on_hand = $1, updated_at = CURRENT_TIMESTAMP
         WHERE vendor_id = $2 AND product_id = $3
         RETURNING *`,
        [quantityAfter, vendorId, productId]
      );

      await client.query(
        `INSERT INTO inventory_transactions
         (vendor_id, product_id, transaction_type, quantity, quantity_before, quantity_after, notes)
         VALUES ($1, $2, 'adjustment', $3, $4, $5, $6)`,
        [vendorId, productId, quantity, quantityBefore, quantityAfter, notes]
      );

      return inventoryRow.rows[0];
    });

    res.json({
      success: true,
      message: `Inventory adjusted by ${quantity > 0 ? '+' : ''}${quantity}`,
      data: { inventory: result },
    });
  } catch (error) {
    logger.error('Error adjusting inventory', { error: error.message });
    const status = error.message.includes('not found') || error.message.includes('negative') ? 400 : 500;
    res.status(status).json({
      success: false,
      message: error.message || 'Error adjusting inventory',
    });
  }
});

/**
 * PUT /api/vendor/inventory/:productId/threshold
 * Update reorder threshold for a product
 */
router.put('/inventory/:productId/threshold', async (req, res) => {
  try {
    const { productId } = req.params;
    const schema = Joi.object({
      threshold: Joi.number().integer().min(0).required(),
    });

    const { error, value } = schema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message,
      });
    }

    const result = await query(
      `UPDATE vendor_inventory
       SET reorder_threshold = $1, updated_at = CURRENT_TIMESTAMP
       WHERE vendor_id = $2 AND product_id = $3
       RETURNING *`,
      [value.threshold, req.user.id, productId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Product not found in central inventory',
      });
    }

    res.json({
      success: true,
      message: 'Reorder threshold updated',
      data: { inventory: result.rows[0] },
    });
  } catch (error) {
    logger.error('Error updating threshold', { error: error.message });
    res.status(500).json({
      success: false,
      message: 'Error updating threshold',
    });
  }
});

/**
 * GET /api/vendor/inventory/transactions
 * Paginated transaction history with filters
 */
router.get('/inventory/transactions', async (req, res) => {
  try {
    const vendorId = req.user.id;
    const { productId, type, machineId, limit = 50, offset = 0 } = req.query;

    let whereClause = 'WHERE it.vendor_id = $1';
    const params = [vendorId];

    if (productId) {
      params.push(productId);
      whereClause += ` AND it.product_id = $${params.length}`;
    }
    if (type) {
      params.push(type);
      whereClause += ` AND it.transaction_type = $${params.length}`;
    }
    if (machineId) {
      params.push(machineId);
      whereClause += ` AND it.machine_id = $${params.length}`;
    }

    const countResult = await query(
      `SELECT COUNT(*) as total FROM inventory_transactions it ${whereClause}`,
      params
    );

    params.push(parseInt(limit), parseInt(offset));
    const result = await query(
      `SELECT it.id, it.product_id, it.transaction_type, it.quantity,
              it.quantity_before, it.quantity_after, it.machine_id,
              it.notes, it.created_at,
              p.product_name, p.category,
              vm.machine_name
       FROM inventory_transactions it
       JOIN products p ON it.product_id = p.id
       LEFT JOIN vending_machines vm ON it.machine_id = vm.id
       ${whereClause}
       ORDER BY it.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    res.json({
      success: true,
      data: {
        transactions: result.rows,
        total: parseInt(countResult.rows[0].total),
        limit: parseInt(limit),
        offset: parseInt(offset),
      },
    });
  } catch (error) {
    logger.error('Error fetching inventory transactions', { error: error.message });
    res.status(500).json({
      success: false,
      message: 'Error fetching inventory transactions',
    });
  }
});

/**
 * GET /api/vendor/inventory/alerts
 * Low-stock items only (for nav badge count)
 */
router.get('/inventory/alerts', async (req, res) => {
  try {
    const vendorId = req.user.id;

    const result = await query(
      `SELECT vi.id, vi.product_id, vi.quantity_on_hand, vi.reorder_threshold,
              p.product_name, p.category,
              CASE
                WHEN vi.quantity_on_hand = 0 THEN 'out'
                ELSE 'low'
              END as alert_type
       FROM vendor_inventory vi
       JOIN products p ON vi.product_id = p.id
       WHERE vi.vendor_id = $1
         AND vi.quantity_on_hand <= vi.reorder_threshold
         AND (p.is_deleted = false OR p.is_deleted IS NULL)
       ORDER BY vi.quantity_on_hand ASC, p.product_name`,
      [vendorId]
    );

    res.json({
      success: true,
      data: {
        alerts: result.rows,
        count: result.rows.length,
      },
    });
  } catch (error) {
    logger.error('Error fetching inventory alerts', { error: error.message });
    res.status(500).json({
      success: false,
      message: 'Error fetching inventory alerts',
    });
  }
});

// ========================================
// REFERRAL SYSTEM ROUTES
// ========================================

/**
 * GET /api/vendor/referral-code
 * Get or generate the vendor's referral code
 */
router.get('/referral-code', async (req, res) => {
  try {
    // Check if user already has a referral code
    const existing = await query(
      'SELECT referral_code FROM users WHERE id = $1',
      [req.user.id]
    );

    if (existing.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'User not found',
      });
    }

    let referralCode = existing.rows[0].referral_code;

    // Generate one if not set
    if (!referralCode) {
      // Generate random 8-char alphanumeric code, retry on collision
      for (let attempt = 0; attempt < 5; attempt++) {
        referralCode = crypto.randomBytes(4).toString('hex').toUpperCase();
        try {
          await query(
            'UPDATE users SET referral_code = $1 WHERE id = $2',
            [referralCode, req.user.id]
          );
          break;
        } catch (err) {
          // Unique constraint violation — try again
          if (err.code === '23505' && attempt < 4) {
            referralCode = null;
            continue;
          }
          throw err;
        }
      }

      if (!referralCode) {
        return res.status(500).json({
          success: false,
          message: 'Error generating referral code, please try again',
        });
      }
    }

    res.json({
      success: true,
      data: { referralCode },
    });
  } catch (error) {
    logger.error('Error getting referral code', { error: error.message });
    res.status(500).json({
      success: false,
      message: 'Error getting referral code',
    });
  }
});

/**
 * GET /api/vendor/referrals
 * Get referral stats and list of referred users
 */
router.get('/referrals', async (req, res) => {
  try {
    const result = await query(
      `SELECT id, full_name, created_at
       FROM users
       WHERE referred_by = $1
       ORDER BY created_at DESC`,
      [req.user.id]
    );

    res.json({
      success: true,
      data: {
        referrals: result.rows,
        count: result.rows.length,
      },
    });
  } catch (error) {
    logger.error('Error fetching referrals', { error: error.message });
    res.status(500).json({
      success: false,
      message: 'Error fetching referrals',
    });
  }
});

/**
 * POST /api/vendor/reports/share
 * Generate a shareable report link with vendor's machine stats
 */
router.post('/reports/share', async (req, res) => {
  try {
    const vendorId = req.user.id;

    // Collect vendor's machine stats
    const machinesResult = await query(
      `SELECT vm.id, vm.machine_name, vm.location, vm.is_active,
              COUNT(mp.id) as product_count,
              COUNT(CASE WHEN mp.is_performing = true THEN 1 END) as performing_count,
              COUNT(CASE WHEN mp.is_performing = false THEN 1 END) as not_performing_count
       FROM vending_machines vm
       LEFT JOIN machine_products mp ON vm.id = mp.machine_id AND (mp.is_deleted = false OR mp.is_deleted IS NULL)
       WHERE vm.vendor_id = $1 AND (vm.is_deleted = false OR vm.is_deleted IS NULL)
       GROUP BY vm.id
       ORDER BY vm.created_at DESC`,
      [vendorId]
    );

    // Collect active poll data for each machine
    const pollData = [];
    for (const machine of machinesResult.rows) {
      const pollResult = await query(
        `SELECT sp.id, sp.question,
                json_agg(json_build_object(
                  'productName', p.product_name,
                  'yesVotes', spo.yes_votes,
                  'noVotes', spo.no_votes
                ) ORDER BY spo.display_order) as options
         FROM swipe_polls sp
         JOIN swipe_poll_options spo ON sp.id = spo.poll_id
         JOIN products p ON spo.product_id = p.id
         WHERE sp.machine_id = $1 AND sp.is_active = true
         GROUP BY sp.id, sp.question
         LIMIT 1`,
        [machine.id]
      );

      if (pollResult.rows.length > 0) {
        pollData.push({
          machineId: machine.id,
          machineName: machine.machine_name,
          poll: pollResult.rows[0],
        });
      }
    }

    // Build report data
    const reportData = {
      generatedAt: new Date().toISOString(),
      machines: machinesResult.rows,
      polls: pollData,
      summary: {
        totalMachines: machinesResult.rows.length,
        activeMachines: machinesResult.rows.filter(m => m.is_active).length,
        totalProducts: machinesResult.rows.reduce((sum, m) => sum + parseInt(m.product_count || 0), 0),
      },
    };

    // Generate token and insert
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days

    await query(
      `INSERT INTO shared_reports (vendor_id, token, data, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [vendorId, token, JSON.stringify(reportData), expiresAt]
    );

    const frontendUrl = process.env.FRONTEND_URL || 'https://vending-front-end.vercel.app';

    res.status(201).json({
      success: true,
      message: 'Report link generated',
      data: {
        token,
        url: `${frontendUrl}/report/${token}`,
        expiresAt,
      },
    });
  } catch (error) {
    logger.error('Error generating shared report', { error: error.message });
    res.status(500).json({
      success: false,
      message: 'Error generating report link',
    });
  }
});

module.exports = router;
