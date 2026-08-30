// Stalled-connect nudge (W4 item 3). Spec: ux-lead 2026-08-14; calibration and
// corrections from pod-architect / sprint-impl, 2026-08-15.
//
// The load-bearing rules, each one a decision that could be silently undone:
//   - one nudge per TOKEN-episode, and a reissue earns another
//   - the episode key is max(createdAt) across BOTH token stores
//   - 15 min is a patience window on top of deriveAgentState, not a 2nd rule
//   - the episode is claimed BEFORE posting, so a race loses silently
//   - the forward promise is kept: connecting posts a confirmation
//   - the confirmation states the past flat and the present derived

const MINUTE = 60 * 1000;
const NOW = new Date('2026-08-15T12:00:00Z');
const OLD_TOKEN = new Date(NOW.getTime() - 30 * MINUTE);
const FRESH_TOKEN = new Date(NOW.getTime() - 2 * MINUTE);

const mockInstallFind = jest.fn();
const mockInstallFindById = jest.fn();
jest.mock('../../../models/AgentRegistry', () => ({
  AgentInstallation: {
    find: (...a) => mockInstallFind(...a),
    findById: (...a) => mockInstallFindById(...a),
  },
}));

const mockUserFindOne = jest.fn();
const mockUserFindById = jest.fn();
jest.mock('../../../models/User', () => ({
  findOne: (...a) => mockUserFindOne(...a),
  findById: (...a) => mockUserFindById(...a),
}));

const mockPost = jest.fn();
jest.mock('../../../services/agentMessageService', () => ({
  postMessage: (...a) => mockPost(...a),
}));

jest.mock('../../../services/agentIdentityService', () => ({
  buildAgentUsername: (n, i) => (i && i !== 'default' ? `${n}-${i}` : n),
}));

const mockEpCreate = jest.fn();
const mockEpFind = jest.fn();
const mockEpUpdate = jest.fn();
jest.mock('../../../models/StalledConnectEpisode', () => ({
  create: (...a) => mockEpCreate(...a),
  find: (...a) => mockEpFind(...a),
  updateOne: (...a) => mockEpUpdate(...a),
}));

const { scan, resolveTokenEpisode } = require('../../../services/stalledConnectService');

const install = (over = {}) => ({
  _id: 'inst1',
  podId: 'pod1',
  installedBy: 'user1',
  agentName: 'ai1-agent',
  instanceId: 'default',
  displayName: 'AI1 Agent',
  status: 'active',
  config: { runtime: { runtimeType: 'webhook', host: 'byo' } },
  runtimeTokens: [{ createdAt: OLD_TOKEN }],
  ...over,
});

const setup = ({ installs = [install()], userTokens = [], open = [] } = {}) => {
  mockInstallFind.mockReturnValue({
    limit: () => ({ lean: () => Promise.resolve(installs) }),
  });
  mockUserFindOne.mockReturnValue({
    select: () => ({ lean: () => Promise.resolve({ agentRuntimeTokens: userTokens }) }),
  });
  mockUserFindById.mockReturnValue({
    select: () => ({ lean: () => Promise.resolve({ username: 'alice' }) }),
  });
  mockEpFind.mockReturnValue({ limit: () => ({ lean: () => Promise.resolve(open) }) });
  mockEpCreate.mockImplementation((d) => Promise.resolve({ _id: 'ep1', ...d }));
  mockEpUpdate.mockResolvedValue({});
  mockPost.mockResolvedValue({ success: true, message: { id: 'msg1' } });
};

beforeEach(() => jest.clearAllMocks());

