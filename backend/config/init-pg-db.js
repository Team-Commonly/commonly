const fs = require('fs');
const path = require('path');
const { pool } = require('./db-pg');

const initializeDatabase = async () => {
  try {
    console.log('Initializing PostgreSQL database...');
    const client = await pool.connect();
    
    // Read the schema file
    const schemaPath = path.join(__dirname, 'schema.sql');
    if (!fs.existsSync(schemaPath)) {
      console.error(`Schema file not found at: ${schemaPath}`);
      client.release();
      return false;
    }
    
    const schema = fs.readFileSync(schemaPath, 'utf8');
    
    // Execute the schema
    await client.query(schema);
    
    console.log('PostgreSQL schema created successfully');
    client.release();
    return true;
  } catch (err) {
    console.error('Error initializing PostgreSQL database:', err.message);
    return false;
  }
};

module.exports = initializeDatabase; 