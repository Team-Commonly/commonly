import { runPgMigrations } from './run-pg-migrations';

const { pool } = require('./db-pg');

const initializeDatabase = async (): Promise<boolean> => {
  try {
    const applied = await runPgMigrations(pool);
    console.log(`PostgreSQL migrations ready (${applied.length} applied)`);
    return true;
  } catch (error) {
    console.error('Error initializing PostgreSQL database:', (error as Error).message);
    // pgBootService retries and keeps PG routes/readiness unavailable.
    return false;
  }
};

module.exports = initializeDatabase;
