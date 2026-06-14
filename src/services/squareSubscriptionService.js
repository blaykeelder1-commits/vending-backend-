const { Client, Environment } = require('square');
const { query } = require('../config/database');
const logger = require('../utils/logger');
const crypto = require('crypto');

// Square client (lazy-initialized)
let squareClient = null;

function getClient() {
  if (!squareClient) {
    const accessToken = process.env.SQUARE_ACCESS_TOKEN;
    if (!accessToken) throw new Error('Missing SQUARE_ACCESS_TOKEN');

    squareClient = new Client({
      accessToken,
      environment: process.env.SQUARE_ENVIRONMENT === 'production'
        ? Environment.Production
        : Environment.Sandbox,
    });
  }
  return squareClient;
}

// Tier config — map tier names to Square plan variation IDs and machine limits
const TIER_CONFIG = {
  free: { machineLimit: 1, price: 0 },
  growth: { machineLimit: 10, price: 1900, planVariationId: process.env.SQUARE_GROWTH_PLAN_ID },
  pro: { machineLimit: 30, price: 4900, planVariationId: process.env.SQUARE_PRO_PLAN_ID },
  business: { machineLimit: 100, price: 9900, planVariationId: process.env.SQUARE_BUSINESS_PLAN_ID },
};

const FRONTEND_URL = process.env.FRONTEND_URL || 'https://iddisolutions.net';

/**
 * Create a Square Checkout link for a subscription plan variation.
 * Returns the checkout URL — redirect the user there.
 */
async function createSubscriptionCheckout(userId, tier) {
  const tierConfig = TIER_CONFIG[tier];
  if (!tierConfig || !tierConfig.planVariationId) {
    throw new Error(`Invalid or non-billable tier: ${tier}`);
  }

  const client = getClient();

  // Get user info
  const userResult = await query('SELECT email, full_name FROM users WHERE id = $1', [userId]);
  if (userResult.rows.length === 0) throw new Error('User not found');
  const user = userResult.rows[0];

  // Deterministic idempotency key — same user+tier within a 5-min window reuses the same key
  const window = Math.floor(Date.now() / (5 * 60 * 1000));
  const idempotencyKey = crypto.createHash('sha256').update(`${userId}-${tier}-${window}`).digest('hex');

  const response = await client.checkoutApi.createPaymentLink({
    idempotencyKey,
    quickPay: undefined,
    checkoutOptions: {
      subscriptionPlanVariationId: tierConfig.planVariationId,
      redirectUrl: `${FRONTEND_URL}/vendor/subscription?status=success&tier=${tier}`,
      merchantSupportEmail: process.env.SUPPORT_EMAIL || undefined,
    },
    prePopulatedData: {
      buyerEmail: user.email,
    },
    paymentNote: `IDDI ${tier.charAt(0).toUpperCase() + tier.slice(1)} Plan — ${user.full_name}`,
  });

  const paymentLink = response.result?.paymentLink;
  if (!paymentLink?.url) {
    throw new Error('Failed to create Square checkout link');
  }

  logger.info('Square checkout link created', { userId, tier, linkId: paymentLink.id });
  return { url: paymentLink.url, linkId: paymentLink.id };
}

/**
 * Cancel a subscription via Square Subscriptions API.
 */
async function cancelSubscription(subscriptionId) {
  const client = getClient();
  const response = await client.subscriptionsApi.cancelSubscription(subscriptionId);
  logger.info('Square subscription cancelled', { subscriptionId });
  return response.result?.subscription;
}

/**
 * Pause a subscription (for retention — gives a free month).
 */
async function pauseSubscription(subscriptionId) {
  const client = getClient();
  const response = await client.subscriptionsApi.pauseSubscription(subscriptionId, {
    pauseCycleDuration: 1, // Pause for 1 billing cycle
    pauseReason: 'Customer retention — free month offered',
  });
  logger.info('Square subscription paused', { subscriptionId });
  return response.result?.subscription;
}

/**
 * Resume a paused subscription.
 */
async function resumeSubscription(subscriptionId) {
  const client = getClient();
  const response = await client.subscriptionsApi.resumeSubscription(subscriptionId, {});
  logger.info('Square subscription resumed', { subscriptionId });
  return response.result?.subscription;
}

/**
 * Swap a subscription to a different plan variation (upgrade/downgrade).
 */
async function changePlan(subscriptionId, newTier) {
  const tierConfig = TIER_CONFIG[newTier];
  if (!tierConfig || !tierConfig.planVariationId) {
    throw new Error(`Invalid or non-billable tier: ${newTier}`);
  }

  const client = getClient();
  const response = await client.subscriptionsApi.swapPlan(subscriptionId, {
    newPlanVariationId: tierConfig.planVariationId,
  });
  logger.info('Square subscription plan swapped', { subscriptionId, newTier });
  return response.result?.subscription;
}

/**
 * Get subscription details from Square.
 */
async function getSquareSubscription(subscriptionId) {
  const client = getClient();
  const response = await client.subscriptionsApi.retrieveSubscription(subscriptionId);
  return response.result?.subscription;
}

/**
 * Handle Square webhook event. Updates our DB to match Square state.
 */
