// DISCOUNT SYSTEM - Not yet connected to app. To enable, add: app.use('/api', require('./routes/discounts'));

const express = require('express');
const Joi = require('joi');
const { query, transaction } = require('../config/database');
const { protect, restrictTo } = require('../middleware/auth');
const logger = require('../utils/logger');

const router = express.Router();

// ========================================
// PRICING CONSTANTS
// ========================================

// IDDI processing fee per redemption - this is pure margin
const PROCESSING_FEE_PER_TRANSACTION = 0.07;

// ========================================
// HELPERS
// ========================================

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

async function verifyDiscountOwnership(discountId, vendorId, res) {
  const result = await query(
    'SELECT id FROM machine_discounts WHERE id = $1 AND vendor_id = $2',
    [discountId, vendorId]
  );
  if (result.rows.length === 0) {
    res.status(404).json({ success: false, message: 'Discount not found' });
    return false;
  }
  return true;
}

// ========================================
// VENDOR ENDPOINTS (authenticated)
// ========================================

/**
 * GET /api/discounts/machines/:machineId
 * Get all discounts for a machine (active and inactive)
 */
router.get('/discounts/machines/:machineId', protect, restrictTo('vendor'), async (req, res) => {
  try {
    const { machineId } = req.params;

    if (!(await verifyMachineOwnership(machineId, req.user.id, res))) return;

    const result = await query(
      `SELECT md.id, md.machine_id, md.product_id, md.discount_type, md.discount_value,
              md.max_discount_amount, md.is_active, md.created_at, md.updated_at,
              p.product_name
       FROM machine_discounts md
       LEFT JOIN products p ON md.product_id = p.id
       WHERE md.machine_id = $1 AND md.vendor_id = $2
       ORDER BY md.is_active DESC, md.created_at DESC`,
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
    logger.error('Error fetching discounts', { error: error.message });
    res.status(500).json({
      success: false,
      message: 'Error fetching discounts',
    });
  }
});

/**
 * POST /api/discounts/machines/:machineId
 * Create a new discount for a machine
 */
router.post('/discounts/machines/:machineId', protect, restrictTo('vendor'), async (req, res) => {
  try {
    const { machineId } = req.params;

    const schema = Joi.object({
      productId: Joi.number().integer().allow(null).optional(),
      discountType: Joi.string().valid('percent', 'fixed').required(),
      discountValue: Joi.number().positive().precision(2).required(),
      maxDiscountAmount: Joi.number().positive().precision(2).default(1.00),
    });

    const { error, value } = schema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message,
      });
    }

    if (!(await verifyMachineOwnership(machineId, req.user.id, res))) return;

    // Enforce max 3 active discounts per machine
    const activeCount = await query(
      'SELECT COUNT(*) as count FROM machine_discounts WHERE machine_id = $1 AND is_active = true',
      [machineId]
    );

    if (parseInt(activeCount.rows[0].count) >= 3) {
      return res.status(400).json({
        success: false,
        message: 'Maximum 3 active discounts per machine. Deactivate an existing discount first.',
      });
    }

    const result = await query(
      `INSERT INTO machine_discounts (machine_id, vendor_id, product_id, discount_type, discount_value, max_discount_amount)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [machineId, req.user.id, value.productId || null, value.discountType, value.discountValue, value.maxDiscountAmount]
    );

    res.status(201).json({
      success: true,
      data: result.rows[0],
    });
  } catch (error) {
    logger.error('Error creating discount', { error: error.message });
    res.status(500).json({
      success: false,
      message: 'Error creating discount',
    });
  }
});

/**
 * PUT /api/discounts/:discountId
 * Update a discount
 */
router.put('/discounts/:discountId', protect, restrictTo('vendor'), async (req, res) => {
  try {
    const { discountId } = req.params;

    const schema = Joi.object({
      discountType: Joi.string().valid('percent', 'fixed').optional(),
      discountValue: Joi.number().positive().precision(2).optional(),
      maxDiscountAmount: Joi.number().positive().precision(2).optional(),
      isActive: Joi.boolean().optional(),
    }).min(1);

    const { error, value } = schema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message,
      });
    }

    if (!(await verifyDiscountOwnership(discountId, req.user.id, res))) return;

    // If activating, check the 3-active limit
    if (value.isActive === true) {
      const discount = await query('SELECT machine_id FROM machine_discounts WHERE id = $1', [discountId]);
      const machineId = discount.rows[0].machine_id;

      const activeCount = await query(
        'SELECT COUNT(*) as count FROM machine_discounts WHERE machine_id = $1 AND is_active = true AND id != $2',
        [machineId, discountId]
      );

      if (parseInt(activeCount.rows[0].count) >= 3) {
        return res.status(400).json({
          success: false,
          message: 'Maximum 3 active discounts per machine. Deactivate an existing discount first.',
        });
      }
    }

    // Build dynamic update
    const updates = [];
    const params = [];
    let paramIndex = 1;

    if (value.discountType !== undefined) {
      updates.push(`discount_type = $${paramIndex++}`);
      params.push(value.discountType);
    }
    if (value.discountValue !== undefined) {
      updates.push(`discount_value = $${paramIndex++}`);
      params.push(value.discountValue);
    }
    if (value.maxDiscountAmount !== undefined) {
      updates.push(`max_discount_amount = $${paramIndex++}`);
      params.push(value.maxDiscountAmount);
    }
    if (value.isActive !== undefined) {
      updates.push(`is_active = $${paramIndex++}`);
      params.push(value.isActive);
    }
    updates.push(`updated_at = CURRENT_TIMESTAMP`);

    params.push(discountId);

    const result = await query(
      `UPDATE machine_discounts SET ${updates.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
      params
    );

    res.json({
      success: true,
      data: result.rows[0],
    });
  } catch (error) {
    logger.error('Error updating discount', { error: error.message });
    res.status(500).json({
      success: false,
      message: 'Error updating discount',
    });
  }
});

