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
      await Freshness.recordRead(agentId, podId, start, []);
      await writer.query('COMMIT');
      const hold = await Freshness.unseenMessages(agentId, podId);
      expect(hold).toMatchObject({ code: 'unseen_messages', unseenCount: 1 });
      expect(hold.messages[0].content).toBe('committed after the read');
    } finally {
      await writer.query('ROLLBACK').catch(() => undefined);
      writer.release();
    }
  });
  it.each([false, true])('catches up a large PostgreSQL backlog without losing the commit fence (cursor: %s)', async (existing) => {
    await pool.query('DELETE FROM messages WHERE pod_id = $1', [String(podId)]);
    await Cursor.deleteOne({ _id: `${agentId}:${podId}` });
    if (existing) await Cursor.create({ _id: `${agentId}:${podId}`, agentUserId: agentId,
      podId, readAt: new Date(0), readRevision: 0 });
    await pool.query(`INSERT INTO messages (pod_id, user_id, content)
      SELECT $1, $2, 'history ' || n FROM generate_series(1, 2400) AS n`, [String(podId), String(peerId)]);
    const start = await Freshness.readStart(podId);
    const tail = await pool.query('SELECT id FROM messages WHERE pod_id = $1 ORDER BY id DESC LIMIT 20', [String(podId)]);
    const ids = tail.rows.map((row) => String(row.id));
    await Freshness.recordRead(agentId, podId, start, ids);
    expect((await Freshness.unseenMessages(agentId, podId)).unseenCount).toBe(2400);
    const writer = await pool.connect();
    try {
      await writer.query('BEGIN');
      await writer.query('INSERT INTO messages (pod_id, user_id, content) VALUES ($1, $2, $3)',
        [String(podId), String(peerId), 'later committed peer']);
      expect(await Freshness.recordCatchUp(agentId, podId, start, ids)).toEqual({ skippedCount: 2380 });
      await writer.query('COMMIT');
      const hold = await Freshness.unseenMessages(agentId, podId);
      expect(hold).toMatchObject({ unseenCount: 1 });
      expect(hold.messages[0].content).toBe('later committed peer');
    } finally {
      await writer.query('ROLLBACK').catch(() => undefined);
      writer.release();
    }
  });

  it('a trigger-revisioned claim line creates no send hold; ordinary peer chat still does', async () => {
    const { emitSystemActionLine } = require('../../services/systemActionLineService');
    await pool.query('DELETE FROM messages WHERE pod_id = $1', [String(podId)]);
    await Cursor.deleteOne({ _id: `${agentId}:${podId}` });
    const before = await Freshness.readStart(podId);
    await Freshness.recordRead(agentId, podId, before, []);
    await emitSystemActionLine({ podId: String(podId), actorUserId: String(peerId),
      actorName: 'fence-peer', action: 'task-claimed', taskId: 'TASK-406' });
    const { rows: [line] } = await pool.query('SELECT freshness_revision FROM messages WHERE pod_id = $1', [String(podId)]);
    expect(Number(line.freshness_revision)).toBeGreaterThan(before.revision);
    expect(await Freshness.unseenMessages(agentId, podId)).toBeNull();
    const after = await Freshness.readStart(podId);
    await Freshness.recordRead(agentId, podId, after, []);
    expect((await Cursor.findById(`${agentId}:${podId}`).lean()).readRevision).toBe(after.revision);
    await pool.query('INSERT INTO messages (pod_id, user_id, content) VALUES ($1, $2, $3)',
      [String(podId), String(peerId), 'ordinary peer chat']);
    expect(await Freshness.unseenMessages(agentId, podId)).toMatchObject({ unseenCount: 1,
      messages: [{ content: 'ordinary peer chat' }] });
  });

  // F490: the CAP post route exempts exactly the message that woke the agent.
  it('exempts exactly the listed ids: older unread and later messages still hold', async () => {
    await pool.query('DELETE FROM messages WHERE pod_id = $1', [String(podId)]);
    await Cursor.deleteOne({ _id: `${agentId}:${podId}` });
    const insert = async (content) => (await pool.query(
      'INSERT INTO messages (pod_id, user_id, content) VALUES ($1, $2, $3) RETURNING id',
      [String(podId), String(peerId), content],
    )).rows[0].id;
    await insert('older unread');
    const trigger = await insert('@codex please check');
    await insert('a later line');
    const hold = await Freshness.unseenMessages(agentId, podId, { exemptMessageIds: [String(trigger)] });
    expect(hold.unseenCount).toBe(2);
    expect(hold.messages.map((m) => m.content).sort()).toEqual(['a later line', 'older unread']);
    await pool.query('DELETE FROM messages WHERE pod_id = $1 AND id <> $2', [String(podId), trigger]);
    expect(await Freshness.unseenMessages(agentId, podId, { exemptMessageIds: [String(trigger)] })).toBeNull();
    expect(await Freshness.unseenMessages(agentId, podId, { exemptMessageIds: ['not-a-pg-id'] }))
      .toMatchObject({ unseenCount: 1 });
  });

});
