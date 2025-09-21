const { pool } = require('../../config/db-pg');

class Message {
  // Create a new message
  static async create(podId, userId, content, messageType = 'text') {
    console.log('Creating message with params:', {
      podId, userId, content, messageType, podIdType: typeof podId,
    });

    const query = `
      INSERT INTO messages (pod_id, user_id, content, message_type)
      VALUES ($1, $2, $3, $4)
      RETURNING *
    `;

    try {
      // For text messages, content contains the text
      // For image messages, content contains the image URL
      const result = await pool.query(query, [podId, userId, content || '', messageType]);

      // Update the pod's updated_at timestamp
      await pool.query(`
        UPDATE pods
        SET updated_at = CURRENT_TIMESTAMP
        WHERE id = $1
      `, [podId]);

      return result.rows[0];
    } catch (error) {
      console.error('SQL Error in Message.create:', error.message);
      console.error('Query parameters:', {
        podId, userId, content, messageType,
      });
      throw error;
    }
  }

  // Get messages for a pod with pagination
  static async findByPodId(podId, limit = 50, before = null) {
    try {
      let query = `
        SELECT 
          m.id, 
          m.pod_id, 
          m.user_id,
          m.content, 
          m.message_type,
          m.created_at, 
          m.updated_at,
          u._id as user_db_id,
          u.username, 
          u.profile_picture
        FROM messages m
        LEFT JOIN users u ON m.user_id = u._id
        WHERE m.pod_id = $1
      `;

      const queryParams = [podId];

      if (before) {
        query += ' AND m.created_at < $2';
        queryParams.push(before);
      }

      query += `
        ORDER BY m.created_at ASC
        LIMIT $${queryParams.length + 1}
      `;

      queryParams.push(limit);

      const result = await pool.query(query, queryParams);

      // Format the results to be consistent with both MongoDB format and frontend expectations
      return result.rows.map((msg) => {
        // Make sure we have both formats of IDs
        const messageId = msg.id ? msg.id.toString() : '';
        const userId = msg.user_id || '';

        return {
          // Original fields
          ...msg,

          // ID fields
          _id: messageId,
          id: messageId,

          // Content/text field consistency
          content: msg.content || '',
          text: msg.content || '',

          // Message type
          messageType: msg.message_type || 'text',

          // Date field consistency
          createdAt: msg.created_at,

          // User information - both as separate fields and as an object
          user_id: userId,
          userId: msg.username ? {
            _id: userId,
            username: msg.username || 'Unknown User',
            profilePicture: msg.profile_picture,
          } : userId, // If username isn't available, just use the ID
        };
      });
    } catch (error) {
      console.error('Error in findByPodId:', error.message);
      throw error;
    }
  }

  // Get a message by ID
  static async findById(id) {
    try {
      const query = `
        SELECT 
          m.id, 
          m.pod_id, 
          m.user_id,
          m.content, 
          m.message_type,
          m.created_at, 
          m.updated_at, 
          u._id as user_db_id,
          u.username, 
          u.profile_picture
        FROM messages m
        LEFT JOIN users u ON m.user_id = u._id
        WHERE m.id = $1
      `;

      const result = await pool.query(query, [id]);

      if (result.rows.length === 0) {
        return null;
      }

      // Format the message to be consistent
      const msg = result.rows[0];
      const messageId = msg.id ? msg.id.toString() : '';
      const userId = msg.user_id || '';

      return {
        // Original fields
        ...msg,

        // ID fields
        _id: messageId,
        id: messageId,

        // Content/text field consistency
        content: msg.content || '',
        text: msg.content || '',

        // Message type
        messageType: msg.message_type || 'text',

        // Date field consistency
        createdAt: msg.created_at,

        // User information
        user_id: userId,
        userId: msg.username ? {
          _id: userId,
          username: msg.username || 'Unknown User',
          profilePicture: msg.profile_picture,
        } : userId, // If username isn't available, just use the ID
      };
    } catch (error) {
      console.error('Error in findById:', error.message);
      throw error;
    }
  }

  // Update a message
  static async update(id, content) {
    const query = `
      UPDATE messages
      SET content = $1,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $2
      RETURNING *
    `;

    const result = await pool.query(query, [content, id]);
    return result.rows[0];
  }

  // Delete a message
  static async delete(id) {
    const query = `
      DELETE FROM messages
      WHERE id = $1
      RETURNING *
    `;

    const result = await pool.query(query, [id]);
    return result.rows[0];
  }

  // Delete all messages for a pod
  static async deleteByPodId(podId) {
    const query = `
      DELETE FROM messages
      WHERE pod_id = $1
      RETURNING *
    `;

    const result = await pool.query(query, [podId]);
    return result.rows;
  }
}

module.exports = Message;
