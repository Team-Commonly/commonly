/* eslint-disable import/no-unresolved, import/extensions -- TypeScript modules expose CJS exports. */
/**
 * F297: the stopped line's dedupe and write on real PostgreSQL. pg-mem has its
 * own parser (review-checklist rule 55), and the check filters on a jsonb field.
 */
const { runPgMigrations } = require('../../config/run-pg-migrations');
const { createRealPgSchema } = require('../utils/realPgSchema');

const mockDbPg = {};
jest.mock('../../config/db-pg', () => mockDbPg);

const {
  emitRemovedLine, emitStoppedLine, hasRemovedLineSince, hasStoppedLineSince,
} = require('../../services/systemActionLineService');

const { findPreviousNonSilentMessage } = require('../../services/systemExchangeTriggers');

const real = process.env.INTEGRATION_TEST === 'true' ? describe : describe.skip;
const POD = 'aaaaaaaaaaaaaaaaaaaaaa01';
const OTHER_POD = 'aaaaaaaaaaaaaaaaaaaaaa02';
const USER = 'bbbbbbbbbbbbbbbbbbbbbb01';

real('the stopped line on real PostgreSQL (F297)', () => {
  let database;
  let pool;
  let messageId;

  beforeEach(async () => {
    database = await createRealPgSchema();
    pool = database.pool;
    mockDbPg.pool = pool;
    await runPgMigrations(pool);
    await pool.query("INSERT INTO users (_id, username, is_bot) VALUES ($1, 'nova', true)", [USER]);
    await pool.query(
      "INSERT INTO pods (id, name, type, created_by) VALUES ($1, 'One', 'chat', $3), ($2, 'Two', 'chat', $3)",
      [POD, OTHER_POD, USER],
    );
    const { rows } = await pool.query(
      "INSERT INTO messages (pod_id, user_id, content) VALUES ($1, $2, '@nova hello') RETURNING id",
      [POD, USER],
    );
    messageId = rows[0].id;
    await emitStoppedLine({
      podId: POD,
      actorUserId: USER,
      actorUsername: 'nova',
      actorIsBot: true,
      agentLabel: 'Nova',
      agentKey: 'nova:default',
      messageId,
    });
  });
  afterEach(async () => {
    mockDbPg.pool = undefined;
    if (database) await database.close();
  });

  const anHourAgo = () => new Date(Date.now() - 3600000);

  it('stores a system line that replies to the mention and finds it again', async () => {
    const { rows } = await pool.query("SELECT * FROM messages WHERE message_type = 'system'");
    expect(rows).toHaveLength(1);
    expect(String(rows[0].reply_to_message_id)).toBe(String(messageId));
    expect(await hasStoppedLineSince(POD, 'nova:default', anHourAgo())).toBe(true);
  });

  it("doesn't let one agent's line silence another's, or reach another pod", async () => {
    expect(await hasStoppedLineSince(POD, 'milo:default', anHourAgo())).toBe(false);
    expect(await hasStoppedLineSince(OTHER_POD, 'nova:default', anHourAgo())).toBe(false);
  });

  it("is never read as the agent's own last turn, though it's stored under the agent", async () => {
    expect(await findPreviousNonSilentMessage(POD, USER)).toBe('@nova hello');
  });

  it('keeps a removed line apart from a stopped one', async () => {
    expect(await hasRemovedLineSince(POD, 'nova:default', anHourAgo())).toBe(false);
    await emitRemovedLine({
      podId: POD,
      actorUserId: USER,
      actorUsername: 'nova',
      actorIsBot: true,
      agentLabel: 'Nova',
      agentKey: 'nova:default',
      messageId,
    });
    expect(await hasRemovedLineSince(POD, 'nova:default', anHourAgo())).toBe(true);
    expect(await hasRemovedLineSince(OTHER_POD, 'nova:default', anHourAgo())).toBe(false);
  });

  it('ignores a line from before the window, so a second stop is told again', async () => {
    expect(await hasStoppedLineSince(POD, 'nova:default', new Date(Date.now() + 3600000))).toBe(false);
  });
});
