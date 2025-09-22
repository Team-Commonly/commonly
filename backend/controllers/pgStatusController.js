const { pool } = require('../config/db-pg');
const User = require('../models/User');

// Check if PostgreSQL is available for chat functionality
exports.checkStatus = async (req, res) => {
  try {
    // If this route is registered, PostgreSQL is available
    res.json({ available: true });
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
};

// Sync a user from MongoDB to PostgreSQL for chat functionality
exports.syncUser = async (req, res) => {
  try {
    // Get the user from MongoDB
    const user = await User.findById(req.userId);

    if (!user) {
      return res.status(404).json({ msg: 'User not found' });
    }

    // Upsert the user in PostgreSQL for chat functionality
    const query = `
      INSERT INTO users (_id, username, profile_picture, updated_at)
      VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
      ON CONFLICT (_id) 
      DO UPDATE SET 
        username = $2,
        profile_picture = $3,
        updated_at = CURRENT_TIMESTAMP
      RETURNING *
    `;

    const result = await pool.query(query, [
      user._id.toString(),
      user.username,
      user.profilePicture || null,
    ]);

    console.log(
      `User ${user.username} synchronized with PostgreSQL for chat functionality`,
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error syncing user to PostgreSQL for chat:', err.message);
    res.status(500).send('Server Error');
  }
};
