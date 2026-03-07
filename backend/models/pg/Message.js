const { pool } = require('../../config/db-pg');

class Message {
  // Create a new message
  static async create(podId, userId, content, messageType = 'text', replyToMessageId = null) {
    console.log('Creating message with params:', {
      podId,
      userId,
      content,
      messageType,
      podIdType: typeof podId,
    });

    const query = `
      INSERT INTO messages (pod_id, user_id, content, message_type, reply_to_message_id)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
    `;

    try {
      // For text messages, content contains the text
      // For image messages, content contains the image URL
      const result = await pool.query(query, [
        podId,
        userId,
        content || '',
        messageType,
        replyToMessageId || null,
      ]);

      // Update the pod's updated_at timestamp
      await pool.query(
        `
        UPDATE pods
        SET updated_at = CURRENT_TIMESTAMP
        WHERE id = $1
      `,
        [podId],
      );

      return result.rows[0];
    } catch (error) {
      console.error('SQL Error in Message.create:', error.message);
      console.error('Query parameters:', {
        podId,
        userId,
        content,
        messageType,
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
          m.reply_to_message_id,
          m.created_at,
          m.updated_at,
          u._id as user_db_id,
          u.username,
          u.profile_picture,
          rm.id as reply_msg_id,
          rm.content as reply_content,
          rm.user_id as reply_user_id,
          ru.username as reply_username
        FROM messages m
        LEFT JOIN users u ON m.user_id = u._id
        LEFT JOIN messages rm ON m.reply_to_message_id = rm.id
        LEFT JOIN users ru ON rm.user_id = ru._id
        WHERE m.pod_id = $1
      `;

      const queryParams = [podId];

      if (before) {
        query += ' AND m.created_at < $2';
        queryParams.push(before);
      }

      query += `
        ORDER BY m.created_at DESC
        LIMIT $${queryParams.length + 1}
      `;

      queryParams.push(limit);

      const result = await pool.query(query, queryParams);

      // Return newest messages first, then flip to chronological for UI rendering
      const rows = result.rows.slice().reverse();

      // Format the results to be consistent with both MongoDB format and frontend expectations
      return rows.map((msg) => {
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
          userId: msg.username
            ? {
              _id: userId,
              username: msg.username || 'Unknown User',
              profilePicture: msg.profile_picture,
            }
            : userId, // If username isn't available, just use the ID

          // Reply/quote reference
          replyTo: msg.reply_msg_id
            ? {
              id: msg.reply_msg_id.toString(),
              content: (msg.reply_content || '').slice(0, 150),
              username: msg.reply_username || 'Unknown',
              userId: msg.reply_user_id || '',
            }
            : null,
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
          m.reply_to_message_id,
          m.created_at,
          m.updated_at,
          u._id as user_db_id,
          u.username,
          u.profile_picture,
          rm.id as reply_msg_id,
          rm.content as reply_content,
          rm.user_id as reply_user_id,
          ru.username as reply_username
        FROM messages m
        LEFT JOIN users u ON m.user_id = u._id
        LEFT JOIN messages rm ON m.reply_to_message_id = rm.id
        LEFT JOIN users ru ON rm.user_id = ru._id
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
        userId: msg.username
          ? {
            _id: userId,
            username: msg.username || 'Unknown User',
            profilePicture: msg.profile_picture,
          }
          : userId, // If username isn't available, just use the ID

        // Reply/quote reference
        replyTo: msg.reply_msg_id
          ? {
            id: msg.reply_msg_id.toString(),
            content: (msg.reply_content || '').slice(0, 150),
            username: msg.reply_username || 'Unknown',
            userId: msg.reply_user_id || '',
          }
          : null,
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
