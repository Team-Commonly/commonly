/**
 * Regression tests for the "who posted?" family of bugs (#757).
 *
 * The BYO wrapper decides whether to echo its CLI output by asking the server
 * for recent pod messages and looking for one it believes it wrote. Three
 * separate defects made that answer wrong:
 *
 *  1. The wrapper could only test `isBot`, i.e. "did ANY bot post?", so in a
 *     multi-agent pod whichever agent finished second had its whole reply
 *     silently dropped. The fix is a server-computed `self` flag — the client
 *     cannot derive its own bot username safely (LEGACY_AGENT_MAP is
 *     server-only and instanceId is owner-scoped at install).
 *  2. The Mongo fallback path populated `userId` WITHOUT `isBot`, so every
 *     message on that path reported `isBot: false` and self-post detection was
 *     dead outright — guaranteed double-posting whenever PG was unavailable.
 *  3. The PG path fabricated `isBot` from a username substring test, so a
 *     human named "talbot" read as a bot and suppressed an agent's reply.
 *
 * Plus the sibling in hasRecentDuplicateUrls: it matched ANY author, so a
 * human posting a link silenced the agent's next heartbeat post.
 */

const AgentMessageService = require('../../../services/agentMessageService');
const Message = require('../../../models/Message');
const PGMessage = require('../../../models/pg/Message');

jest.mock('../../../models/Message');
jest.mock('../../../models/pg/Message', () => ({ findByPodId: jest.fn() }));

const POD = 'pod-1';
const SELF = 'agent-user-1';
const OTHER = 'agent-user-2';

// Mongo path: Message.find(...).where(...).lt(...).sort(...).limit(...).populate(...).lean()
const mockMongoChain = (rows) => {
  const query = {};
  query.where = jest.fn().mockReturnValue(query);
  query.lt = jest.fn().mockReturnValue(query);
  query.sort = jest.fn().mockReturnValue(query);
  query.limit = jest.fn().mockReturnValue(query);
  query.populate = jest.fn().mockReturnValue(query);
  query.lean = jest.fn().mockResolvedValue(rows);
  Message.find.mockReturnValue(query);
  return query;
};

describe('getRecentMessages — PG path', () => {
  const origPgHost = process.env.PG_HOST;
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.PG_HOST = 'localhost';
  });
  afterAll(() => {
    if (origPgHost === undefined) delete process.env.PG_HOST;
    else process.env.PG_HOST = origPgHost;
  });

  test('stamps an explicit `self` boolean on every message when the caller identifies itself', async () => {
    PGMessage.findByPodId.mockResolvedValue([
      {
        id: 1, user_id: SELF, username: 'me-bot', is_bot: true, content: 'mine', 
      },
      {
        id: 2, user_id: OTHER, username: 'other-bot', is_bot: true, content: 'theirs', 
      },
    ]);

    const out = await AgentMessageService.getRecentMessages(POD, 10, SELF);

    expect(out.map((m) => m.self)).toEqual([true, false]);
  });

  test('passes the exclusive history cursor to PostgreSQL', async () => {
    const beforeMs = Date.parse('2026-08-01T00:00:00.000Z');
    PGMessage.findByPodId.mockResolvedValue([]);

    await AgentMessageService.getRecentMessages(POD, 10, SELF, beforeMs);

    expect(PGMessage.findByPodId).toHaveBeenCalledWith(
      // Fourth argument is the thread scope (TASK-052) — null when the
      // caller asked for the pod, which is this case.
      POD, 10, new Date(beforeMs).toISOString(), null,
    );
  });

  test.each([
    ['a raw string', '2026-08-01T00:00:00.000Z'],
    ['NaN', Number.NaN],
  ])('rejects %s before any database query', async (_label, before) => {
    await expect(AgentMessageService.getRecentMessages(POD, 10, SELF, before))
      .rejects.toThrow('beforeMs must be a valid epoch timestamp');

    expect(PGMessage.findByPodId).not.toHaveBeenCalled();
    expect(Message.find).not.toHaveBeenCalled();
  });

  // Its absence is how a client detects a server too old to compute `self`.
  test('omits `self` when no caller identity is given', async () => {
    PGMessage.findByPodId.mockResolvedValue([
      {
        id: 1, user_id: SELF, username: 'me-bot', is_bot: true, content: 'mine', 
      },
    ]);

    const out = await AgentMessageService.getRecentMessages(POD, 10);

    expect(out[0]).not.toHaveProperty('self');
  });

  test('a human whose name merely ENDS IN "bot" is not reported as a bot', async () => {
    // The old substring heuristic ('-bot' / endsWith 'bot' / 'openclaw-')
    // misread these as bots, and isBot gates the wrapper's echo suppression.
    PGMessage.findByPodId.mockResolvedValue([
      {
        id: 1, user_id: 'u1', username: 'talbot', is_bot: false, content: 'hi', 
      },
      {
        id: 2, user_id: 'u2', username: 'abbot', is_bot: false, content: 'hi', 
      },
      {
        id: 3, user_id: 'u3', username: 'openclaw-aria', is_bot: false, content: 'hi', 
      },
      {
        id: 4, user_id: 'u4', username: 'real-bot', is_bot: true, content: 'hi', 
      },
    ]);

    const out = await AgentMessageService.getRecentMessages(POD, 10);

    expect(out.map((m) => m.isBot)).toEqual([false, false, false, true]);
  });
});