/**
 * DELETE /api/discounts/:discountId
 * Soft deactivate a discount
 */
router.delete('/discounts/:discountId', protect, restrictTo('vendor'), async (req, res) => {
  try {
    const { discountId } = req.params;

    if (!(await verifyDiscountOwnership(discountId, req.user.id, res))) return;

    await query(
      'UPDATE machine_discounts SET is_active = false, updated_at = CURRENT_TIMESTAMP WHERE id = $1',
      [discountId]
    );

    res.json({
      success: true,
      message: 'Discount deactivated',
    });
  } catch (error) {
    logger.error('Error deactivating discount', { error: error.message });
    res.status(500).json({
      success: false,
      message: 'Error deactivating discount',
    });
  }
});

/**
 * GET /api/discounts/balance
 * Get vendor's rebate balance
 */
router.get('/discounts/balance', protect, restrictTo('vendor'), async (req, res) => {
  try {
    const result = await query(
      'SELECT balance, total_loaded, total_paid_out, updated_at FROM vendor_rebate_balance WHERE vendor_id = $1',
      [req.user.id]
    );

    if (result.rows.length === 0) {
      return res.json({
        success: true,
        data: {
          balance: '0.00',
          totalLoaded: '0.00',
          totalPaidOut: '0.00',
        },
      });
    }

    const row = result.rows[0];
    res.json({
      success: true,
      data: {
        balance: row.balance,
        totalLoaded: row.total_loaded,
        totalPaidOut: row.total_paid_out,
        updatedAt: row.updated_at,
      },
    });
  } catch (error) {
    logger.error('Error fetching balance', { error: error.message });
    res.status(500).json({
      success: false,
      message: 'Error fetching rebate balance',
    });
  }
});

/**
 * POST /api/discounts/balance/load
 * Add funds to rebate balance (min $25)
 */
