import { createHash } from 'crypto';
import { readdirSync, readFileSync } from 'fs';
import path from 'path';
import type { Pool } from 'pg';

// A session lock: every boot keeps one checked-out connection until unlock.
// Two int32 keys namespace it separately from application advisory locks.
const LOCK = [1129270605, 504];

export async function runPgMigrations(
  pool: Pool,
  directory = path.join(__dirname, 'migrations'),
): Promise<string[]> {
  const names = readdirSync(directory).filter((name) => name.endsWith('.sql')).sort();
  if (!names.length) throw new Error('PostgreSQL migrations are missing');
  const versions = new Set<string>();
  const migrations = names.map((name) => {
    if (!/^\d{4}_[a-z0-9_]+\.sql$/.test(name) || versions.has(name.slice(0, 4))) {
      throw new Error(`Invalid or duplicate PostgreSQL migration version: ${name}`);
    }
    versions.add(name.slice(0, 4));
    const sql = readFileSync(path.join(directory, name), 'utf8');
    if (!sql.trim()) throw new Error(`Empty PostgreSQL migration: ${name}`);
    return { name, sql, checksum: createHash('sha256').update(sql).digest('hex') };
  });

  const client = await pool.connect();
  let locked = false;
  let discard = false;
  const applied: string[] = [];
  let failure: { error: unknown } | undefined;
  try {
    await client.query('SELECT pg_advisory_lock($1::integer, $2::integer)', LOCK);
    locked = true;
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      checksum TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);
    const history = await client.query<{ version: string; checksum: string }>(
      'SELECT version, checksum FROM schema_migrations ORDER BY version',
    );
    // Refuse edited, removed, or inserted-before-history files. A migration
    // name alone cannot prove this image carries the SQL that actually ran.
    history.rows.forEach((row, index) => {
      const migration = migrations[index];
      if (migration?.name !== row.version || migration.checksum !== row.checksum) {
        throw new Error(`PostgreSQL migration history mismatch: ${row.version}`);
      }
    });
    for (const migration of migrations.slice(history.rows.length)) {
      await client.query('BEGIN');
      try {
        await client.query(migration.sql);
        await client.query('INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)',
          [migration.name, migration.checksum]);
        await client.query('COMMIT');
      } catch (error) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // Never pool a connection in an unknown transaction state.
          discard = true;
        }
        throw error;
      }
      applied.push(migration.name);
    }
  } catch (error) {
    failure = { error };
  } finally {
    try {
      if (locked) await client.query('SELECT pg_advisory_unlock($1::integer, $2::integer)', LOCK);
    } catch {
      // Destroy the session if unlock fails; it may still hold the lock.
      discard = true;
      failure ??= { error: new Error('Could not release PostgreSQL migration lock') };
    } finally {
      client.release(discard);
    }
  }
  if (failure) throw failure.error;
  return applied;
}
