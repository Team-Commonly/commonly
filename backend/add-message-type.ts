// @ts-nocheck
// Migration script to add message_type column to messages table
const { pool } = require('./config/db-pg');

async function addMessageTypeColumn() {
  try {
    console.log('Starting migration to add message_type column...');

    // Check if column already exists
    const checkColumnQuery = `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'messages' AND column_name = 'message_type'
    `;

    const columnResult = await pool.query(checkColumnQuery);

    if (columnResult.rows.length > 0) {
      console.log('Column message_type already exists in messages table');
      return;
    }

    // Add the message_type column
    const alterTableQuery = `
      ALTER TABLE messages
      ADD COLUMN message_type VARCHAR(20) DEFAULT 'text' NOT NULL
    `;

    await pool.query(alterTableQuery);
    console.log('Successfully added message_type column to messages table');
  } catch (error: unknown) {
    console.error('Migration failed:', ((error) as Error).message);
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  // Run the migration only when executed directly
  addMessageTypeColumn();
}

module.exports = addMessageTypeColumn;
export {};
