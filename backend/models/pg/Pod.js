const { pool } = require('../../config/db-pg');

class Pod {
  // Create a new pod
  static async create(name, description, type, createdBy) {
    const query = `
      INSERT INTO pods (name, description, type, created_by)
      VALUES ($1, $2, $3, $4)
      RETURNING *
    `;
    
    const result = await pool.query(query, [name, description, type, createdBy]);
    
    // Add creator as a member
    await this.addMember(result.rows[0].id, createdBy);
    
    return result.rows[0];
  }
  
  // Get all pods or filter by type
  static async findAll(type = null) {
    let query = `
      SELECT p.*, 
             json_agg(DISTINCT pm.user_id) AS members,
             u.username AS creator_username,
             u.profile_picture AS creator_profile_picture
      FROM pods p
      LEFT JOIN pod_members pm ON p.id = pm.pod_id
      LEFT JOIN users u ON p.created_by = u._id
      ${type ? 'WHERE p.type = $1' : ''}
      GROUP BY p.id, u.username, u.profile_picture
      ORDER BY p.updated_at DESC
    `;
    
    const result = type 
      ? await pool.query(query, [type])
      : await pool.query(query);
      
    return result.rows;
  }
  
  // Get a pod by ID
  static async findById(id) {
    const query = `
      SELECT p.*, 
             json_agg(DISTINCT pm.user_id) AS members,
             u.username AS creator_username,
             u.profile_picture AS creator_profile_picture
      FROM pods p
      LEFT JOIN pod_members pm ON p.id = pm.pod_id
      LEFT JOIN users u ON p.created_by = u._id
      WHERE p.id = $1
      GROUP BY p.id, u.username, u.profile_picture
    `;
    
    const result = await pool.query(query, [id]);
    return result.rows[0];
  }
  
  // Update a pod
  static async update(id, name, description) {
    const query = `
      UPDATE pods
      SET name = $1, 
          description = $2,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $3
      RETURNING *
    `;
    
    const result = await pool.query(query, [name, description, id]);
    return result.rows[0];
  }
  
  // Delete a pod
  static async delete(id) {
    const query = `
      DELETE FROM pods
      WHERE id = $1
      RETURNING *
    `;
    
    const result = await pool.query(query, [id]);
    return result.rows[0];
  }
  
  // Add a member to a pod
  static async addMember(podId, userId) {
    const query = `
      INSERT INTO pod_members (pod_id, user_id)
      VALUES ($1, $2)
      ON CONFLICT (pod_id, user_id) DO NOTHING
      RETURNING *
    `;
    
    const result = await pool.query(query, [podId, userId]);
    
    // Update the pod's updated_at timestamp
    await pool.query(`
      UPDATE pods
      SET updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
    `, [podId]);
    
    return result.rows[0];
  }
  
  // Remove a member from a pod
  static async removeMember(podId, userId) {
    const query = `
      DELETE FROM pod_members
      WHERE pod_id = $1 AND user_id = $2
      RETURNING *
    `;
    
    const result = await pool.query(query, [podId, userId]);
    return result.rows[0];
  }
  
  // Check if a user is a member of a pod
  static async isMember(podId, userId) {
    const query = `
      SELECT * FROM pod_members
      WHERE pod_id = $1 AND user_id = $2
    `;
    
    const result = await pool.query(query, [podId, userId]);
    return result.rows.length > 0;
  }
}

module.exports = Pod; 