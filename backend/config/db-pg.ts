// eslint-disable-next-line global-require
const fs = require('fs');
// eslint-disable-next-line global-require
const { Pool } = require('pg');
// eslint-disable-next-line global-require
require('dotenv').config();

interface PgConfig {
  user: string | undefined;
  password: string | undefined;
  host: string | undefined;
  port: number | string;
  database: string | undefined;
  ssl?: { rejectUnauthorized: boolean; ca: string } | false;
}

const pgConfig: PgConfig = {
  user: process.env.PG_USER,
  password: process.env.PG_PASSWORD,
  host: process.env.PG_HOST,
  port: process.env.PG_PORT || 5432,
  database: process.env.PG_DATABASE,
};

if (process.env.PG_SSL_CA_PATH) {
  try {
    const caPath = process.env.PG_SSL_CA_PATH;
    console.log(`Using CA certificate from: ${caPath}`);
    if (fs.existsSync(caPath)) {
      pgConfig.ssl = {
        rejectUnauthorized: true,
        ca: fs.readFileSync(caPath).toString() as string,
      };
      console.log('SSL configuration added with CA certificate');
    } else {
      console.warn(`CA certificate file not found at: ${caPath}`);
      pgConfig.ssl = false;
    }
  } catch (err) {
    const e = err as { message?: string };
    console.error('Error loading CA certificate:', e.message);
    pgConfig.ssl = false;
  }
} else {
  console.log('No CA certificate path provided, SSL disabled');
  pgConfig.ssl = false;
}

const pool: unknown = pgConfig.host ? new Pool(pgConfig) : null;

if (pool) {
  (pool as { on: (event: string, cb: (client: { query: (sql: string) => Promise<void> }) => void) => void }).on('connect', (client) => {
    client.query('SET default_transaction_read_only = off').catch(() => {});
  });
}

const connectPG = async (): Promise<unknown> => {
  if (!pool) {
    console.log('PostgreSQL not configured (PG_HOST not set), skipping connection');
    return null;
  }
  try {
    console.log('Attempting to connect to PostgreSQL...');
    const p = pool as { connect: () => Promise<{ query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, string>> }>; release(): void }> };
    const client = await p.connect();
    const result = await client.query('SELECT VERSION()');
    console.log('PostgreSQL connected: ', result.rows[0].version);

    const roResult = await client.query('SHOW default_transaction_read_only');
    if (roResult.rows[0].default_transaction_read_only === 'on') {
      console.warn('PostgreSQL default_transaction_read_only is ON — fixing...');
      await client.query('SET default_transaction_read_only = off');
      await client.query(
        `ALTER DATABASE ${pgConfig.database || 'defaultdb'} SET default_transaction_read_only = off`,
      );
      console.log('PostgreSQL default_transaction_read_only fixed to OFF');
    }

    client.release();
    return pool;
  } catch (err) {
    const e = err as { message?: string };
    console.error('PostgreSQL connection error:', e.message);
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

export {};
