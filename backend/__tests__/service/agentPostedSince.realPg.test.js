/* eslint-disable import/no-unresolved, import/extensions -- TypeScript modules expose CJS exports. */
/**
 * F242: the posted-since query on real PostgreSQL. pg-mem covers the delivery
 * mark in agent-event-posted-since-mark.test.js, but it has passed SQL that
 * broke on Postgres before, so the predicate that leaves out a kernel notice
 * (`author_kind IS NULL OR author_kind <> 'kernel'`) is read here by the real
 * planner, on the migrated schema.
 */
const { runPgMigrations } = require('../../config/run-pg-migrations');
const { createRealPgSchema } = require('../utils/realPgSchema');

// The service reads `pool` from config/db-pg lazily; agentPostedSince takes it
// as an argument, so this holder only keeps module load off a real connection.
const mockDbPg = {};
jest.mock('../../config/db-pg', () => mockDbPg);

const real = process.env.INTEGRATION_TEST === 'true' ? describe : describe.skip;
const POD = 'aaaaaaaaaaaaaaaaaaaaaa42';
const OWNER = 'bbbbbbbbbbbbbbbbbbbbbb42';
const AGENT = 'cccccccccccccccccccccc42';
const OTHER_POD = 'aaaaaaaaaaaaaaaaaaaaaa43';

real('agentPostedSince on real PostgreSQL (F242)', () => {
  let database;
  let pool;
  let agentPostedSince;
  const since = () => new Date(Date.now() - 5 * 60 * 1000);
  const insert = (podId, userId, content, { type = 'text', kind = null, minutesAgo }) => pool.query(
    `INSERT INTO messages (pod_id, user_id, content, message_type, author_kind, created_at)
     VALUES ($1, $2, $3, $4, $5, now() - make_interval(mins => $6))`,
    [podId, userId, content, type, kind, minutesAgo],
  );

  beforeEach(async () => {
    database = await createRealPgSchema();
    pool = database.pool;
    mockDbPg.pool = pool;
    await runPgMigrations(pool);
    await pool.query("INSERT INTO users (_id, username, is_bot) VALUES ($1, 'owner', false), ($2, 'otto', true)", [OWNER, AGENT]);
    await pool.query(
      "INSERT INTO pods (id, name, type, created_by) VALUES ($1, 'Checkout', 'team', $3), ($2, 'Elsewhere', 'team', $3)",
      [POD, OTHER_POD, OWNER],
    );
    jest.isolateModules(() => {
      // eslint-disable-next-line global-require -- loaded after the pool holder is filled
      ({ agentPostedSince } = require('../../services/unansweredMentionService'));
    });
  });
  afterEach(async () => {
    if (database) await database.close();
  });

  it('counts the agent\'s own post after the cutoff, whose author_kind is NULL', async () => {
    await insert(POD, AGENT, 'Yes, 11 is done.', { minutesAgo: 2 });

    await expect(agentPostedSince(pool, AGENT, POD, since(), { excludeKernel: true })).resolves.toBe(true);
    await expect(agentPostedSince(pool, AGENT, POD, since())).resolves.toBe(true);
  });

  it('leaves out a kernel notice stored as text under the agent, only on the mark path', async () => {
    await insert(POD, AGENT, "Otto couldn't finish that turn.", { kind: 'kernel', minutesAgo: 2 });

    await expect(agentPostedSince(pool, AGENT, POD, since(), { excludeKernel: true })).resolves.toBe(false);
    // noteUnansweredMention's reading is unchanged: any non-system row counts.
    await expect(agentPostedSince(pool, AGENT, POD, since())).resolves.toBe(true);
  });

  it('a kernel notice beside a real post still counts the post', async () => {
    await insert(POD, AGENT, "Otto couldn't finish that turn.", { kind: 'kernel', minutesAgo: 3 });
    await insert(POD, AGENT, 'Yes, 11 is done.', { minutesAgo: 1 });

    await expect(agentPostedSince(pool, AGENT, POD, since(), { excludeKernel: true })).resolves.toBe(true);
  });

  // F237: with `answering`, only a post where an answer to those messages would
  // sit counts: top level, a reply to one, or the thread of one.
  it('with answering, counts top level, the thread and a reply, and not another thread', async () => {
    const [{ id: root }] = (await pool.query(
      "INSERT INTO messages (pod_id, user_id, content, created_at) VALUES ($1, $2, 'root', now() - interval '20 minutes') RETURNING id",
      [POD, OWNER],
    )).rows;
    const [{ id: asked }] = (await pool.query(
      `INSERT INTO messages (pod_id, user_id, content, thread_root_id, created_at)
       VALUES ($1, $2, '@otto?', $3, now() - interval '10 minutes') RETURNING id`,
      [POD, OWNER, root],
    )).rows;
    const [{ id: elsewhere }] = (await pool.query(
      "INSERT INTO messages (pod_id, user_id, content, created_at) VALUES ($1, $2, 'other', now() - interval '20 minutes') RETURNING id",
      [POD, OWNER],
    )).rows;
    // Only the asked message's id: its thread is read from its row, as for a
    // welcome wake whose payload names no thread.
    const answering = [asked];
    const agentPost = async (threadRootId, replyTo) => {
      await pool.query('DELETE FROM messages WHERE user_id = $1', [AGENT]);
      await pool.query(
        `INSERT INTO messages (pod_id, user_id, content, thread_root_id, reply_to_message_id, created_at)
         VALUES ($1, $2, 'a post', $3, $4, now() - interval '1 minute')`,
        [POD, AGENT, threadRootId, replyTo],
      );
      return agentPostedSince(pool, AGENT, POD, since(), { answering });
    };

    await expect(agentPost(null, null)).resolves.toBe(true);
    await expect(agentPost(root, null)).resolves.toBe(true);
    await expect(agentPost(elsewhere, asked)).resolves.toBe(true);
    await expect(agentPost(elsewhere, null)).resolves.toBe(false);
    // Without it, the post elsewhere still counts, as noteUnansweredMention read it before.
    await expect(agentPostedSince(pool, AGENT, POD, since())).resolves.toBe(true);
  });

  it('counts nothing before the cutoff, nothing system, and nothing in another pod', async () => {
    await insert(POD, AGENT, 'an older answer', { minutesAgo: 9 });
    await insert(POD, AGENT, "Otto didn't answer this", { type: 'system', minutesAgo: 2 });
    await insert(OTHER_POD, AGENT, 'elsewhere', { minutesAgo: 2 });
    await insert(POD, OWNER, 'the person', { minutesAgo: 1 });

    await expect(agentPostedSince(pool, AGENT, POD, since(), { excludeKernel: true })).resolves.toBe(false);
    await expect(agentPostedSince(pool, AGENT, POD, since())).resolves.toBe(false);
  });
});