router.post('/discounts/balance/load', protect, restrictTo('vendor'), async (req, res) => {
  try {
    const schema = Joi.object({
      amount: Joi.number().min(25).precision(2).required(),
    });

    const { error, value } = schema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message,
      });
    }

    const result = await transaction(async (client) => {
      // Get or create balance record
      let balanceResult = await client.query(
        'SELECT id, balance FROM vendor_rebate_balance WHERE vendor_id = $1 FOR UPDATE',
        [req.user.id]
      );

      let balanceBefore;
      let balanceAfter;

      if (balanceResult.rows.length === 0) {
        // Create initial balance record
        balanceBefore = 0;
        balanceAfter = value.amount;
        await client.query(
          `INSERT INTO vendor_rebate_balance (vendor_id, balance, total_loaded)
           VALUES ($1, $2, $2)`,
          [req.user.id, value.amount]
        );
      } else {
        balanceBefore = parseFloat(balanceResult.rows[0].balance);
        balanceAfter = balanceBefore + value.amount;
        await client.query(
          `UPDATE vendor_rebate_balance
           SET balance = balance + $1, total_loaded = total_loaded + $1, updated_at = CURRENT_TIMESTAMP
           WHERE vendor_id = $2`,
          [value.amount, req.user.id]
        );
      }

      // Log the transaction
      await client.query(
        `INSERT INTO rebate_balance_transactions (vendor_id, transaction_type, amount, balance_before, balance_after, notes)
         VALUES ($1, 'load', $2, $3, $4, 'Balance load')`,
        [req.user.id, value.amount, balanceBefore, balanceAfter]
      );

      return { balanceBefore, balanceAfter };
    });

    res.status(201).json({
      success: true,
      data: {
        balanceBefore: result.balanceBefore.toFixed(2),
        balanceAfter: result.balanceAfter.toFixed(2),
        amountLoaded: value.amount.toFixed(2),
      },
    });
  } catch (error) {
    logger.error('Error loading balance', { error: error.message });
    res.status(500).json({
      success: false,
      message: 'Error loading rebate balance',
    });
  }
});

/**
 * GET /api/discounts/redemptions
 * Get all redemptions for this vendor (filterable)
 */
router.get('/discounts/redemptions', protect, restrictTo('vendor'), async (req, res) => {
  try {
    const schema = Joi.object({
      status: Joi.string().valid('pending', 'approved', 'paid', 'rejected').optional(),
      machineId: Joi.number().integer().optional(),
      limit: Joi.number().integer().min(1).max(100).default(50),
      offset: Joi.number().integer().min(0).default(0),
    });

    const { error, value } = schema.validate(req.query);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message,
      });
    }

    let whereClause = 'md.vendor_id = $1';
    const params = [req.user.id];
    let paramIndex = 2;

    if (value.status) {
      whereClause += ` AND dr.status = $${paramIndex++}`;
      params.push(value.status);
    }
    if (value.machineId) {
      whereClause += ` AND dr.machine_id = $${paramIndex++}`;
      params.push(value.machineId);
    }

    params.push(value.limit);
    params.push(value.offset);

    const result = await query(
      `SELECT dr.id, dr.discount_id, dr.customer_id, dr.machine_id, dr.product_name,
              dr.purchase_price, dr.rebate_amount, dr.proof_image_url, dr.status,
              dr.claimed_at, dr.approved_at, dr.paid_at, dr.payout_reference,
              dc.display_name as customer_name, dc.phone_or_email as customer_contact,
              vm.machine_name
       FROM discount_redemptions dr
       JOIN machine_discounts md ON dr.discount_id = md.id
       JOIN discount_customers dc ON dr.customer_id = dc.id
       JOIN vending_machines vm ON dr.machine_id = vm.id
       WHERE ${whereClause}
       ORDER BY dr.claimed_at DESC
       LIMIT $${paramIndex++} OFFSET $${paramIndex}`,
      params
    );

    // Get total count for pagination
    const countResult = await query(
      `SELECT COUNT(*) as total
       FROM discount_redemptions dr
       JOIN machine_discounts md ON dr.discount_id = md.id
       WHERE ${whereClause}`,
      params.slice(0, paramIndex - 2) // exclude limit/offset
    );

    res.json({
      success: true,
      data: {
        redemptions: result.rows,
        count: result.rows.length,
        total: parseInt(countResult.rows[0].total),
        limit: value.limit,
        offset: value.offset,
      },
    });
  } catch (error) {
    logger.error('Error fetching redemptions', { error: error.message });
    res.status(500).json({
      success: false,
      message: 'Error fetching redemptions',
    });
  }
});

