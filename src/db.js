const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST || 'db',
  port: Number(process.env.DB_PORT || 5432),
  user: process.env.DB_USER || 'chorequest',
  password: process.env.DB_PASSWORD || 'chorequest',
  database: process.env.DB_NAME || 'chorequest'
});

module.exports = pool;
