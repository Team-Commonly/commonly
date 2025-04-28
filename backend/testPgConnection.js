const { pool, connectPG } = require('./config/db-pg');
require('dotenv').config();

async function testConnection() {
  console.log('Testing PostgreSQL connection...');
  console.log('Environment variables:');
  console.log({
    PG_HOST: process.env.PG_HOST,
    PG_PORT: process.env.PG_PORT,
    PG_DATABASE: process.env.PG_DATABASE,
    PG_USER: process.env.PG_USER,
    PG_PASSWORD: process.env.PG_PASSWORD ? '[REDACTED]' : 'not set',
    PG_SSL_CA_PATH: process.env.PG_SSL_CA_PATH,
  });

  try {
    const conn = await connectPG();
    if (conn) {
      console.log('PostgreSQL connection successful!');

      // Test queries
      try {
        const client = await pool.connect();
        console.log('Testing basic query...');
        const result = await client.query('SELECT NOW()');
        console.log('Query result:', result.rows[0]);

        // Check if required tables exist
        console.log('Checking if pods table exists...');
        const tablesResult = await client.query(`
          SELECT EXISTS (
            SELECT FROM information_schema.tables 
            WHERE table_schema = 'public' 
            AND table_name = 'pods'
          );
        `);

        console.log('Pods table exists:', tablesResult.rows[0].exists);

        client.release();
      } catch (queryErr) {
        console.error('Error running test queries:', queryErr);
      }
    } else {
      console.error('Connection failed.');
    }
  } catch (err) {
    console.error('Error in test script:', err);
  } finally {
    // Close the pool
    await pool.end();
    console.log('Connection pool closed');
  }
}

testConnection();
