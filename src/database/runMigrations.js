const { pool } = require('../config/database');
const fs = require('fs');
const path = require('path');

async function runMigrations() {
  const migrationsDir = path.join(__dirname, 'migrations');
  const migrationFiles = fs.readdirSync(migrationsDir).sort();

  console.log('Starting database migrations...\n');

  for (const file of migrationFiles) {
    if (!file.endsWith('.sql')) continue;

    try {
      console.log(`Running migration: ${file}`);
      const filePath = path.join(migrationsDir, file);
      const sql = fs.readFileSync(filePath, 'utf8');

      await pool.query(sql);
      console.log(`✓ ${file} completed successfully\n`);
    } catch (error) {
      console.error(`✗ Error running migration ${file}:`, error.message);
      process.exit(1);
    }
  }

  console.log('✓ All migrations completed successfully!');
  await pool.end();
  process.exit(0);
}

runMigrations();
