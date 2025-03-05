const { pool } = require('../../config/db-pg');

class Message {
  // Create a new message
  static async create(podId, userId, content) {
    const query = `
      INSERT INTO messages (pod_id, user_id, content)
      VALUES ($1, $2, $3)
      RETURNING *
    `;
    
    const result = await pool.query(query, [podId, userId, content]);
    
    // Update the pod's updated_at timestamp
    await pool.query(`
      UPDATE pods
      SET updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
    `, [podId]);
    
    return result.rows[0];
  }
  
  // Get messages for a pod with pagination
  static async findByPodId(podId, limit = 50, before = null) {
    let query = `
      SELECT m.*, 
             u.username, 
             u.profile_picture
      FROM messages m
      LEFT JOIN users u ON m.user_id = u._id
      WHERE m.pod_id = $1
    `;
    
    const queryParams = [podId];
    
    if (before) {
      query += ` AND m.created_at < $2`;
      queryParams.push(before);
    }
    
    query += `
      ORDER BY m.created_at DESC
      LIMIT $${queryParams.length + 1}
    `;
    
    queryParams.push(limit);
    
    const result = await pool.query(query, queryParams);
    return result.rows;
  }
  
  // Get a message by ID
  static async findById(id) {
    const query = `
      SELECT m.*, 
             u.username, 
             u.profile_picture
      FROM messages m
      LEFT JOIN users u ON m.user_id = u._id
      WHERE m.id = $1
    `;
    
    const result = await pool.query(query, [id]);
    return result.rows[0];
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