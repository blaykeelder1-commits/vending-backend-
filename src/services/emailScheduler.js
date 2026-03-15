/**
 * Email Scheduler Service
 * Processes scheduled emails from the database and sends them
 * Run this as a cron job or call processScheduledEmails() periodically
 */

const { query } = require('../config/database');
const { sendEmail } = require('./emailService');
const logger = require('../utils/logger');

/**
 * Process all pending scheduled emails that are due
 * @returns {Object} Results of processing { processed, sent, failed }
 */
async function processScheduledEmails() {
  const results = { processed: 0, sent: 0, failed: 0, errors: [] };

  try {
    // Get all pending emails that are due (scheduled_for <= NOW)
    const pendingResult = await query(`
      SELECT se.id, se.user_id, se.email, se.template_name, se.template_data,
             u.full_name as user_name
      FROM scheduled_emails se
      LEFT JOIN users u ON se.user_id = u.id
      WHERE se.status = 'pending'
        AND se.scheduled_for <= NOW()
      ORDER BY se.scheduled_for ASC
      LIMIT 50
    `);

    const pendingEmails = pendingResult.rows;
    results.processed = pendingEmails.length;

    if (pendingEmails.length === 0) {
      return results;
    }


    for (const email of pendingEmails) {
      try {
        // Prepare template data
        const templateData = {
          userName: email.user_name || 'there',
          ...(email.template_data || {}),
        };

        // Enrich onboarding day 10 with estimated savings stats
        if (email.template_name === 'onboardingDay10') {
          try {
            const machineCount = await query(
              `SELECT COUNT(*) as count FROM machines WHERE vendor_id = $1`,
              [email.user_id]
            );
            const count = parseInt(machineCount.rows[0].count) || 1;
            templateData.stats = {
              estimatedMonthlySavings: (count * 75).toString(),
            };
          } catch (statsErr) {
            templateData.stats = { estimatedMonthlySavings: '50-150' };
          }
        }

        // Send the email
        const sendResult = await sendEmail(email.email, email.template_name, templateData);

        if (sendResult.success) {
          // Mark as sent
          await query(`
            UPDATE scheduled_emails
            SET status = 'sent', sent_at = NOW()
            WHERE id = $1
          `, [email.id]);

          // Log to email_log
          await query(`
            INSERT INTO email_log (user_id, email, template_name, subject, status, external_id)
            VALUES ($1, $2, $3, $4, 'sent', $5)
          `, [email.user_id, email.email, email.template_name, email.template_name, sendResult.id || null]);

          results.sent++;
        } else {
          throw new Error(sendResult.error || 'Unknown send error');
        }
      } catch (error) {
        // Mark as failed with error message
        await query(`
          UPDATE scheduled_emails
          SET status = 'failed', error_message = $2
          WHERE id = $1
        `, [email.id, error.message]);

        // Log the failure
        await query(`
          INSERT INTO email_log (user_id, email, template_name, status, error_message)
          VALUES ($1, $2, $3, 'failed', $4)
        `, [email.user_id, email.email, email.template_name, error.message]);

        results.failed++;
        results.errors.push({ id: email.id, email: email.email, error: error.message });
      }
    }

    return results;

  } catch (error) {
    throw error;
  }
}

/**
 * Check for inactive users and schedule re-engagement emails
 * Users who haven't logged in for 7+ days get a re-engagement email
 */
async function scheduleReEngagementEmails() {
  const results = { checked: 0, scheduled: 0 };

  try {
    // Find users who:
    // 1. Haven't logged in for 7+ days
    // 2. Don't already have a pending re-engagement email
    // 3. Haven't received a re-engagement email in the last 14 days
    const inactiveResult = await query(`
      SELECT u.id, u.email, u.full_name
      FROM users u
      WHERE u.role = 'vendor'
        AND u.last_login_at < NOW() - INTERVAL '7 days'
        AND u.email_verified = true
        AND NOT EXISTS (
          SELECT 1 FROM scheduled_emails se
          WHERE se.user_id = u.id
            AND se.template_name = 'reEngagement'
            AND se.status = 'pending'
        )
        AND NOT EXISTS (
          SELECT 1 FROM email_log el
          WHERE el.user_id = u.id
            AND el.template_name = 'reEngagement'
            AND el.created_at > NOW() - INTERVAL '14 days'
        )
      LIMIT 100
    `);

    results.checked = inactiveResult.rows.length;

    for (const user of inactiveResult.rows) {
      try {
        await query(`
          INSERT INTO scheduled_emails (user_id, email, template_name, scheduled_for, status)
          VALUES ($1, $2, 'reEngagement', NOW(), 'pending')
          ON CONFLICT (user_id, template_name) DO NOTHING
        `, [user.id, user.email]);

        results.scheduled++;
      } catch (error) {
      }
    }

    if (results.scheduled > 0) {
    }

    return results;
  } catch (error) {
    logger.error('Error scheduling re-engagement emails', { error: error.message });
    throw error;
  }
}

