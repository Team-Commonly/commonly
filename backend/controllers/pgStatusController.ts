import type { Request, Response } from 'express';

// eslint-disable-next-line global-require
const { pool } = require('../config/db-pg');
// eslint-disable-next-line global-require
const User = require('../models/User');

exports.checkStatus = async (_req: Request, res: Response): Promise<void> => {
  try {
    if (!pool) {
      res.json({ available: false });
      return;
    }
    const result = await pool.query(
      "SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='messages' LIMIT 1",
    );
    res.json({ available: result.rowCount > 0 });
  } catch (err) {
    const e = err as { message?: string };
    console.error('PG status check failed:', e.message);
    res.json({ available: false });
  }
};

exports.syncUser = async (req: Request & { userId?: string }, res: Response): Promise<void> => {
  try {
    const user = await User.findById((req as unknown as { userId?: string }).userId);

    if (!user) {
      res.status(404).json({ msg: 'User not found' });
      return;
    }

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
    const e = err as { message?: string };
    console.error('Error syncing user to PostgreSQL for chat:', e.message);
    res.status(500).send('Server Error');
  }
};
