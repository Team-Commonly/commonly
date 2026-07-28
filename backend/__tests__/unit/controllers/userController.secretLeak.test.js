/**
 * Regression: GET /api/users/:id leaked another user's credentials.
 *
 * Confirmed live against production before the fix — a plain, non-admin,
 * verified account fetched an admin's profile and received the full Mongo
 * document, including `apiToken` (a working `cm_` bearer that authenticates AS
 * that user via middleware/auth.ts) and their email address. That is
 * account-takeover of any user, including admins, by anyone who can sign up.
 *
 * Cause: `toSocialProfile` spread `userDoc.toObject()` wholesale, and
 * `.select('-password')` was the only projection applied.
 *
 * Two layers are tested here:
 *   1. the serializer drops secrets unconditionally and account-private fields
 *      when the viewer is not the owner
 *   2. `apiToken` is `select: false` on the schema, so it cannot ride along on
 *      an incidental query anywhere else
 */

jest.mock('jsonwebtoken', () => ({ sign: jest.fn(), verify: jest.fn(), decode: jest.fn() }));
jest.mock('../../../models/User');
jest.mock('../../../models/Activity', () => ({}));
jest.mock('../../../models/Post', () => ({}));
jest.mock('../../../models/Pod', () => ({}));
jest.mock('../../../services/agentIdentityService', () => ({}));
jest.mock('../../../services/avatarService', () => ({ normalizeAvatarUrl: (v) => v }));

const User = require('../../../models/User');
const userController = require('../../../controllers/userController');

const OWNER = 'user-owner';
const VIEWER = 'user-viewer';

const makeUserDoc = (id) => ({
  _id: id,
  username: 'sam',
  followers: [],
  following: [],
  followedThreads: [],
  toObject: () => ({
    _id: id,
    username: 'sam',
    email: 'sam@example.com',
    profilePicture: 'default',
    role: 'admin',
    apiToken: 'cm_3767c5f74deadbeef',
    apiTokenScopes: ['agent:events:read'],
    agentRuntimeTokens: [{ tokenHash: 'abc' }],
    digestUnsubscribeToken: 'unsub-123',
    entitlements: { cloudAgents: true },
    banned: false,
    followers: [],
    following: [],
  }),
});

const runGetUserById = async (targetId, viewerId) => {
  User.findById.mockReturnValue({
    select: jest.fn().mockResolvedValue(makeUserDoc(targetId)),
  });
  const req = { params: { id: targetId }, user: { id: viewerId } };
  let body;
  const res = {
    json: (b) => { body = b; },
    status: () => ({ json: (b) => { body = b; }, send: (b) => { body = b; } }),
    send: (b) => { body = b; },
  };
  await userController.getUserById(req, res);
  return body;
};

describe('GET /api/users/:id does not leak credentials (confirmed live exploit)', () => {
  beforeEach(() => jest.clearAllMocks());

  test('another user cannot obtain the target apiToken', async () => {
    const body = await runGetUserById(OWNER, VIEWER);

    // The exact exploit: a working cm_ bearer for someone else.
    expect(body).not.toHaveProperty('apiToken');
    expect(JSON.stringify(body)).not.toContain('cm_3767c5f74deadbeef');
  });

  test('another user cannot obtain the target email or other private fields', async () => {
    const body = await runGetUserById(OWNER, VIEWER);

    expect(body).not.toHaveProperty('email');
    expect(body).not.toHaveProperty('entitlements');
    expect(body).not.toHaveProperty('apiTokenScopes');
    expect(body).not.toHaveProperty('banned');
  });

  test('agent runtime tokens and the unsubscribe token never leak either', async () => {
    const body = await runGetUserById(OWNER, VIEWER);

    expect(body).not.toHaveProperty('agentRuntimeTokens');
    expect(body).not.toHaveProperty('digestUnsubscribeToken');
  });

  test('public social fields still render, so profiles are not broken', async () => {
    const body = await runGetUserById(OWNER, VIEWER);

    expect(body.username).toBe('sam');
    expect(body.profilePicture).toBe('default');
    expect(body).toHaveProperty('followersCount', 0);
    expect(body).toHaveProperty('isFollowing', false);
  });

  test('viewing your OWN profile keeps private fields but STILL never the token', async () => {
    const body = await runGetUserById(OWNER, OWNER);

    expect(body.email).toBe('sam@example.com');
    expect(body.entitlements).toEqual({ cloudAgents: true });
    // The UI gets a token from POST /api/auth/api-token/generate, never here.
    expect(body).not.toHaveProperty('apiToken');
    expect(body).not.toHaveProperty('agentRuntimeTokens');
  });
});

describe('apiToken schema projection', () => {
  test('the field is select:false so it cannot ride along on an incidental query', () => {
    // Layer 2. Asserted against the real schema rather than the mocked model.
    const actual = jest.requireActual('../../../models/User');
    const schema = (actual.schema || actual.default?.schema);
    const path = schema.path('apiToken');
    expect(path).toBeDefined();
    expect(path.options.select).toBe(false);
  });
});
