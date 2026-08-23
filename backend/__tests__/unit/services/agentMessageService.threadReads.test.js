/**
 * Agent context reads carry thread structure (TASK-052's read half).
 *
 * The cue teaching agents "prose overflow goes in a thread" was held on one
 * finding: getRecentMessages' PG mapping dropped `thread_root_id`,
 * `reply_to_message_id` and the formatted `replyTo`, so a peer agent reading
 * context could not see that a thread existed — teaching agents to post
 * continuations in threads would have made those continuations invisible to
 * the very audience they're for. These pin the mapping and the new
 * thread-scoped read:
 *
 *  - every PG message carries the two threading columns (explicit null for
 *    "not in a thread" — an absent key means "server cannot say", which is
 *    the Mongo-fallback shape, same convention as the frontend threadView);
 *  - `threadRootId` scopes the read and reaches the model verbatim;
 *  - the Mongo fallback REFUSES a thread-scoped read rather than returning
 *    the whole pod as if it were the thread.
 */

const AgentMessageService = require('../../../services/agentMessageService');
const Message = require('../../../models/Message');
const PGMessage = require('../../../models/pg/Message');

jest.mock('../../../models/Message');
jest.mock('../../../models/pg/Message', () => ({ findByPodId: jest.fn() }));

const POD = 'pod-1';

const pgRow = (over = {}) => ({
  id: '57579',
  content: 'Reply C',
  message_type: 'text',
  user_id: 'u-1',
  username: 'sam',
  is_bot: false,
  created_at: new Date('2026-08-23T00:00:00Z'),
  thread_root_id: '57577',
  reply_to_message_id: '57578',
  replyTo: {
    id: '57578', content: 'Reply A', username: 'sam', userId: 'u-1',
  },
  ...over,
});

describe('getRecentMessages — thread structure on the PG path', () => {
  const origPgHost = process.env.PG_HOST;
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.PG_HOST = 'localhost';
  });
  afterAll(() => {
    if (origPgHost === undefined) delete process.env.PG_HOST;
    else process.env.PG_HOST = origPgHost;
  });

  test('a threaded reply carries root, reply edge, and the formatted quote', async () => {
    PGMessage.findByPodId.mockResolvedValue([pgRow()]);

    const [msg] = await AgentMessageService.getRecentMessages(POD, 20);

    expect(msg.thread_root_id).toBe('57577');
    expect(msg.reply_to_message_id).toBe('57578');
    expect(msg.replyTo).toEqual(expect.objectContaining({ id: '57578', content: 'Reply A' }));
  });

  test('a plain broadcast carries explicit nulls, never absent keys', async () => {
    PGMessage.findByPodId.mockResolvedValue([
      pgRow({ thread_root_id: null, reply_to_message_id: null, replyTo: null }),
    ]);

    const [msg] = await AgentMessageService.getRecentMessages(POD, 20);

    expect(msg).toHaveProperty('thread_root_id', null);
    expect(msg).toHaveProperty('reply_to_message_id', null);
    expect(msg).toHaveProperty('replyTo', null);
  });

  test('threadRootId reaches the model verbatim as the fourth argument', async () => {
    PGMessage.findByPodId.mockResolvedValue([pgRow()]);

    await AgentMessageService.getRecentMessages(POD, 20, undefined, undefined, '57577');

    expect(PGMessage.findByPodId).toHaveBeenCalledWith(POD, 20, null, '57577');
  });

  test('the Mongo fallback refuses a thread-scoped read instead of faking it', async () => {
    PGMessage.findByPodId.mockRejectedValue(new Error('pg down'));

    await expect(
      AgentMessageService.getRecentMessages(POD, 20, undefined, undefined, '57577'),
    ).rejects.toThrow('threadRootId reads require the PostgreSQL message store');
  });
});
