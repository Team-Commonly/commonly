interface PgPool {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { ObjectId } = require('mongodb') as { ObjectId: new () => { toString(): string } };
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { pool } = require('../../config/db-pg') as { pool: PgPool };

interface PodRow {
  id: string;
  name: string;
  description?: string;
  type?: string;
  created_by?: string;
  updated_at?: string;
  members?: string[];
  creator_username?: string;
  creator_profile_picture?: string;
}

class Pod {
  static async create(
    name: string,
    description: string,
    type: string,
    createdBy: string,
    customId: string | null = null,
  ): Promise<PodRow> {
    const podId = customId || new ObjectId().toString();
    const query = `
      INSERT INTO pods (id, name, description, type, created_by)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
    `;
    const result = await (pool as PgPool).query(query, [podId, name, description, type, createdBy]);
    await Pod.addMember((result.rows[0] as unknown as PodRow).id, createdBy);
    return result.rows[0] as unknown as PodRow;
  }

  static async findAll(type: string | null = null): Promise<PodRow[]> {
    const query = `
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
      ? await (pool as PgPool).query(query, [type])
      : await (pool as PgPool).query(query);
    return result.rows as unknown as PodRow[];
  }

  static async findById(id: string): Promise<PodRow | undefined> {
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
    const result = await (pool as PgPool).query(query, [id]);
    return result.rows[0] as unknown as PodRow | undefined;
  }

  static async update(id: string, name: string, description: string): Promise<PodRow | undefined> {
    const query = `
      UPDATE pods
      SET name = $1,
          description = $2,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $3
      RETURNING *
    `;
    const result = await (pool as PgPool).query(query, [name, description, id]);
    return result.rows[0] as unknown as PodRow | undefined;
  }

  static async delete(id: string): Promise<PodRow | undefined> {
    const query = `DELETE FROM pods WHERE id = $1 RETURNING *`;
    const result = await (pool as PgPool).query(query, [id]);
    return result.rows[0] as unknown as PodRow | undefined;
  }

  static async addMember(podId: string, userId: string): Promise<unknown> {
    console.log(`Attempting to add member to pod. PodID: ${podId}, UserID: ${userId}`);
    try {
      const query = `
        INSERT INTO pod_members (pod_id, user_id)
        VALUES ($1, $2)
        ON CONFLICT (pod_id, user_id) DO NOTHING
        RETURNING *
      `;
      const result = await (pool as PgPool).query(query, [podId, userId]);
      console.log('Member addition result:', result.rows);
      await (pool as PgPool).query(
        'UPDATE pods SET updated_at = CURRENT_TIMESTAMP WHERE id = $1',
        [podId],
      );
      return result.rows[0];
    } catch (error) {
      const e = error as { message?: string };
      console.error('Error adding member to pod:', e.message);
      console.error('Parameters:', { podId, userId });
      throw error;
    }
  }

  static async removeMember(podId: string, userId: string): Promise<unknown> {
    const query = `DELETE FROM pod_members WHERE pod_id = $1 AND user_id = $2 RETURNING *`;
    const result = await (pool as PgPool).query(query, [podId, userId]);
    return result.rows[0];
  }

  static async isMember(podId: string, userId: string): Promise<boolean> {
    console.log('Checking membership with params:', { podId, userId, podIdType: typeof podId });
    const query = `SELECT * FROM pod_members WHERE pod_id = $1 AND user_id = $2`;
    try {
      const result = await (pool as PgPool).query(query, [podId, userId]);
      return result.rows.length > 0;
    } catch (error) {
      const e = error as { message?: string };
      console.error('SQL Error in Pod.isMember:', e.message);
      console.error('Query parameters:', { podId, userId });
      throw error;
    }
  }
}

export default Pod;
export { Pod, PodRow };
