// @ts-nocheck
// Test script to validate PostgreSQL setup
const { pool } = require('./config/db-pg');

async function testPG() {
  try {
    // 1. Test connection
    console.log('Testing PostgreSQL connection...');
    await pool.query('SELECT NOW()');
    console.log('Connection successful!');

    // 2. Check table structures
    console.log('\nChecking table structures:');
    const tables = ['pods', 'pod_members', 'messages', 'users'];

    for (const table of tables) {
      try {
        const result = await pool.query(
          `
          SELECT column_name, data_type, character_maximum_length
          FROM information_schema.columns
          WHERE table_name = $1
          ORDER BY ordinal_position
        `,
          [table],
        );

        console.log(`\nTable: ${table}`);
        console.table(result.rows);
      } catch (err: unknown) {
        console.error(`Error checking table ${table}:`, ((err) as Error).message);
      }
    }

    // 3. Create test pod with MongoDB-style ID
    const testPodId = '111111111111111111111111'; // MongoDB-style ObjectId (24 chars)
    console.log('\nTrying to create a test pod with ID:', testPodId);

    try {
      await pool.query(
        `
        INSERT INTO pods (id, name, description, type, created_by)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (id) DO NOTHING
      `,
        [testPodId, 'Test Pod', 'Test description', 'chat', 'test_user'],
      );

      console.log('Test pod creation successful!');
    } catch (err: unknown) {
      console.error('Error creating test pod:', ((err) as Error).message);
    }

    // 4. Query the test pod
    try {
      const result = await pool.query('SELECT * FROM pods WHERE id = $1', [
        testPodId,
      ]);
      console.log('\nTest pod query result:', result.rows[0] || 'No pod found');
    } catch (err: unknown) {
      console.error('Error querying test pod:', ((err) as Error).message);
    }

    // 5. Test creating a message
    try {
      console.log('\nTrying to create a test message for pod:', testPodId);
      await pool.query(
        `
        INSERT INTO messages (pod_id, user_id, content)
        VALUES ($1, $2, $3)
      `,
        [testPodId, 'test_user', 'Test message content'],
      );

      console.log('Test message creation successful!');
    } catch (err: unknown) {
      console.error('Error creating test message:', ((err) as Error).message);
    }
  } catch (err: unknown) {
    console.error('General error:', err);
  } finally {
    // Close the connection pool
    await pool.end();
  }
}

if (require.main === module) {
  // Run the test when executed directly
  testPG();
}

module.exports = testPG;
export {};
