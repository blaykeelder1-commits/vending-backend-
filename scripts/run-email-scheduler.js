#!/usr/bin/env node
/**
 * Email Scheduler CLI Script
 * Run this via cron job to process scheduled emails
 *
 * Example cron (every 5 minutes):
 * */5 * * * * cd /path/to/vending-backend && node scripts/run-email-scheduler.js >> /var/log/email-scheduler.log 2>&1
 *
 * Or for Windows Task Scheduler, run:
 * node C:\path\to\vending-backend\scripts\run-email-scheduler.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { runSchedulerTasks, getSchedulerStats } = require('../src/services/emailScheduler');
const { pool } = require('../src/config/database');

async function main() {
  const startTime = Date.now();
  console.log(`\n=== Email Scheduler Started: ${new Date().toISOString()} ===`);

  try {
    // Get pre-run stats
    const beforeStats = await getSchedulerStats();
    console.log('Before:', beforeStats);

    // Run all scheduler tasks
    const results = await runSchedulerTasks();

    // Get post-run stats
    const afterStats = await getSchedulerStats();
    console.log('After:', afterStats);

    const duration = Date.now() - startTime;
    console.log(`\n=== Completed in ${duration}ms ===\n`);

    // Exit successfully
    process.exit(0);
  } catch (error) {
    console.error('Scheduler failed:', error);
    process.exit(1);
  } finally {
    // Close database connection
    await pool.end();
  }
}

main();