describe('resolveTokenEpisode', () => {
  // pod-architect 53308: key off one store while triggering off the union and a
  // reissue on the other path never resets the episode.
  it('takes the max createdAt across BOTH stores', () => {
    const older = new Date('2026-08-15T10:00:00Z');
    const newer = new Date('2026-08-15T11:00:00Z');
    expect(resolveTokenEpisode([{ createdAt: older }], [{ createdAt: newer }]))
      .toEqual({ issuedAt: newer, source: 'user' });
    expect(resolveTokenEpisode([{ createdAt: newer }], [{ createdAt: older }]))
      .toEqual({ issuedAt: newer, source: 'installation' });
  });

  it('reports which store minted it, because only one has expiresAt', () => {
    const { source } = resolveTokenEpisode([], [{ createdAt: NOW }]);
    expect(source).toBe('user');
  });

  it('returns null when no token was ever issued', () => {
    expect(resolveTokenEpisode([], [])).toEqual({ issuedAt: null, source: null });
  });
});

describe('stalledConnectService.scan', () => {
  it('nudges a seat whose token was issued long ago and never used', async () => {
    setup();
    const r = await scan({ now: NOW });

    expect(r.nudged).toHaveLength(1);
    expect(mockPost).toHaveBeenCalledTimes(1);
    const posted = mockPost.mock.calls[0][0];
    expect(posted.podId).toBe('pod1');
    expect(posted.content).toContain('@alice');
    expect(posted.content).toContain('commonly agent run ai1-agent');
    expect(posted.content).toContain("I'll post here the moment I connect");
  });

  it('holds fire inside the patience window', async () => {
    setup({ installs: [install({ runtimeTokens: [{ createdAt: FRESH_TOKEN }] })] });
    const r = await scan({ now: NOW });

    expect(r.nudged).toHaveLength(0);
    expect(r.skippedTooRecent).toBe(1);
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('says nothing when the token has been used — that is not stalled', async () => {
    setup({
      installs: [install({
        runtimeTokens: [{ createdAt: OLD_TOKEN, lastUsedAt: new Date(NOW.getTime() - MINUTE) }],
      })],
    });
    const r = await scan({ now: NOW });

    expect(r.nudged).toHaveLength(0);
    expect(r.skippedNotStalled).toBe(1);
  });

  it('claims the episode BEFORE posting, so a losing race costs a nudge not a duplicate', async () => {
    setup();
    const order = [];
    mockEpCreate.mockImplementation(async (d) => { order.push('claim'); return { _id: 'ep1', ...d }; });
    mockPost.mockImplementation(async () => {
      order.push('post');
      return { success: true, message: { id: 'm' } };
    });

    await scan({ now: NOW });

    expect(order).toEqual(['claim', 'post']);
  });

  it('stays silent when the episode was already explained (duplicate key)', async () => {
    setup();
    mockEpCreate.mockRejectedValue(Object.assign(new Error('dup'), { code: 11000 }));

    const r = await scan({ now: NOW });

    expect(r.nudged).toHaveLength(0);
    expect(mockPost).not.toHaveBeenCalled();
  });

  // The first live run landed 10 correct messages and recorded 10 empty ids,
  // because postMessage returns { success, message } and the code read
  // `posted.id`. The old fixture returned `{ id }` — the shape the bug
  // expected — so the tests agreed with the bug rather than with the service.
  it('records the real message id, which is nested under `message`', async () => {
    setup();
    await scan({ now: NOW });

    expect(mockEpUpdate).toHaveBeenCalledWith(
      { _id: 'ep1' },
      { $set: { nudgeMessageId: 'msg1' } },
    );
  });

  it('does not report a nudge when postMessage declined to post', async () => {
    setup();
    mockPost.mockResolvedValue({ success: true, skipped: true, reason: 'duplicate_recent' });

    const r = await scan({ now: NOW });

    expect(r.nudged).toHaveLength(0);
    expect(mockEpUpdate).not.toHaveBeenCalled();
  });

  it('records the episode against the token issue time and its source', async () => {
    setup();
    await scan({ now: NOW });

    const doc = mockEpCreate.mock.calls[0][0];
    expect(doc.tokenIssuedAt).toEqual(OLD_TOKEN);
    expect(doc.tokenSource).toBe('installation');
    expect(doc.producer).toBe('timer');
  });

  it('finds the reachable User-token-only seat, even when the installation token store is empty', async () => {
    // `issueRuntimeTokenForAgent` returns an existing User-row token without
    // backfilling installation.runtimeTokens. Model Mongo's former existence
    // predicate so restoring it makes this end-to-end scan regression fail.
    const userTokenOnlyInstall = install({ runtimeTokens: [] });
    setup({ installs: [userTokenOnlyInstall], userTokens: [{ createdAt: OLD_TOKEN }] });
    mockInstallFind.mockImplementation((filter) => ({
      limit: () => ({
        lean: () => Promise.resolve(filter['runtimeTokens.0'] ? [] : [userTokenOnlyInstall]),
      }),
    }));

    const r = await scan({ now: NOW });

    expect(r.nudged).toHaveLength(1);
    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(mockEpCreate.mock.calls[0][0]).toEqual(expect.objectContaining({
      tokenIssuedAt: OLD_TOKEN,
      tokenSource: 'user',
    }));
  });

  it('only considers BYO seats — nothing else can derive never-connected', async () => {
    setup();
    await scan({ now: NOW });

    const [filter] = mockInstallFind.mock.calls[0];
    expect(filter.status).toBe('active');
    expect(filter).not.toHaveProperty('runtimeTokens.0');
    expect(filter.$or).toEqual(expect.arrayContaining([{ 'config.runtime.host': 'byo' }]));
  });
});

describe('keeping the forward promise', () => {
  const openEpisode = {
    _id: 'ep9',
    installationId: 'inst1',
    podId: 'pod1',
    agentName: 'ai1-agent',
    instanceId: 'default',
    displayName: 'AI1 Agent',
    status: 'open',
  };

  it('posts a confirmation once the token is used, and closes the episode', async () => {
    const usedAt = new Date(NOW.getTime() - 10 * MINUTE);
    setup({ installs: [], open: [openEpisode] });
    mockInstallFindById.mockReturnValue({
      lean: () => Promise.resolve(install({ runtimeTokens: [{ createdAt: OLD_TOKEN, lastUsedAt: usedAt }] })),
    });

    const r = await scan({ now: NOW });

    expect(r.resolved).toHaveLength(1);
    const posted = mockPost.mock.calls[0][0];
    // Past stated flat, present derived at post time (ux-lead 53307).
    expect(posted.content).toContain('first seen 11:50');
    expect(mockEpUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ _id: 'ep9', status: 'open' }),
      expect.objectContaining({ $set: expect.objectContaining({ status: 'resolved' }) }),
    );
  });

  it('reports the present honestly when it connected and has since gone quiet', async () => {
    // Connected 3 hours ago, stale now: the past is still a fact, the present
    // is not "listening". This is the connect-then-disconnect case.
    const usedAt = new Date(NOW.getTime() - 180 * MINUTE);
    setup({ installs: [], open: [openEpisode] });
    mockInstallFindById.mockReturnValue({
      lean: () => Promise.resolve(install({ runtimeTokens: [{ createdAt: OLD_TOKEN, lastUsedAt: usedAt }] })),
    });

    await scan({ now: NOW });

    const posted = mockPost.mock.calls[0][0];
    expect(posted.content).toContain('first seen 09:00');
    expect(posted.content).toContain("isn't running right now");
    expect(posted.content).toContain('commonly agent run ai1-agent');
  });

  it('keeps waiting while it is still never-connected', async () => {
    setup({ installs: [], open: [openEpisode] });
    mockInstallFindById.mockReturnValue({ lean: () => Promise.resolve(install()) });

    const r = await scan({ now: NOW });

    expect(r.resolved).toHaveLength(0);
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('closes silently when the seat was uninstalled — no room, no promise to keep', async () => {
    setup({ installs: [], open: [openEpisode] });
    mockInstallFindById.mockReturnValue({ lean: () => Promise.resolve(null) });

    await scan({ now: NOW });

    expect(mockPost).not.toHaveBeenCalled();
    expect(mockEpUpdate).toHaveBeenCalled();
  });
});
