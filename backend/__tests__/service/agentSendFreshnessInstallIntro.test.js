/**
 * F140 (TASK-772): a fresh agent's first claim was refused with unseen_messages,
 * every time, by its own install intro. The intro is stored under the agent's
 * own id with author_kind 'kernel', and a kernel row under the agent's id
 * counts as unseen on purpose: it is a notice the platform posted for it. The
 * intro is the agent introducing itself, so it is the one that does not.
 */
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
const otherAgentId = new mongoose.Types.ObjectId();
const personId = new mongoose.Types.ObjectId();

const insert = (userId, { kind = null, authorKind = null } = {}) => pool.query(
  `INSERT INTO messages (pod_id, user_id, content, author_kind, payload)
   VALUES ($1, $2, 'hello', $3, $4)`,
  [String(podId), String(userId), authorKind, kind ? JSON.stringify({ kind }) : null],
);

d('agent freshness: the agent\'s own install intro', () => {
  beforeAll(async () => {
    await mongoose.connect(process.env.MONGO_URI);
    await pool.query(fs.readFileSync(path.join(__dirname, '../../config/schema.sql'), 'utf8'));
    await pool.query(
      "INSERT INTO pods (id, name, type, created_by) VALUES ($1, 'intro', 'chat', $2)",
      [String(podId), String(personId)],
    );
    await pool.query("INSERT INTO users (_id, username) VALUES ($1, 'intro-person')", [String(personId)]);
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM messages WHERE pod_id = $1', [String(podId)]);
    await Cursor.deleteOne({ _id: `${agentId}:${podId}` });
  });

  afterAll(async () => {
    await Cursor.deleteOne({ _id: `${agentId}:${podId}` });
    await pool.query('DELETE FROM messages WHERE pod_id = $1', [String(podId)]);
    await pool.query('DELETE FROM pods WHERE id = $1', [String(podId)]);
    await pool.query('DELETE FROM users WHERE _id = $1', [String(personId)]);
    await mongoose.disconnect();
    await pool.end();
  });

  it('does not hold a fresh agent whose only pod row is its own intro', async () => {
    await insert(agentId, { authorKind: 'kernel', kind: 'install-intro' });
    expect(await Freshness.unseenMessages(agentId, podId)).toBeNull();
  });

  it('still holds on another kernel row under the agent\'s id', async () => {
    await insert(agentId, { authorKind: 'kernel', kind: 'install-intro' });
    await insert(agentId, { authorKind: 'kernel' });
    expect(await Freshness.unseenMessages(agentId, podId)).toMatchObject({ code: 'unseen_messages', unseenCount: 1 });
  });

  it('still holds on a person\'s message after the intro', async () => {
    await insert(agentId, { authorKind: 'kernel', kind: 'install-intro' });
    await insert(personId);
    const hold = await Freshness.unseenMessages(agentId, podId);
    expect(hold).toMatchObject({ unseenCount: 1 });
    expect(hold.messages[0].author).toBe('intro-person');
  });

  it('exempts only the agent\'s own intro: another agent\'s intro still holds', async () => {
    await insert(otherAgentId, { authorKind: 'kernel', kind: 'install-intro' });
    expect(await Freshness.unseenMessages(agentId, podId)).toMatchObject({ unseenCount: 1 });
  });

  it('stamps a read that returned nothing but the agent\'s own intro', async () => {
    await insert(agentId, { authorKind: 'kernel', kind: 'install-intro' });
    const start = await Freshness.readStart(podId);
    await Freshness.recordRead(agentId, podId, start, []);
    expect(await Cursor.findById(`${agentId}:${podId}`).lean()).toMatchObject({ readRevision: start.revision });
  });
});
