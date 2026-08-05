const { Pool } = require('pg');

const env = process.env;
const databaseUrl = env.DATABASE_URL || env.RAILWAY_DATABASE_URL || env.PG_DATABASE_URL || env.POSTGRES_URL;
const hasStandaloneConfig = Boolean(
  env.PGHOST ||
  env.DB_HOST ||
  env.PGUSER ||
  env.DB_USER ||
  env.PGDATABASE ||
  env.DB_NAME
);

console.log('🔎 PostgreSQL env debug:', {
  DATABASE_URL: Boolean(env.DATABASE_URL),
  RAILWAY_DATABASE_URL: Boolean(env.RAILWAY_DATABASE_URL),
  PG_DATABASE_URL: Boolean(env.PG_DATABASE_URL),
  POSTGRES_URL: Boolean(env.POSTGRES_URL),
  PGHOST: env.PGHOST || env.DB_HOST || null,
  PGPORT: env.PGPORT || env.DB_PORT || null,
  PGUSER: Boolean(env.PGUSER || env.DB_USER),
  PGDATABASE: env.PGDATABASE || env.DB_NAME || null,
  PGSSLMODE: env.PGSSLMODE || null
});

const poolConfig = {};

if (databaseUrl) {
  poolConfig.connectionString = databaseUrl;
  poolConfig.ssl = { rejectUnauthorized: false };
} else if (hasStandaloneConfig) {
  poolConfig.host = env.PGHOST || env.DB_HOST || 'localhost';
  poolConfig.port = parseInt(env.PGPORT || env.DB_PORT || '5432', 10);
  poolConfig.user = env.PGUSER || env.DB_USER || 'postgres';
  poolConfig.password = env.PGPASSWORD || env.DB_PASSWORD || '';
  poolConfig.database = env.PGDATABASE || env.DB_NAME || 'postgres';

  if (env.PGSSLMODE && env.PGSSLMODE !== 'disable') {
    poolConfig.ssl = { rejectUnauthorized: false };
  }
} else {
  const availableVars = Object.keys(env)
    .filter((key) => /^(DATABASE_URL|RAILWAY_DATABASE_URL|PG_DATABASE_URL|POSTGRES_URL|PGHOST|PGPORT|PGUSER|PGPASSWORD|PGDATABASE|DB_HOST|DB_PORT|DB_USER|DB_PASSWORD|DB_NAME|PGSSLMODE)$/i.test(key))
    .sort();
  console.error('❌ PostgreSQL config not found in environment. Available related vars:', availableVars.join(', ') || '(none)');
  throw new Error(
    'Missing PostgreSQL configuration. Set DATABASE_URL or PGHOST/PGUSER/PGPASSWORD/PGDATABASE in environment variables.'
  );
}

const pool = new Pool(poolConfig);

pool.on('connect', () => {
  if (databaseUrl) {
    console.log('⚡ Connected to PostgreSQL Database using DATABASE_URL');
  } else {
    console.log(`⚡ Connected to PostgreSQL Database (${poolConfig.host}:${poolConfig.port})`);
  }
});

pool.on('error', (err) => {
  console.error('❌ Unexpected database error:', err);
});

module.exports = pool;