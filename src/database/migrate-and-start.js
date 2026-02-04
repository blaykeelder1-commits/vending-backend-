const { pool } = require('../config/database');
const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

async function ensureMigrationsTable() {
  const createTableQuery = `
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id SERIAL PRIMARY KEY,
      migration_name VARCHAR(255) UNIQUE NOT NULL,
      executed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `;
  await pool.query(createTableQuery);
}

async function getMigratedFiles() {
  const result = await pool.query(
    'SELECT migration_name FROM schema_migrations ORDER BY migration_name'
  );
  return new Set(result.rows.map(row => row.migration_name));
}

async function recordMigration(filename) {
  await pool.query(
    'INSERT INTO schema_migrations (migration_name) VALUES ($1) ON CONFLICT (migration_name) DO NOTHING',
    [filename]
  );
}

async function runMigrations() {
  const migrationsDir = path.join(__dirname, 'migrations');
  const migrationFiles = fs.readdirSync(migrationsDir).sort();

  logger.info('Starting database migrations');

  // Ensure migrations tracking table exists
  await ensureMigrationsTable();

  // Get already executed migrations
  const executedMigrations = await getMigratedFiles();

  let newMigrationsCount = 0;

  for (const file of migrationFiles) {
    if (!file.endsWith('.sql')) continue;

    // Skip if already executed
    if (executedMigrations.has(file)) {
      logger.debug('Migration already executed', { file });
      continue;
    }

    try {
      logger.info('Running migration', { file });
      const filePath = path.join(migrationsDir, file);
      const sql = fs.readFileSync(filePath, 'utf8');

      await pool.query(sql);
      await recordMigration(file);
      logger.info('Migration completed', { file });
      newMigrationsCount++;
    } catch (error) {
      logger.error('Migration failed', { file, error: error.message });
      process.exit(1);
    }
  }

  if (newMigrationsCount === 0) {
    logger.info('No new migrations to run');
  } else {
    logger.info('Migrations completed', { count: newMigrationsCount });
  }
}

runMigrations()
  .then(() => {
    logger.info('Starting server');
    require('../server');
  })
  .catch((err) => {
    logger.error('Migration failed', { error: err.message });
    process.exit(1);
  });
