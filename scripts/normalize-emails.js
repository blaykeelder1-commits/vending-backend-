/**
 * One-time script to normalize all existing email addresses in the database
 * This fixes users who registered before email normalization was implemented
 *
 * Run with: node scripts/normalize-emails.js
 */

require('dotenv').config();
const { query } = require('../src/config/database');

async function normalizeEmails() {
  console.log('Starting email normalization...');

  try {
    // Update all user emails to lowercase and trimmed
    const result = await query(
      `UPDATE users
       SET email = LOWER(TRIM(email))
       WHERE email != LOWER(TRIM(email))
       RETURNING id, email`
    );

    console.log(`Successfully normalized ${result.rowCount} email addresses`);

    if (result.rowCount > 0) {
      console.log('Updated emails:');
      result.rows.forEach(row => {
        console.log(`  - User ID ${row.id}: ${row.email}`);
      });
    } else {
      console.log('No emails needed normalization - all emails were already lowercase and trimmed');
    }

    process.exit(0);
  } catch (error) {
    console.error('Error normalizing emails:', error);
    process.exit(1);
  }
}

normalizeEmails();
