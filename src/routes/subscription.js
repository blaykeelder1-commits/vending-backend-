const express = require('express');
const Joi = require('joi');
const { verifyToken } = require('../middleware/auth');
const { query } = require('../config/database');
const { sendEmail } = require('../services/emailService');
const logger = require('../utils/logger');
const {
  TIER_CONFIG,
  createSubscriptionCheckout,
  cancelSubscription,
  pauseSubscription,
  changePlan,
  handleWebhook,
  verifyWebhookSignature,
} = require('../services/squareSubscriptionService');

const router = express.Router();

// ── GET /api/subscription/status ──────────────────────────────────

router.get('/status', verifyToken, async (req, res) => {
  try {
    const result = await query(
      `SELECT subscription_tier, square_subscription_id, trial_start, trial_end, machine_limit
       FROM users WHERE id = $1`,
      [req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const user = result.rows[0];
    const tierConfig = TIER_CONFIG[user.subscription_tier] || TIER_CONFIG.free;

    // Count current machines
    const machineCount = await query(
      'SELECT COUNT(*) as count FROM vending_machines WHERE vendor_id = $1',
      [req.user.id]
    );

    // Use cached trial_end as next billing approximation — avoids calling Square API on every status check
    const nextBillingDate = user.trial_end || null;

    res.json({
      success: true,
      data: {
        tier: user.subscription_tier,
        machineLimit: user.machine_limit || tierConfig.machineLimit,
        machinesUsed: parseInt(machineCount.rows[0].count),
        trialStart: user.trial_start,
        trialEnd: user.trial_end,
        nextBillingDate,
        price: tierConfig.price ? `$${(tierConfig.price / 100).toFixed(0)}/mo` : 'Free',
      },
    });
  } catch (error) {
    logger.error('Error fetching subscription status', { error: error.message });
    res.status(500).json({ success: false, message: 'Error fetching subscription status' });
  }
});

// ── POST /api/subscription/checkout ───────────────────────────────

const checkoutSchema = Joi.object({
  tier: Joi.string().valid('growth', 'pro', 'business').required(),
});

router.post('/checkout', verifyToken, async (req, res) => {
  try {
    const { error, value } = checkoutSchema.validate(req.body);
    if (error) {
      return res.status(400).json({ success: false, message: error.details[0].message });
    }

    const { url } = await createSubscriptionCheckout(req.user.id, value.tier);

    res.json({
      success: true,
      data: { checkoutUrl: url },
    });
  } catch (error) {
    logger.error('Error creating checkout', { error: error.message, userId: req.user.id });
    res.status(500).json({ success: false, message: 'Error creating checkout session' });
  }
});

// ── POST /api/subscription/change-plan ────────────────────────────

const changePlanSchema = Joi.object({
  tier: Joi.string().valid('growth', 'pro', 'business').required(),
});

router.post('/change-plan', verifyToken, async (req, res) => {
  try {
    const { error, value } = changePlanSchema.validate(req.body);
    if (error) {
      return res.status(400).json({ success: false, message: error.details[0].message });
    }

    const userResult = await query(
      'SELECT square_subscription_id, subscription_tier FROM users WHERE id = $1',
      [req.user.id]
    );

    if (!userResult.rows[0]?.square_subscription_id) {
      return res.status(400).json({
        success: false,
        message: 'No active subscription. Use checkout to subscribe first.',
      });
    }

    if (userResult.rows[0].subscription_tier === value.tier) {
      return res.status(400).json({
        success: false,
        message: `Already on the ${value.tier} plan.`,
      });
    }

    await changePlan(userResult.rows[0].square_subscription_id, value.tier);

    // Don't update local DB here — webhook is authoritative for tier changes
    // This prevents DB/Square state divergence if the change is rejected
    const newLimit = TIER_CONFIG[value.tier]?.machineLimit || 1;

    res.json({
      success: true,
      message: `Plan change to ${value.tier} initiated. It will take effect shortly.`,
      data: { tier: value.tier, machineLimit: newLimit },
    });
  } catch (error) {
    logger.error('Error changing plan', { error: error.message, userId: req.user.id });
    res.status(500).json({ success: false, message: 'Error changing subscription plan' });
  }
});

// ── POST /api/subscription/cancel ─────────────────────────────────

router.post('/cancel', verifyToken, async (req, res) => {
  try {
    const userResult = await query(
      'SELECT square_subscription_id, subscription_tier FROM users WHERE id = $1',
      [req.user.id]
    );

    if (!userResult.rows[0]?.square_subscription_id) {
      return res.status(400).json({
        success: false,
        message: 'No active subscription to cancel.',
      });
    }

    await cancelSubscription(userResult.rows[0].square_subscription_id);

    // Don't update local DB — webhook is authoritative for cancellations
    res.json({
      success: true,
      message: 'Subscription cancellation initiated. You can continue using the free plan.',
    });
  } catch (error) {
    logger.error('Error cancelling subscription', { error: error.message, userId: req.user.id });
    res.status(500).json({ success: false, message: 'Error cancelling subscription' });
  }
});

// ── POST /api/subscription/pause ──────────────────────────────────
// Used for retention — gives a free month by pausing billing

router.post('/pause', verifyToken, async (req, res) => {
  try {
    const userResult = await query(
      'SELECT square_subscription_id FROM users WHERE id = $1',
      [req.user.id]
    );

    if (!userResult.rows[0]?.square_subscription_id) {
      return res.status(400).json({
        success: false,
        message: 'No active subscription to pause.',
      });
    }

    await pauseSubscription(userResult.rows[0].square_subscription_id);

    res.json({
      success: true,
      message: 'Your subscription has been paused for one month. Enjoy your free month!',
    });
  } catch (error) {
    logger.error('Error pausing subscription', { error: error.message, userId: req.user.id });
    res.status(500).json({ success: false, message: 'Error pausing subscription' });
  }
});

// ── POST /api/subscription/cancel-feedback ────────────────────────

const VALID_CANCEL_REASONS = [
  'too_expensive',
  'dont_use_enough',
  'missing_features',
  'found_alternative',
  'business_changed',
  'dont_understand_features',
  'other',
];

const feedbackSchema = Joi.object({
  reasons: Joi.array().items(Joi.string().valid(...VALID_CANCEL_REASONS)).min(1).required(),
  otherText: Joi.string().max(1000).allow('', null).optional(),
  acceptedRetention: Joi.boolean().optional(),
});

router.post('/cancel-feedback', verifyToken, async (req, res) => {
  try {
    const { error, value } = feedbackSchema.validate(req.body);
    if (error) {
      return res.status(400).json({ success: false, message: error.details[0].message });
    }

    // Determine if we should offer retention
    const retentionReasons = ['dont_use_enough', 'dont_understand_features'];
    const shouldOfferRetention = value.reasons.some(r => retentionReasons.includes(r));

    await query(
      `INSERT INTO cancel_feedback (user_id, reasons, other_text, offered_retention, accepted_retention)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        req.user.id,
        value.reasons,
        value.otherText || null,
        shouldOfferRetention,
        value.acceptedRetention || false,
      ]
    );

    // If they accepted the free month, pause the subscription (only if still active)
    if (value.acceptedRetention) {
      const userResult = await query(
        'SELECT square_subscription_id, subscription_tier FROM users WHERE id = $1',
        [req.user.id]
      );
      const subId = userResult.rows[0]?.square_subscription_id;
      const tier = userResult.rows[0]?.subscription_tier;
      if (subId && tier !== 'free') {
        await pauseSubscription(subId);
      }
    }

    res.json({
      success: true,
      message: 'Thank you for your feedback.',
      data: { offeredRetention: shouldOfferRetention },
    });
  } catch (error) {
    logger.error('Error saving cancel feedback', { error: error.message });
    res.status(500).json({ success: false, message: 'Error saving feedback' });
  }
});

// ── POST /api/subscription/webhook ────────────────────────────────
// Square sends raw JSON — must be parsed with raw body for signature verification

router.post('/webhook', async (req, res) => {
  try {
    const signature = req.headers['x-square-hmacsha256-signature'];
    // Body arrives as raw Buffer since we mount express.raw() for this path in app.js
    const rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : JSON.stringify(req.body);

    // Verify signature
    if (!verifyWebhookSignature(rawBody, signature, process.env.SQUARE_WEBHOOK_SIGNATURE_KEY)) {
      logger.warn('Square webhook signature verification failed');
      return res.status(403).json({ success: false, message: 'Invalid signature' });
    }

    const event = JSON.parse(rawBody);
    await handleWebhook(event);

    res.status(200).json({ success: true });
  } catch (error) {
    logger.error('Error processing Square webhook', { error: error.message });
    // Always return 200 to Square to avoid retries on our errors
    res.status(200).json({ success: false });
  }
});

// ── POST /api/support/ticket ──────────────────────────────────────

const ticketSchema = Joi.object({
  subject: Joi.string().max(255).required(),
  message: Joi.string().max(5000).required(),
});

router.post('/support/ticket', verifyToken, async (req, res) => {
  try {
    const { error, value } = ticketSchema.validate(req.body);
    if (error) {
      return res.status(400).json({ success: false, message: error.details[0].message });
    }

    const result = await query(
      `INSERT INTO support_tickets (user_id, subject, message)
       VALUES ($1, $2, $3)
       RETURNING id, created_at`,
      [req.user.id, value.subject, value.message]
    );

    // Send notification email to support (fire and forget)
    const userResult = await query('SELECT email, full_name FROM users WHERE id = $1', [req.user.id]);
    const user = userResult.rows[0];
    if (process.env.SUPPORT_EMAIL) {
      sendEmail(process.env.SUPPORT_EMAIL, 'supportTicketNotification', {
        ticketId: result.rows[0].id,
        userName: user?.full_name || 'Unknown',
        userEmail: user?.email || 'Unknown',
        subject: value.subject,
        message: value.message,
      }).catch(err => {
        logger.error('Error sending support notification', { error: err.message });
      });
    }

    res.status(201).json({
      success: true,
      message: 'Support ticket created. We\'ll get back to you soon.',
      data: { ticketId: result.rows[0].id },
    });
  } catch (error) {
    logger.error('Error creating support ticket', { error: error.message });
    res.status(500).json({ success: false, message: 'Error creating support ticket' });
  }
});

// ── POST /api/support/feature-request ─────────────────────────────

const featureRequestSchema = Joi.object({
  title: Joi.string().max(255).required(),
  description: Joi.string().max(2000).allow('', null).optional(),
});

router.post('/support/feature-request', verifyToken, async (req, res) => {
  try {
    const { error, value } = featureRequestSchema.validate(req.body);
    if (error) {
      return res.status(400).json({ success: false, message: error.details[0].message });
    }

    const result = await query(
      `INSERT INTO feature_requests (user_id, title, description)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [req.user.id, value.title, value.description || null]
    );

    res.status(201).json({
      success: true,
      message: 'Feature request submitted. Thanks for the feedback!',
      data: { requestId: result.rows[0].id },
    });
  } catch (error) {
    logger.error('Error creating feature request', { error: error.message });
    res.status(500).json({ success: false, message: 'Error submitting feature request' });
  }
});

module.exports = router;
