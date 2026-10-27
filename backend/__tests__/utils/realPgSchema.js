const { randomUUID } = require('crypto');
const { Pool } = require('pg');

// Isolate DDL tests without dropping a shared database. Each pool connection
// uses the same private schema, including checked-out migration sessions.
async function createRealPgSchema() {
  const config = {
    host: process.env.PG_HOST,
    port: Number(process.env.PG_PORT || 5432),
    user: process.env.PG_USER,
    password: process.env.PG_PASSWORD,
    database: process.env.PG_DATABASE,
    ssl: false,
    connectionTimeoutMillis: 5000,
  };
  const schema = `test_migrations_${randomUUID().replace(/-/g, '')}`;
  const admin = new Pool(config);
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
  } catch (error) {
    await admin.end();
    throw error;
  }
  const pool = new Pool({ ...config, options: `-c search_path=${schema}`, max: 6 });
  return {
    pool,
    close: async () => {
      await pool.end();
      try {
        await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      } finally {
        await admin.end();
      }
    },
  };
}
module.exports = { createRealPgSchema };
