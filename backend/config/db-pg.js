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

// Create a new pool
const pool = new Pool(pgConfig);

// Test the connection
const connectPG = async () => {
  try {
    console.log('Attempting to connect to PostgreSQL...');
    const client = await pool.connect();
    const result = await client.query('SELECT VERSION()');
    console.log('PostgreSQL connected: ', result.rows[0].version);
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
    // Don't exit the process, just log the error
    return null;
  }
};

module.exports = { pool, connectPG };
