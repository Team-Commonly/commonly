// Tests for reactionAttributionService — the bridge between
// MessageReaction's raw {emoji, count, mine, userIds[]} aggregates and
// the public {emoji, count, mine, users[{id, username, displayName?}]}
// shape consumed by clients. Verifies the bot-vs-human display fallback
// and the bulk-decorate batching invariant (one User lookup regardless
// of how many messages or emoji buckets are passed).

// Jest hoists jest.mock() above all imports, so the factory cannot
// close over module-scope variables — `userFindMock = jest.fn()` lines
// would run AFTER the factory and break. Workaround: any name prefixed
// with `mock` is allow-listed by Jest's transformer. Define the spies
// inside the factory and re-fetch them via jest.requireMock() in tests.
jest.mock('../../../models/User', () => {
  function User() {}
  User.find = jest.fn();
  return User;
});

jest.mock('../../../services/agentIdentityService', () => ({
  resolveAgentDisplayLabel: jest.fn(),
}));

const User = require('../../../models/User');
const agentIdentityService = require('../../../services/agentIdentityService');
const userFindMock = User.find;
const resolveAgentDisplayLabelMock = agentIdentityService.resolveAgentDisplayLabel;

const {
  decorateReactionSummaries,
  decorateReactionMap,
} = require('../../../services/reactionAttributionService');

const mockUsersLean = (users) => {
  userFindMock.mockReturnValue({
    select: () => ({
      lean: () => Promise.resolve(users),
    }),
  });
};

beforeEach(() => {
  jest.clearAllMocks();
  // Default: resolveAgentDisplayLabel returns the curated bot label;
  // the service tests use it as a black box. Individual tests override.
  resolveAgentDisplayLabelMock.mockImplementation((user, fallback) => {
    const dn = user?.botMetadata?.displayName;
    return dn || fallback;
  });
});

describe('decorateReactionSummaries', () => {
  test('human reactor gets {id, username} only (no displayName)', async () => {
    mockUsersLean([{ _id: 'u-human-1', username: 'sam' }]);
    const out = await decorateReactionSummaries([
      { emoji: '🎉', count: 1, mine: false, userIds: ['u-human-1'] },
    ]);
    expect(out).toEqual([
      {
        emoji: '🎉',
        count: 1,
        mine: false,
        users: [{ id: 'u-human-1', username: 'sam' }],
      },
    ]);
  });

  test('bot reactor gets {id, username, displayName} via resolveAgentDisplayLabel', async () => {
    mockUsersLean([
      {
        _id: 'u-bot-1',
        username: 'openclaw-nova-demo',
        botMetadata: { displayName: 'Nova', instanceId: 'nova-demo', agentName: 'openclaw' },
      },
    ]);
    const out = await decorateReactionSummaries([
      { emoji: '🎉', count: 1, mine: true, userIds: ['u-bot-1'] },
    ]);
    expect(out[0].users[0]).toEqual({
      id: 'u-bot-1',
      username: 'openclaw-nova-demo',
      displayName: 'Nova',
    });
    expect(resolveAgentDisplayLabelMock).toHaveBeenCalled();
  });

  test('preserves userIds order — earliest reactor first', async () => {
    mockUsersLean([
      { _id: 'u-a', username: 'first' },
      { _id: 'u-b', username: 'second' },
    ]);
    const out = await decorateReactionSummaries([
      { emoji: '👍', count: 2, mine: false, userIds: ['u-a', 'u-b'] },
    ]);
    expect(out[0].users.map((u) => u.username)).toEqual(['first', 'second']);
  });

  test('unknown user_id (deleted account) renders as "unknown" rather than crashing', async () => {
    mockUsersLean([]); // none of the IDs resolve
    const out = await decorateReactionSummaries([
      { emoji: '👀', count: 1, mine: false, userIds: ['u-ghost'] },
    ]);
    expect(out[0].users).toEqual([{ id: 'u-ghost', username: 'unknown' }]);
  });

  test('empty input → empty output, no User lookup', async () => {
    const out = await decorateReactionSummaries([]);
    expect(out).toEqual([]);
    expect(userFindMock).not.toHaveBeenCalled();
  });
});

describe('decorateReactionMap (bulk path)', () => {
  test('one User.find for many messages — N+1 guard', async () => {
    mockUsersLean([
      { _id: 'u-1', username: 'alice' },
      { _id: 'u-2', username: 'bob' },
    ]);
    const map = new Map([
      ['msg-1', [{ emoji: '🎉', count: 1, mine: false, userIds: ['u-1'] }]],
      [
        'msg-2',
        [
          { emoji: '👍', count: 1, mine: false, userIds: ['u-2'] },
          { emoji: '👀', count: 2, mine: true, userIds: ['u-1', 'u-2'] },
        ],
      ],
    ]);
    const out = await decorateReactionMap(map);
    expect(userFindMock).toHaveBeenCalledTimes(1);
    expect(out.get('msg-1')[0].users).toEqual([{ id: 'u-1', username: 'alice' }]);
    expect(out.get('msg-2')[1].users.map((u) => u.username)).toEqual(['alice', 'bob']);
  });
});
