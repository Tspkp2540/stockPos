const { Pool } = require('pg');

const hasDatabaseUrl = Boolean(process.env.DATABASE_URL);
const hasStandaloneConfig = Boolean(
  process.env.PGHOST ||
  process.env.DB_HOST ||
  process.env.PGUSER ||
  process.env.DB_USER ||
  process.env.PGDATABASE ||
  process.env.DB_NAME
);

const poolConfig = {};

if (hasDatabaseUrl) {
  poolConfig.connectionString = process.env.DATABASE_URL;
  poolConfig.ssl = { rejectUnauthorized: false };
} else if (hasStandaloneConfig) {
  poolConfig.host = process.env.PGHOST || process.env.DB_HOST || 'localhost';
  poolConfig.port = parseInt(process.env.PGPORT || process.env.DB_PORT || '5432', 10);
  poolConfig.user = process.env.PGUSER || process.env.DB_USER || 'postgres';
  poolConfig.password = process.env.PGPASSWORD || process.env.DB_PASSWORD || '';
  poolConfig.database = process.env.PGDATABASE || process.env.DB_NAME || 'postgres';

  if (process.env.PGSSLMODE && process.env.PGSSLMODE !== 'disable') {
    poolConfig.ssl = { rejectUnauthorized: false };
  }
} else {
  throw new Error(
    'Missing PostgreSQL configuration. Set DATABASE_URL or PGHOST/PGUSER/PGPASSWORD/PGDATABASE in environment variables.'
  );
}

const pool = new Pool(poolConfig);

pool.on('connect', () => {
  if (hasDatabaseUrl) {
    console.log('⚡ Connected to PostgreSQL Database using DATABASE_URL');
  } else {
    console.log(`⚡ Connected to PostgreSQL Database (${poolConfig.host}:${poolConfig.port})`);
  }
});

pool.on('error', (err) => {
  console.error('❌ Unexpected database error:', err);
});

module.exports = pool;