/**
 * Clean up old processed emails (older than 30 days)
 */
async function cleanupOldEmails() {
  try {
    const result = await query(`
      DELETE FROM scheduled_emails
      WHERE status IN ('sent', 'failed', 'cancelled')
        AND (sent_at < NOW() - INTERVAL '30 days' OR created_at < NOW() - INTERVAL '30 days')
    `);

    if (result.rowCount > 0) {
    }

    return { deleted: result.rowCount };
  } catch (error) {
    throw error;
  }
}

/**
 * Get scheduler statistics
 */
async function getSchedulerStats() {
  try {
    const result = await query(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'pending') as pending,
        COUNT(*) FILTER (WHERE status = 'sent') as sent,
        COUNT(*) FILTER (WHERE status = 'failed') as failed,
        COUNT(*) FILTER (WHERE status = 'cancelled') as cancelled,
        COUNT(*) FILTER (WHERE status = 'pending' AND scheduled_for <= NOW()) as due_now
      FROM scheduled_emails
    `);

    return result.rows[0];
  } catch (error) {
    throw error;
  }
}

/**
 * Send spoilage alerts for products expiring within 7 days
 * Sends directly (not scheduled) since these are time-sensitive
 */
async function scheduleSpoilageAlerts() {
  const results = { checked: 0, sent: 0, errors: [] };

  try {
    // Find vendors with products expiring within 7 days (stock > 0, email verified)
    const vendorsResult = await query(`
      SELECT DISTINCT u.id, u.email, u.full_name
      FROM users u
      JOIN machines m ON m.vendor_id = u.id
      JOIN machine_inventory mi ON mi.machine_id = m.id
      WHERE u.role = 'vendor'
        AND u.email_verified = true
        AND mi.current_stock > 0
        AND mi.expiration_date IS NOT NULL
        AND mi.expiration_date <= NOW() + INTERVAL '7 days'
        AND NOT EXISTS (
          SELECT 1 FROM email_log el
          WHERE el.user_id = u.id
            AND el.template_name = 'spoilageAlert'
            AND el.created_at > NOW() - INTERVAL '24 hours'
        )
      LIMIT 100
    `);

    results.checked = vendorsResult.rows.length;

    for (const vendor of vendorsResult.rows) {
      try {
        // Get expiring products grouped by machine
        const productsResult = await query(`
          SELECT
            m.id as machine_id,
            m.machine_name,
            m.location,
            p.product_name,
            mi.current_stock,
            mi.expiration_date,
            CEIL(EXTRACT(EPOCH FROM (mi.expiration_date - NOW())) / 86400) as days_until_expiry
          FROM machine_inventory mi
          JOIN machines m ON mi.machine_id = m.id
          JOIN products p ON mi.product_id = p.id
          WHERE m.vendor_id = $1
            AND mi.current_stock > 0
            AND mi.expiration_date IS NOT NULL
            AND mi.expiration_date <= NOW() + INTERVAL '7 days'
          ORDER BY mi.expiration_date ASC
        `, [vendor.id]);

        if (productsResult.rows.length === 0) continue;

        // Group by machine
        const machineMap = {};
        for (const row of productsResult.rows) {
          if (!machineMap[row.machine_id]) {
            machineMap[row.machine_id] = {
              machineName: row.machine_name,
              location: row.location,
              products: [],
            };
          }
          machineMap[row.machine_id].products.push({
            productName: row.product_name,
            stock: row.current_stock,
            daysUntilExpiry: parseInt(row.days_until_expiry),
          });
        }

        const alertData = {
          totalProducts: productsResult.rows.length,
          machines: Object.values(machineMap),
        };

        // Send directly (time-sensitive)
        const sendResult = await sendEmail(vendor.email, 'spoilageAlert', {
          userName: vendor.full_name || 'there',
          ...alertData,
        });

        if (sendResult.success) {
          // Log to email_log for dedup
          await query(`
            INSERT INTO email_log (user_id, email, template_name, subject, status, external_id)
            VALUES ($1, $2, 'spoilageAlert', 'Spoilage Alert', 'sent', $3)
          `, [vendor.id, vendor.email, sendResult.id || null]);
          results.sent++;
        }
      } catch (error) {
        results.errors.push({ vendorId: vendor.id, error: error.message });
        logger.error('Spoilage alert error for vendor', { vendorId: vendor.id, error: error.message });
      }
    }

    return results;
  } catch (error) {
    logger.error('Error in scheduleSpoilageAlerts', { error: error.message });
    throw error;
  }
}

/**
 * Process onboarding emails for users based on their registration date.
 * Acts as a safety net: schedules onboarding emails for users who may not
 * have had them scheduled at registration time (e.g., existing users before
 * the onboarding sequence was added).
 * Safe to run multiple times -- checks for existing scheduled/sent emails.
 */
async function processOnboardingEmails() {
  const results = { checked: 0, scheduled: 0 };

  const onboardingSteps = [
    { day: 2, template: 'onboardingDay2' },
    { day: 5, template: 'onboardingDay5' },
    { day: 10, template: 'onboardingDay10' },
    { day: 13, template: 'onboardingDay13' },
  ];

  try {
    for (const step of onboardingSteps) {
      // Find users who registered X days ago (within a 24-hour window)
      // and don't already have this email scheduled or sent
      const usersResult = await query(`
        SELECT u.id, u.email, u.full_name
        FROM users u
        WHERE u.role = 'vendor'
          AND u.email_verified = true
          AND u.created_at >= NOW() - INTERVAL '${step.day} days' - INTERVAL '12 hours'
          AND u.created_at <= NOW() - INTERVAL '${step.day} days' + INTERVAL '12 hours'
          AND NOT EXISTS (
            SELECT 1 FROM scheduled_emails se
            WHERE se.user_id = u.id
              AND se.template_name = $1
              AND se.status IN ('pending', 'sent')
          )
          AND NOT EXISTS (
            SELECT 1 FROM email_log el
            WHERE el.user_id = u.id
              AND el.template_name = $1
              AND el.status = 'sent'
          )
        LIMIT 100
      `, [step.template]);

      results.checked += usersResult.rows.length;

      for (const user of usersResult.rows) {
        try {
          await query(`
            INSERT INTO scheduled_emails (user_id, email, template_name, scheduled_for, status)
            VALUES ($1, $2, $3, NOW(), 'pending')
            ON CONFLICT DO NOTHING
          `, [user.id, user.email, step.template]);

          results.scheduled++;
        } catch (err) {
          logger.error('Error scheduling onboarding email', {
            userId: user.id,
            template: step.template,
            error: err.message,
          });
        }
      }
    }

    if (results.scheduled > 0) {
      logger.info('Onboarding emails scheduled', results);
    }

    return results;
  } catch (error) {
    logger.error('Error in processOnboardingEmails', { error: error.message });
    throw error;
  }
}

/**
 * Run all scheduler tasks (call this from cron)
 */
async function runSchedulerTasks() {

  const results = {
    timestamp: new Date().toISOString(),
    onboarding: null,
    reEngagement: null,
    processing: null,
    cleanup: null,
    spoilageAlerts: null,
  };

  try {
    // 1. Schedule onboarding emails for users at day 2, 5, 10, 13
    results.onboarding = await processOnboardingEmails();

    // 2. Schedule re-engagement emails for inactive users
    results.reEngagement = await scheduleReEngagementEmails();

    // 3. Process all due scheduled emails
    results.processing = await processScheduledEmails();

    // 4. Clean up old records
    results.cleanup = await cleanupOldEmails();

    // 5. Send spoilage alerts
    results.spoilageAlerts = await scheduleSpoilageAlerts();

    return results;
  } catch (error) {
    results.error = error.message;
    return results;
  }
}

module.exports = {
  processScheduledEmails,
  processOnboardingEmails,
  scheduleReEngagementEmails,
  scheduleSpoilageAlerts,
  cleanupOldEmails,
  getSchedulerStats,
  runSchedulerTasks,
};
