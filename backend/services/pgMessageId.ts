// Shared by PG reads and thread validation so both accept reconciled client IDs.
// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const { pool } = require('../config/db-pg');

export async function resolvePgMessageId(id: string | number): Promise<string | null> {
  const raw = String(id);
  // A Mongo ObjectId can contain only digits; test its shape first.
  if (/^[0-9a-f]{24}$/i.test(raw)) {
    const result = await pool.query('SELECT id FROM messages WHERE legacy_mongo_id = $1 LIMIT 1', [raw]);
    return result.rows[0]?.id != null ? String(result.rows[0].id) : null;
  }
  return /^\d+$/.test(raw) ? raw : null;
}
