const { Pool } = require('pg');

// Railway จะส่งค่า DATABASE_URL เข้ามาให้อัตโนมัติเมื่อทำการ Link Postgres Service
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

pool.on('connect', () => {
  console.log('⚡ Connected to Railway PostgreSQL Database');
});

pool.on('error', (err) => {
  console.error('❌ Unexpected database error:', err);
});

module.exports = pool;