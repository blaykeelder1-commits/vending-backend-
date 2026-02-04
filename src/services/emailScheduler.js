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
 * Run all scheduler tasks (call this from cron)
 */
async function runSchedulerTasks() {

  const results = {
    timestamp: new Date().toISOString(),
    reEngagement: null,
    processing: null,
    cleanup: null,
  };

  try {
    // 1. Schedule re-engagement emails for inactive users
    results.reEngagement = await scheduleReEngagementEmails();

    // 2. Process all due scheduled emails
    results.processing = await processScheduledEmails();

    // 3. Clean up old records
    results.cleanup = await cleanupOldEmails();

    return results;
  } catch (error) {
    results.error = error.message;
    return results;
  }
}

module.exports = {
  processScheduledEmails,
  scheduleReEngagementEmails,
  cleanupOldEmails,
  getSchedulerStats,
  runSchedulerTasks,
};