async function handleWebhook(event) {
  const eventType = event.type;
  const data = event.data?.object;

  logger.info('Square webhook received', { eventType, eventId: event.event_id });

  // Dedup: skip if we've already processed this event
  if (event.event_id) {
    const existing = await query(
      'SELECT id FROM subscription_events WHERE square_event_id = $1',
      [event.event_id]
    );
    if (existing.rows.length > 0) {
      logger.info('Duplicate webhook event, skipping', { eventId: event.event_id });
      return;
    }
  }

  if (eventType === 'subscription.created' || eventType === 'subscription.updated') {
    const subscription = data?.subscription;
    if (!subscription) return;

    const squareCustomerId = subscription.customer_id;
    const subscriptionId = subscription.id;
    const status = subscription.status; // ACTIVE, CANCELED, PAUSED, PENDING, DEACTIVATED

    // Consolidated user lookup — single query with OR conditions
    let userResult = await query(
      `SELECT id, subscription_tier FROM users
       WHERE square_customer_id = $1 OR square_subscription_id = $2
       LIMIT 1`,
      [squareCustomerId, subscriptionId]
    );

    if (userResult.rows.length === 0) {
      // Fallback: look up email from Square customer directory
      try {
        const client = getClient();
        const customerResponse = await client.customersApi.retrieveCustomer(squareCustomerId);
        const email = customerResponse.result?.customer?.emailAddress;
        if (email) {
          userResult = await query(
            'SELECT id, subscription_tier FROM users WHERE email = $1',
            [email.toLowerCase().trim()]
          );
        }
      } catch (err) {
        logger.error('Failed to look up Square customer', { squareCustomerId, error: err.message });
      }
    }

    if (userResult.rows.length === 0) {
      logger.warn('No matching user for Square subscription', { squareCustomerId, subscriptionId });
      return;
    }

    const user = userResult.rows[0];
    const oldTier = user.subscription_tier;

    // Determine tier from plan variation ID
    const planVariationId = subscription.plan_variation_id;
    let newTier = 'free';
    for (const [tier, config] of Object.entries(TIER_CONFIG)) {
      if (config.planVariationId === planVariationId) {
        newTier = tier;
        break;
      }
    }

    // Map subscription status to our tier
    let effectiveTier = newTier;
    let machineLimit = TIER_CONFIG[newTier]?.machineLimit || 1;

    if (status === 'CANCELED' || status === 'DEACTIVATED') {
      effectiveTier = 'free';
      machineLimit = 1;
    }

    // Update user record
    await query(
      `UPDATE users SET
        subscription_tier = $1,
        square_customer_id = $2,
        square_subscription_id = $3,
        machine_limit = $4,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $5`,
      [effectiveTier, squareCustomerId, subscriptionId, machineLimit, user.id]
    );

    // Handle trial tracking
    if (subscription.start_date && !subscription.charged_through_date) {
      // In trial period — calculate trial_end as start + 7 days
      const trialStart = new Date(subscription.start_date);
      const trialEnd = new Date(trialStart);
      trialEnd.setDate(trialEnd.getDate() + 7);
      await query(
        `UPDATE users SET trial_start = $1, trial_end = $2 WHERE id = $3`,
        [trialStart, trialEnd, user.id]
      );
    }

    // Log the event
    const eventTypeMap = {
      ACTIVE: oldTier === 'free' ? 'upgrade' : (TIER_CONFIG[newTier]?.price > TIER_CONFIG[oldTier]?.price ? 'upgrade' : 'downgrade'),
      CANCELED: 'cancel',
      PAUSED: 'pause',
      PENDING: 'trial_start',
      DEACTIVATED: 'cancel',
    };

    await query(
      `INSERT INTO subscription_events (user_id, event_type, from_tier, to_tier, square_event_id, metadata)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        user.id,
        eventTypeMap[status] || 'unknown',
        oldTier,
        effectiveTier,
        event.event_id,
        JSON.stringify({ status, subscriptionId, planVariationId }),
      ]
    );

    logger.info('User subscription updated', {
      userId: user.id,
      oldTier,
      newTier: effectiveTier,
      status,
    });
  }

  if (eventType === 'invoice.payment_failed') {
    const invoice = data?.invoice;
    const subscriptionId = invoice?.subscription_id;
    if (!subscriptionId) return;

    const userResult = await query(
      'SELECT id FROM users WHERE square_subscription_id = $1',
      [subscriptionId]
    );

    if (userResult.rows.length > 0) {
      await query(
        `INSERT INTO subscription_events (user_id, event_type, metadata)
         VALUES ($1, 'payment_failed', $2)`,
        [userResult.rows[0].id, JSON.stringify({ invoiceId: invoice?.id, subscriptionId })]
      );

      logger.warn('Subscription payment failed', { userId: userResult.rows[0].id, subscriptionId });
    }
  }
}

/**
 * Verify Square webhook signature.
 */
function verifyWebhookSignature(body, signature, signatureKey) {
  if (!signatureKey) {
    logger.error('SQUARE_WEBHOOK_SIGNATURE_KEY not set — rejecting webhook');
    return false;
  }
  if (!signature) return false;

  const hmac = crypto.createHmac('sha256', signatureKey);
  const webhookUrl = process.env.SQUARE_WEBHOOK_URL || '';
  hmac.update(webhookUrl + body);
  const expectedSignature = hmac.digest('base64');

  // Timing-safe comparison to prevent signature brute-forcing
  const sigBuf = Buffer.from(signature, 'base64');
  const expBuf = Buffer.from(expectedSignature, 'base64');
  if (sigBuf.length !== expBuf.length) return false;
  return crypto.timingSafeEqual(sigBuf, expBuf);
}

module.exports = {
  TIER_CONFIG,
  createSubscriptionCheckout,
  cancelSubscription,
  pauseSubscription,
  resumeSubscription,
  changePlan,
  getSquareSubscription,
  handleWebhook,
  verifyWebhookSignature,
};
