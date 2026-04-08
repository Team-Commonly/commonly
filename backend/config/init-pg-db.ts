// eslint-disable-next-line global-require
const fs = require('fs');
// eslint-disable-next-line global-require
const path = require('path');
// eslint-disable-next-line global-require
const { pool } = require('./db-pg');

const initializeDatabase = async (): Promise<boolean> => {
  try {
    console.log('Initializing PostgreSQL database...');
    const p = pool as {
      connect: () => Promise<{
        query: (sql: string) => Promise<void>;
        release(): void;
      }>;
    };
    const client = await p.connect();

    const schemaPath = path.join(__dirname, 'schema.sql') as string;
    if (!fs.existsSync(schemaPath)) {
      console.error(`Schema file not found at: ${schemaPath}`);
      client.release();
      return false;
    }

    const schema = fs.readFileSync(schemaPath, 'utf8') as string;
    await client.query(schema);

    console.log('PostgreSQL schema created successfully');
    client.release();
    return true;
  } catch (err) {
    const e = err as { message?: string };
    console.error('Error initializing PostgreSQL database:', e.message);
    return false;
  }
};

module.exports = initializeDatabase;

export {};
