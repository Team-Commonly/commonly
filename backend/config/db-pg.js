const fs = require('fs');
const { Pool } = require('pg');
require('dotenv').config();

// PostgreSQL connection configuration
const pgConfig = {
  user: process.env.PG_USER,
  password: process.env.PG_PASSWORD,
  host: process.env.PG_HOST,
  port: process.env.PG_PORT || 5432,
  database: process.env.PG_DATABASE,
};

// Add SSL configuration if CA path is provided
if (process.env.PG_SSL_CA_PATH) {
  try {
    const caPath = process.env.PG_SSL_CA_PATH;
    console.log(`Using CA certificate from: ${caPath}`);

    if (fs.existsSync(caPath)) {
      pgConfig.ssl = {
        rejectUnauthorized: true,
        ca: fs.readFileSync(caPath).toString(),
      };
      console.log('SSL configuration added with CA certificate');
    } else {
      console.warn(`CA certificate file not found at: ${caPath}`);
      pgConfig.ssl = false;
    }
  } catch (err) {
    console.error('Error loading CA certificate:', err.message);
    pgConfig.ssl = false;
  }
} else {
  console.log('No CA certificate path provided, SSL disabled');
  pgConfig.ssl = false;
}

// Skip pool creation entirely if no host is configured
const pool = pgConfig.host ? new Pool(pgConfig) : null;

// Ensure every new connection from the pool is writable.
// Aiven (and other managed PG) can flip default_transaction_read_only = on at the
// database or role level — this silently breaks all INSERTs. Guard at connection level.
if (pool) {
  pool.on('connect', (client) => {
    client.query('SET default_transaction_read_only = off').catch(() => {});
  });
}

// Test the connection and fix database-level read-only if needed
const connectPG = async () => {
  if (!pool) {
    console.log('PostgreSQL not configured (PG_HOST not set), skipping connection');
    return null;
  }
  try {
    console.log('Attempting to connect to PostgreSQL...');
    const client = await pool.connect();
    const result = await client.query('SELECT VERSION()');
    console.log('PostgreSQL connected: ', result.rows[0].version);

    // Check and fix database-level read-only default
    const roResult = await client.query('SHOW default_transaction_read_only');
    if (roResult.rows[0].default_transaction_read_only === 'on') {
      console.warn('PostgreSQL default_transaction_read_only is ON — fixing...');
      await client.query('SET default_transaction_read_only = off');
      await client.query(
        `ALTER DATABASE ${pgConfig.database || 'defaultdb'} SET default_transaction_read_only = off`
      );
      console.log('PostgreSQL default_transaction_read_only fixed to OFF');
    }

    client.release();
    return pool;
  } catch (err) {
    console.error('PostgreSQL connection error:', err.message);
    console.error('Connection details:', {
      host: pgConfig.host,
      port: pgConfig.port,
      database: pgConfig.database,
      user: pgConfig.user,
      ssl: pgConfig.ssl ? 'Enabled' : 'Disabled',
    });
    return null;
  }
};

module.exports = { pool, connectPG };
