const { Pool } = require('pg');

const poolConfig = {};

if (process.env.DATABASE_URL) {
  poolConfig.connectionString = process.env.DATABASE_URL;
  poolConfig.ssl = { rejectUnauthorized: false };
} else {
  poolConfig.host = process.env.PGHOST || process.env.DB_HOST || 'localhost';
  poolConfig.port = parseInt(process.env.PGPORT || process.env.DB_PORT || '5432', 10);
  poolConfig.user = process.env.PGUSER || process.env.DB_USER || 'postgres';
  poolConfig.password = process.env.PGPASSWORD || process.env.DB_PASSWORD || '';
  poolConfig.database = process.env.PGDATABASE || process.env.DB_NAME || 'postgres';

  if (process.env.PGSSLMODE && process.env.PGSSLMODE !== 'disable') {
    poolConfig.ssl = { rejectUnauthorized: false };
  }
}

const pool = new Pool(poolConfig);

pool.on('connect', () => {
  console.log(`⚡ Connected to PostgreSQL Database (${poolConfig.host}:${poolConfig.port})`);
});

pool.on('error', (err) => {
  console.error('❌ Unexpected database error:', err);
});

module.exports = pool;