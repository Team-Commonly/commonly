/** A timestamp cannot fence an INSERT whose transaction commits after a read. */
/* eslint-disable import/extensions, import/no-unresolved -- backend TypeScript modules expose CJS exports. */
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { pool } = require('../../config/db-pg');
const Cursor = require('../../models/AgentPodReadCursor');
const Freshness = require('../../services/agentSendFreshness');

const d = process.env.INTEGRATION_TEST === 'true' ? describe : describe.skip;
const podId = new mongoose.Types.ObjectId();
const agentId = new mongoose.Types.ObjectId();
const peerId = new mongoose.Types.ObjectId();

d('agent freshness: in-flight PostgreSQL insert', () => {
  beforeAll(async () => {
    await mongoose.connect(process.env.MONGO_URI);
    await pool.query(fs.readFileSync(path.join(__dirname, '../../config/schema.sql'), 'utf8'));
    await pool.query(
      "INSERT INTO pods (id, name, type, created_by) VALUES ($1, 'fence', 'chat', $2)",
      [String(podId), String(peerId)],
    );
    await pool.query(
      "INSERT INTO users (_id, username) VALUES ($1, 'fence-peer')",
      [String(peerId)],
    );
  });

  afterAll(async () => {
    await Cursor.deleteOne({ _id: `${agentId}:${podId}` });
    await pool.query('DELETE FROM pods WHERE id = $1', [String(podId)]);
    await pool.query('DELETE FROM users WHERE _id = $1', [String(peerId)]);
    await mongoose.disconnect();
    await pool.end();
  });

  it('holds a peer message that began before the read but committed afterward', async () => {
    const writer = await pool.connect();
    try {
      await writer.query('BEGIN');
      const inserted = await writer.query(
        'INSERT INTO messages (pod_id, user_id, content) VALUES ($1, $2, $3) RETURNING created_at',
        [String(podId), String(peerId), 'committed after the read'],
      );
      await new Promise((resolve) => { setTimeout(resolve, 20); });
      const start = await Freshness.readStart(podId);
      expect(inserted.rows[0].created_at.getTime()).toBeLessThanOrEqual(start.at.getTime());
      expect(await pool.query('SELECT id FROM messages WHERE pod_id = $1', [String(podId)]))
        .toMatchObject({ rows: [] });
      await Freshness.recordRead(agentId, podId, start);
      await writer.query('COMMIT');
      const hold = await Freshness.unseenMessages(agentId, podId);
      expect(hold).toMatchObject({ code: 'unseen_messages', unseenCount: 1 });
      expect(hold.messages[0].content).toBe('committed after the read');
    } finally {
      await writer.query('ROLLBACK').catch(() => undefined);
      writer.release();
    }
  });
});