/**
 * PUT /api/discounts/redemptions/:redemptionId/approve
 * Approve a pending redemption (deducts from vendor's rebate balance)
 */
router.put('/discounts/redemptions/:redemptionId/approve', protect, restrictTo('vendor'), async (req, res) => {
  try {
    const { redemptionId } = req.params;

    const result = await transaction(async (client) => {
      // Get redemption and verify ownership
      const redemptionResult = await client.query(
        `SELECT dr.id, dr.rebate_amount, dr.status, md.vendor_id
         FROM discount_redemptions dr
         JOIN machine_discounts md ON dr.discount_id = md.id
         WHERE dr.id = $1`,
        [redemptionId]
      );

      if (redemptionResult.rows.length === 0) {
        return { error: 'Redemption not found', status: 404 };
      }

      const redemption = redemptionResult.rows[0];

      if (redemption.vendor_id !== req.user.id) {
        return { error: 'Redemption not found', status: 404 };
      }

      if (redemption.status !== 'pending') {
        return { error: `Redemption is already ${redemption.status}`, status: 400 };
      }

      // Check vendor balance
      const balanceResult = await client.query(
        'SELECT balance FROM vendor_rebate_balance WHERE vendor_id = $1 FOR UPDATE',
        [req.user.id]
      );

      const totalCost = parseFloat(redemption.total_vendor_cost || redemption.rebate_amount);
      if (balanceResult.rows.length === 0 || parseFloat(balanceResult.rows[0].balance) < totalCost) {
        return { error: 'Insufficient rebate balance. Load more funds first.', status: 400 };
      }

      const balanceBefore = parseFloat(balanceResult.rows[0].balance);
      const rebateAmount = parseFloat(redemption.rebate_amount);
      const balanceAfter = balanceBefore - totalCost;

      // Deduct total cost (rebate + IDDI processing fee) from vendor balance
      await client.query(
        `UPDATE vendor_rebate_balance
         SET balance = balance - $1, total_paid_out = total_paid_out + $1, updated_at = CURRENT_TIMESTAMP
         WHERE vendor_id = $2`,
        [totalCost, req.user.id]
      );

      // Log the transaction
      await client.query(
        `INSERT INTO rebate_balance_transactions (vendor_id, transaction_type, amount, balance_before, balance_after, reference_id, notes)
         VALUES ($1, 'payout', $2, $3, $4, $5, $6)`,
        [req.user.id, totalCost, balanceBefore, balanceAfter, redemptionId,
         `Rebate: $${rebateAmount.toFixed(2)} + processing: $${PROCESSING_FEE_PER_TRANSACTION.toFixed(2)}`]
      );

      // Update redemption status
      await client.query(
        `UPDATE discount_redemptions SET status = 'approved', approved_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [redemptionId]
      );

      return {
        redemptionId: parseInt(redemptionId),
        rebateAmount: rebateAmount.toFixed(2),
        processingFee: PROCESSING_FEE_PER_TRANSACTION.toFixed(2),
        totalDeducted: totalCost.toFixed(2),
        balanceAfter: balanceAfter.toFixed(2),
      };
    });

    if (result.error) {
      return res.status(result.status).json({
        success: false,
        message: result.error,
      });
    }

    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    logger.error('Error approving redemption', { error: error.message });
    res.status(500).json({
      success: false,
      message: 'Error approving redemption',
    });
  }
});

/**
 * PUT /api/discounts/redemptions/:redemptionId/reject
 * Reject a redemption with reason
 */
router.put('/discounts/redemptions/:redemptionId/reject', protect, restrictTo('vendor'), async (req, res) => {
  try {
    const { redemptionId } = req.params;

    const schema = Joi.object({
      reason: Joi.string().max(500).optional(),
    });

    const { error, value } = schema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message,
      });
    }

    // Verify ownership
    const redemptionResult = await query(
      `SELECT dr.id, dr.status, md.vendor_id
       FROM discount_redemptions dr
       JOIN machine_discounts md ON dr.discount_id = md.id
       WHERE dr.id = $1`,
      [redemptionId]
    );

    if (redemptionResult.rows.length === 0 || redemptionResult.rows[0].vendor_id !== req.user.id) {
      return res.status(404).json({
        success: false,
        message: 'Redemption not found',
      });
    }

    if (redemptionResult.rows[0].status !== 'pending') {
      return res.status(400).json({
        success: false,
        message: `Redemption is already ${redemptionResult.rows[0].status}`,
      });
    }

    await query(
      `UPDATE discount_redemptions SET status = 'rejected' WHERE id = $1`,
      [redemptionId]
    );

    res.json({
      success: true,
      message: 'Redemption rejected',
    });
  } catch (error) {
    logger.error('Error rejecting redemption', { error: error.message });
    res.status(500).json({
      success: false,
      message: 'Error rejecting redemption',
    });
  }
});

/**
 * GET /api/discounts/analytics
 * Summary stats for vendor's discount program
 */
router.get('/discounts/analytics', protect, restrictTo('vendor'), async (req, res) => {
  try {
    // Total redemptions and payout stats
    const statsResult = await query(
      `SELECT
         COUNT(*) as total_redemptions,
         COUNT(CASE WHEN dr.status = 'approved' OR dr.status = 'paid' THEN 1 END) as approved_count,
         COUNT(CASE WHEN dr.status = 'pending' THEN 1 END) as pending_count,
         COUNT(CASE WHEN dr.status = 'rejected' THEN 1 END) as rejected_count,
         COALESCE(SUM(CASE WHEN dr.status IN ('approved', 'paid') THEN dr.rebate_amount ELSE 0 END), 0) as total_paid_out,
         COALESCE(SUM(CASE WHEN dr.status IN ('approved', 'paid') THEN dr.processing_fee ELSE 0 END), 0) as total_processing_fees,
         COALESCE(SUM(CASE WHEN dr.status IN ('approved', 'paid') THEN dr.total_vendor_cost ELSE 0 END), 0) as total_vendor_cost,
         COALESCE(AVG(CASE WHEN dr.status IN ('approved', 'paid') THEN dr.rebate_amount END), 0) as avg_rebate
       FROM discount_redemptions dr
       JOIN machine_discounts md ON dr.discount_id = md.id
       WHERE md.vendor_id = $1`,
      [req.user.id]
    );

    // Repeat customer percentage
    const repeatResult = await query(
      `SELECT
         COUNT(DISTINCT dr.customer_id) as total_customers,
         COUNT(DISTINCT CASE WHEN customer_counts.redemption_count > 1 THEN dr.customer_id END) as repeat_customers
       FROM discount_redemptions dr
       JOIN machine_discounts md ON dr.discount_id = md.id
       JOIN (
         SELECT dr2.customer_id, COUNT(*) as redemption_count
         FROM discount_redemptions dr2
         JOIN machine_discounts md2 ON dr2.discount_id = md2.id
         WHERE md2.vendor_id = $1
         GROUP BY dr2.customer_id
       ) customer_counts ON dr.customer_id = customer_counts.customer_id
       WHERE md.vendor_id = $1`,
      [req.user.id]
    );

    // Top discounts by redemption count
    const topDiscountsResult = await query(
      `SELECT md.id, md.discount_type, md.discount_value, md.max_discount_amount,
              p.product_name, vm.machine_name,
              COUNT(dr.id) as redemption_count,
              COALESCE(SUM(CASE WHEN dr.status IN ('approved', 'paid') THEN dr.rebate_amount ELSE 0 END), 0) as total_rebated
       FROM machine_discounts md
       LEFT JOIN discount_redemptions dr ON md.id = dr.discount_id
       LEFT JOIN products p ON md.product_id = p.id
       JOIN vending_machines vm ON md.machine_id = vm.id
       WHERE md.vendor_id = $1
       GROUP BY md.id, p.product_name, vm.machine_name
       ORDER BY redemption_count DESC
       LIMIT 10`,
      [req.user.id]
    );

    const stats = statsResult.rows[0];
    const repeat = repeatResult.rows[0];
    const totalCustomers = parseInt(repeat.total_customers) || 0;
    const repeatCustomers = parseInt(repeat.repeat_customers) || 0;

    res.json({
      success: true,
      data: {
        totalRedemptions: parseInt(stats.total_redemptions),
        approvedCount: parseInt(stats.approved_count),
        pendingCount: parseInt(stats.pending_count),
        rejectedCount: parseInt(stats.rejected_count),
        totalPaidOut: parseFloat(stats.total_paid_out).toFixed(2),
        avgRebate: parseFloat(stats.avg_rebate).toFixed(2),
        totalCustomers,
        repeatCustomers,
        repeatCustomerPercent: totalCustomers > 0 ? ((repeatCustomers / totalCustomers) * 100).toFixed(1) : '0.0',
        topDiscounts: topDiscountsResult.rows,
      },
    });
  } catch (error) {
    logger.error('Error fetching analytics', { error: error.message });
    res.status(500).json({
      success: false,
      message: 'Error fetching discount analytics',
    });
  }
});

// ========================================
// CUSTOMER ENDPOINTS (no vendor auth)
// ========================================

/**
 * GET /api/discounts/customer/machine/:machineId
 * Get active discounts for a machine (public endpoint)
 */
router.get('/discounts/customer/machine/:machineId', async (req, res) => {
  try {
    const { machineId } = req.params;

    const result = await query(
      `SELECT md.id, md.discount_type, md.discount_value, md.max_discount_amount,
              p.product_name,
              CASE
                WHEN md.discount_type = 'percent' THEN md.discount_value || '% off (up to $' || md.max_discount_amount || ')'
                WHEN md.discount_type = 'fixed' THEN '$' || md.discount_value || ' off'
              END as discount_description
       FROM machine_discounts md
       LEFT JOIN products p ON md.product_id = p.id
       WHERE md.machine_id = $1 AND md.is_active = true
       ORDER BY md.created_at DESC`,
      [machineId]
    );

    res.json({
      success: true,
      data: {
        discounts: result.rows,
        count: result.rows.length,
      },
    });
  } catch (error) {
    logger.error('Error fetching machine discounts', { error: error.message });
    res.status(500).json({
      success: false,
      message: 'Error fetching discounts',
    });
  }
});

/**
 * POST /api/discounts/customer/register
 * Create or get a customer account
 */
router.post('/discounts/customer/register', async (req, res) => {
  try {
    const schema = Joi.object({
      phoneOrEmail: Joi.string().max(255).required(),
      displayName: Joi.string().max(100).optional(),
    });

    const { error, value } = schema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message,
      });
    }

    // Upsert: create if not exists, return existing if found
    const result = await query(
      `INSERT INTO discount_customers (phone_or_email, display_name)
       VALUES ($1, $2)
       ON CONFLICT (phone_or_email) DO UPDATE SET
         display_name = COALESCE(EXCLUDED.display_name, discount_customers.display_name),
         updated_at = CURRENT_TIMESTAMP
       RETURNING id, phone_or_email, display_name, zelle_id, payout_method, created_at`,
      [value.phoneOrEmail, value.displayName || null]
    );

    const customer = result.rows[0];

    res.json({
      success: true,
      data: {
        customerId: customer.id,
        phoneOrEmail: customer.phone_or_email,
        displayName: customer.display_name,
        zelleId: customer.zelle_id,
        payoutMethod: customer.payout_method,
      },
    });
  } catch (error) {
    logger.error('Error registering customer', { error: error.message });
    res.status(500).json({
      success: false,
      message: 'Error registering customer',
    });
  }
});

/**
 * POST /api/discounts/customer/link-payout
 * Link Zelle or card info for payouts
 */
router.post('/discounts/customer/link-payout', async (req, res) => {
  try {
    const schema = Joi.object({
      customerId: Joi.number().integer().required(),
      payoutMethod: Joi.string().valid('zelle', 'card').required(),
      zelleId: Joi.string().max(255).when('payoutMethod', {
        is: 'zelle',
        then: Joi.required(),
        otherwise: Joi.optional(),
      }),
      cardLastFour: Joi.string().length(4).pattern(/^\d{4}$/).when('payoutMethod', {
        is: 'card',
        then: Joi.required(),
        otherwise: Joi.optional(),
      }),
    });

    const { error, value } = schema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message,
      });
    }

    const updates = ['payout_method = $1', 'updated_at = CURRENT_TIMESTAMP'];
    const params = [value.payoutMethod];
    let paramIndex = 2;

    if (value.zelleId) {
      updates.push(`zelle_id = $${paramIndex++}`);
      params.push(value.zelleId);
    }
    if (value.cardLastFour) {
      updates.push(`card_last_four = $${paramIndex++}`);
      params.push(value.cardLastFour);
    }

    params.push(value.customerId);

    const result = await query(
      `UPDATE discount_customers SET ${updates.join(', ')} WHERE id = $${paramIndex} RETURNING id, payout_method, zelle_id, card_last_four`,
      params
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Customer not found',
      });
    }

    res.json({
      success: true,
      data: result.rows[0],
    });
  } catch (error) {
    logger.error('Error linking payout', { error: error.message });
    res.status(500).json({
      success: false,
      message: 'Error linking payout method',
    });
  }
});

/**
 * POST /api/discounts/customer/claim
 * Claim a discount (creates a pending redemption)
 */
router.post('/discounts/customer/claim', async (req, res) => {
  try {
    const schema = Joi.object({
      discountId: Joi.number().integer().required(),
      customerId: Joi.number().integer().required(),
      machineId: Joi.number().integer().required(),
    });

    const { error, value } = schema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message,
      });
    }

    // Verify discount exists and is active
    const discountResult = await query(
      `SELECT md.id, md.discount_type, md.discount_value, md.max_discount_amount, md.machine_id,
              COALESCE(p.product_name, 'Any Product') as product_name
       FROM machine_discounts md
       LEFT JOIN products p ON md.product_id = p.id
       WHERE md.id = $1 AND md.is_active = true`,
      [value.discountId]
    );

    if (discountResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Discount not found or no longer active',
      });
    }

    const discount = discountResult.rows[0];

    if (discount.machine_id !== value.machineId) {
      return res.status(400).json({
        success: false,
        message: 'Discount does not belong to this machine',
      });
    }

    // Verify customer exists
    const customerResult = await query(
      'SELECT id FROM discount_customers WHERE id = $1',
      [value.customerId]
    );

    if (customerResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Customer not found. Please register first.',
      });
    }

    // Create redemption with placeholder values (price/rebate filled in at proof submission)
    const result = await query(
      `INSERT INTO discount_redemptions (discount_id, customer_id, machine_id, product_name, purchase_price, rebate_amount)
       VALUES ($1, $2, $3, $4, 0, 0)
       RETURNING id, discount_id, customer_id, machine_id, product_name, status, claimed_at`,
      [value.discountId, value.customerId, value.machineId, discount.product_name]
    );

    res.status(201).json({
      success: true,
      data: {
        redemption: result.rows[0],
        discount: {
          type: discount.discount_type,
          value: discount.discount_value,
          maxDiscountAmount: discount.max_discount_amount,
        },
      },
    });
  } catch (error) {
    logger.error('Error claiming discount', { error: error.message });
    res.status(500).json({
      success: false,
      message: 'Error claiming discount',
    });
  }
});

/**
 * POST /api/discounts/customer/submit-proof
 * Submit proof of purchase and calculate rebate
 */
router.post('/discounts/customer/submit-proof', async (req, res) => {
  try {
    const schema = Joi.object({
      redemptionId: Joi.number().integer().required(),
      purchasePrice: Joi.number().positive().precision(2).required(),
      proofImageUrl: Joi.string().uri().required(),
    });

    const { error, value } = schema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message,
      });
    }

    // Get redemption and its discount details
    const redemptionResult = await query(
      `SELECT dr.id, dr.status, md.discount_type, md.discount_value, md.max_discount_amount
       FROM discount_redemptions dr
       JOIN machine_discounts md ON dr.discount_id = md.id
       WHERE dr.id = $1`,
      [value.redemptionId]
    );

    if (redemptionResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Redemption not found',
      });
    }

    const redemption = redemptionResult.rows[0];

    if (redemption.status !== 'pending') {
      return res.status(400).json({
        success: false,
        message: `Redemption is already ${redemption.status}`,
      });
    }

    // Calculate rebate amount
    let rebateAmount;
    if (redemption.discount_type === 'percent') {
      rebateAmount = (value.purchasePrice * parseFloat(redemption.discount_value)) / 100;
      const maxCap = parseFloat(redemption.max_discount_amount);
      if (rebateAmount > maxCap) {
        rebateAmount = maxCap;
      }
    } else {
      // Fixed discount
      rebateAmount = parseFloat(redemption.discount_value);
      // Don't let rebate exceed purchase price
      if (rebateAmount > value.purchasePrice) {
        rebateAmount = value.purchasePrice;
      }
    }

    rebateAmount = Math.round(rebateAmount * 100) / 100;
    const processingFee = PROCESSING_FEE_PER_TRANSACTION;
    const totalVendorCost = Math.round((rebateAmount + processingFee) * 100) / 100;

    const result = await query(
      `UPDATE discount_redemptions
       SET purchase_price = $1, rebate_amount = $2, processing_fee = $3, total_vendor_cost = $4, proof_image_url = $5
       WHERE id = $6
       RETURNING id, purchase_price, rebate_amount, processing_fee, total_vendor_cost, proof_image_url, status`,
      [value.purchasePrice, rebateAmount, processingFee, totalVendorCost, value.proofImageUrl, value.redemptionId]
    );

    res.json({
      success: true,
      data: result.rows[0],
    });
  } catch (error) {
    logger.error('Error submitting proof', { error: error.message });
    res.status(500).json({
      success: false,
      message: 'Error submitting proof of purchase',
    });
  }
});

/**
 * GET /api/discounts/customer/history
 * Get customer's past redemptions
 */
router.get('/discounts/customer/history', async (req, res) => {
  try {
    const schema = Joi.object({
      customerId: Joi.number().integer().required(),
    });

    const { error, value } = schema.validate(req.query);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message,
      });
    }

    const result = await query(
      `SELECT dr.id, dr.product_name, dr.purchase_price, dr.rebate_amount,
              dr.status, dr.claimed_at, dr.approved_at, dr.paid_at,
              vm.machine_name, vm.location,
              md.discount_type, md.discount_value
       FROM discount_redemptions dr
       JOIN vending_machines vm ON dr.machine_id = vm.id
       JOIN machine_discounts md ON dr.discount_id = md.id
       WHERE dr.customer_id = $1
       ORDER BY dr.claimed_at DESC`,
      [value.customerId]
    );

    res.json({
      success: true,
      data: {
        redemptions: result.rows,
        count: result.rows.length,
      },
    });
  } catch (error) {
    logger.error('Error fetching customer history', { error: error.message });
    res.status(500).json({
      success: false,
      message: 'Error fetching redemption history',
    });
  }
});

module.exports = router;