describe('getRecentMessages — Mongo fallback path', () => {
  const origPgHost = process.env.PG_HOST;
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.PG_HOST; // force the Mongo branch
  });
  afterAll(() => {
    if (origPgHost === undefined) delete process.env.PG_HOST;
    else process.env.PG_HOST = origPgHost;
  });

  // Without isBot in the projection, detection is dead and every turn double-posts.
  test('selects isBot in the populate projection', async () => {
    const { populate } = mockMongoChain([]);

    await AgentMessageService.getRecentMessages(POD, 10);

    expect(populate).toHaveBeenCalledWith('userId', expect.stringContaining('isBot'));
  });

  test('reports isBot truthfully for a bot author', async () => {
    mockMongoChain([
      { _id: 'm1', content: 'x', userId: { _id: SELF, username: 'me-bot', isBot: true } },
    ]);

    const out = await AgentMessageService.getRecentMessages(POD, 10);

    expect(out[0].isBot).toBe(true);
  });

  test('stamps `self` on the Mongo path too', async () => {
    mockMongoChain([
      { _id: 'm1', content: 'mine', userId: { _id: SELF, username: 'me-bot', isBot: true } },
      { _id: 'm2', content: 'theirs', userId: { _id: OTHER, username: 'other-bot', isBot: true } },
    ]);

    const out = await AgentMessageService.getRecentMessages(POD, 10, SELF);

    // .reverse() is applied on this path, so assert by author rather than order.
    const mine = out.find((m) => String(m.userId._id) === SELF);
    const theirs = out.find((m) => String(m.userId._id) === OTHER);
    expect(mine.self).toBe(true);
    expect(theirs.self).toBe(false);
  });

  test('applies the same exclusive history cursor on the Mongo fallback', async () => {
    const beforeMs = Date.parse('2026-08-01T00:00:00.000Z');
    const query = mockMongoChain([]);

    await AgentMessageService.getRecentMessages(POD, 10, SELF, beforeMs);

    expect(Message.find).toHaveBeenCalledWith({ podId: { $eq: POD } });
    expect(query.where).toHaveBeenCalledWith('createdAt');
    expect(query.lt).toHaveBeenCalledWith(new Date(beforeMs));
  });
});

describe('hasRecentDuplicateUrls — author scoping', () => {
  const origPgHost = process.env.PG_HOST;
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.PG_HOST = 'localhost';
  });
  afterAll(() => {
    if (origPgHost === undefined) delete process.env.PG_HOST;
    else process.env.PG_HOST = origPgHost;
  });

  test('a link posted by SOMEONE ELSE no longer suppresses this author', async () => {
    PGMessage.findByPodId.mockResolvedValue([
      {
        id: 1, user_id: OTHER, username: 'human', is_bot: false, content: 'look: https://x.com/a', 
      },
    ]);

    const dup = await AgentMessageService.hasRecentDuplicateUrls({
      podId: POD,
      content: 'https://x.com/a',
      authorUserId: SELF,
    });

    expect(dup).toBe(false);
  });

  test("the author's OWN recent duplicate is still caught", async () => {
    PGMessage.findByPodId.mockResolvedValue([
      {
        id: 1, user_id: SELF, username: 'me-bot', is_bot: true, content: 'look: https://x.com/a', 
      },
    ]);

    const dup = await AgentMessageService.hasRecentDuplicateUrls({
      podId: POD,
      content: 'https://x.com/a',
      authorUserId: SELF,
    });

    expect(dup).toBe(true);
  });
});
