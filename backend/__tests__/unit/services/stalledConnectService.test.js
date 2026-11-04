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

const mockUserFind = jest.fn();
const mockUserFindOne = jest.fn();
const mockUserFindById = jest.fn();
jest.mock('../../../models/User', () => ({
  find: (...a) => mockUserFind(...a),
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

const mockAttentionResolve = jest.fn();
jest.mock('../../../services/attentionItemService', () => ({
  resolveActioned: (...a) => mockAttentionResolve(...a),
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
  // One bot row per (agentName, instanceId) pair the query asks for, echoing
  // the pair back the way Mongo returns the matched row's own fields.
  mockUserFind.mockImplementation((filter) => ({
    // A mock that ignores its projection hides a dropped field: assert it.
    select: (fields) => {
      expect(fields).toContain('botMetadata.agentName');
      expect(fields).toContain('botMetadata.instanceId');
      expect(fields).toContain('agentRuntimeTokens.lastListenedAt');
      expect(fields).toContain('agentRuntimeTokens.createdAt');
      expect(fields).toContain('agentRuntimeTokens.lastMcpSeenAt');
      const rows = (filter.$or || []).map((pair) => ({
        botMetadata: {
          agentName: pair['botMetadata.agentName'],
          instanceId: pair['botMetadata.instanceId'],
        },
        agentRuntimeTokens: userTokens,
      }));
      return { lean: () => Promise.resolve(rows) };
    },
  }));
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
    expect(posted.authorKind).toBe('kernel');
    expect(posted.content).toContain('@alice');
    expect(posted.content).toContain('commonly agent run ai1-agent');
    expect(posted.content).toContain("I'll post here the moment I connect");
  });

  it('uses the copied-command mark to tell the installer what happened', async () => {
    setup();
    mockUserFindById.mockReturnValue({
      select: () => ({
        lean: () => Promise.resolve({
          username: 'alice',
          onboarding: {
            byoCommandCopiedAt: new Date(OLD_TOKEN.getTime() + 8 * MINUTE),
            byoCommandType: 'cli',
          },
        }),
      }),
    });

    await scan({ now: NOW });

    const posted = mockPost.mock.calls[0][0];
    expect(posted.content).toContain(
      'copied the listener command a few minutes after you created the seat',
    );
    expect(posted.content).toContain('no connection arrived');
    // Nothing here knows the OS, so the copy doesn't claim to.
    expect(posted.content).toContain('here is the one thing to check: run `commonly agent run ai1-agent`');
    expect(posted.content).not.toContain('for your OS');
  });

  const copiedListenerOn = (byoOpenedOs, byoCommandType = 'cli') => mockUserFindById.mockReturnValue({
    select: () => ({
      lean: () => Promise.resolve({
        username: 'alice',
        onboarding: {
          byoCommandCopiedAt: new Date(OLD_TOKEN.getTime() + 8 * MINUTE),
          byoCommandType,
          ...(byoOpenedOs ? { byoOpenedOs } : {}),
        },
      }),
    }),
  });

  it.each([['linux', 'Linux'], ['windows', 'Windows']])(
    'from a %s browser, says the listener is tested on a Mac and not verified there yet',
    async (os, label) => {
      setup();
      copiedListenerOn(os);
      await scan({ now: NOW });
      const { content } = mockPost.mock.calls[0][0];
      // Conditional: the page shows this command only on its Mac tab, so the
      // browser's OS is not proof of where it ran.
      expect(content).toContain(`If you ran it on ${label}, that may be why. The listener is tested on a Mac. On Linux and Windows it isn't verified yet, and fixes are on the way.`);
      // The server cannot tell Claude Code from Codex, so no adapter-specific cause.
      expect(content).not.toContain('sandbox');
      expect(content).toContain('Run `commonly agent run ai1-agent` on a Mac');
      expect(content).toContain('or choose “Run it here” on the Bring your own page for a hosted agent');
      expect(content).toContain("I'll post here the moment I connect");
      expect(content).not.toContain('one thing to check');
    },
  );

  it.each(['mac', 'other', undefined])('with os=%p keeps the neutral check', async (os) => {
    setup();
    copiedListenerOn(os);
    await scan({ now: NOW });
    const { content } = mockPost.mock.calls[0][0];
    expect(content).toContain('here is the one thing to check: run');
    expect(content).not.toContain("can't answer @mentions");
  });

  it('an MCP copy on Linux is not told about the listener', async () => {
    setup();
    copiedListenerOn('linux', 'mcp');
    await scan({ now: NOW });
    const { content } = mockPost.mock.calls[0][0];
    expect(content).not.toContain("listener can't answer");
    expect(content).toContain('MCP-only clients can call Commonly');
  });

  it('explains that an MCP-only client cannot answer mentions', async () => {
    setup();
    mockUserFindById.mockReturnValue({
      select: () => ({
        lean: () => Promise.resolve({
          username: 'alice',
          onboarding: {
            byoCommandCopiedAt: new Date(OLD_TOKEN.getTime() + 8 * MINUTE),
            byoCommandType: 'mcp',
          },
        }),
      }),
    });

    await scan({ now: NOW });

    expect(mockPost.mock.calls[0][0].content).toContain(
      'MCP-only clients can call Commonly, but they do not answer @mentions',
    );
  });

  const copiedKinds = (onboarding) => mockUserFindById.mockReturnValue({
    select: () => ({ lean: () => Promise.resolve({ username: 'alice', onboarding }) }),
  });

  it('names the Terminal command when only the MCP snippet was copied (TASK-721)', async () => {
    setup();
    copiedKinds({
      byoCommandCopiedAt: new Date(OLD_TOKEN.getTime() + 8 * MINUTE),
      byoCommandType: 'mcp',
      byoMcpCopiedAt: new Date(OLD_TOKEN.getTime() + 8 * MINUTE),
    });
    await scan({ now: NOW });
    const { content } = mockPost.mock.calls[0][0];
    expect(content).toContain('you copied the MCP command');
    expect(content).toContain('but not the listener command that starts me');
    expect(content).toContain('MCP-only clients can call Commonly, but they do not answer @mentions');
    expect(content).toContain('Run `commonly agent run ai1-agent` in a Terminal on the machine where I should live');
    expect(content).toContain("I'll post here the moment I connect");
  });

  it('does not say the Terminal command was missed when the listener command was copied too', async () => {
    setup();
    copiedKinds({
      byoCommandCopiedAt: new Date(OLD_TOKEN.getTime() + 8 * MINUTE),
      byoCommandType: 'mcp',
      byoMcpCopiedAt: new Date(OLD_TOKEN.getTime() + 8 * MINUTE),
      byoCliCopiedAt: new Date(OLD_TOKEN.getTime() + 9 * MINUTE),
    });
    await scan({ now: NOW });
    const { content } = mockPost.mock.calls[0][0];
    expect(content).toContain('you copied the listener command');
    expect(content).not.toContain('but not the listener command');
    expect(content).not.toContain('MCP-only clients');
  });

  it('keeps the older wording for a signup that only has the first-copy pair', async () => {
    setup();
    copiedKinds({
      byoCommandCopiedAt: new Date(OLD_TOKEN.getTime() + 8 * MINUTE),
      byoCommandType: 'mcp',
    });
    await scan({ now: NOW });
    const { content } = mockPost.mock.calls[0][0];
    expect(content).toContain('here is the one thing to check');
    expect(content).not.toContain('but not the listener command');
  });

  it('does not call a pre-deploy listener copy "never copied" when an MCP copy follows', async () => {
    setup();
    copiedKinds({
      byoCommandCopiedAt: new Date(OLD_TOKEN.getTime() + 1 * MINUTE),
      byoCommandType: 'cli',
      byoMcpCopiedAt: new Date(OLD_TOKEN.getTime() + 5 * MINUTE),
    });
    await scan({ now: NOW });
    const { content } = mockPost.mock.calls[0][0];
    expect(content).toContain('you copied the listener command');
    expect(content).not.toContain('but not the listener command');
  });

  it('makes no "missed it" claim when the listener copy is from an earlier agent and the MCP copy is inside this episode', async () => {
    setup();
    copiedKinds({
      byoCommandCopiedAt: new Date(OLD_TOKEN.getTime() - 7 * 24 * 60 * MINUTE),
      byoCommandType: 'cli',
      byoCliCopiedAt: new Date(OLD_TOKEN.getTime() - 7 * 24 * 60 * MINUTE),
      byoMcpCopiedAt: new Date(OLD_TOKEN.getTime() + 3 * MINUTE),
    });
    await scan({ now: NOW });
    const { content } = mockPost.mock.calls[0][0];
    // The first-copy mark cannot show whether this seat's listener was copied.
    expect(content).toContain('you copied the MCP command');
    expect(content).toContain('here is the one thing to check');
    expect(content).toContain('MCP-only clients can call Commonly');
    expect(content).not.toContain('but not the listener command');
  });

  it('an unparseable per-kind time falls back to the first-copy pair', async () => {
    setup();
    copiedKinds({
      byoCommandCopiedAt: new Date(OLD_TOKEN.getTime() + 1 * MINUTE),
      byoCommandType: 'cli',
      byoCliCopiedAt: 'garbage',
      byoMcpCopiedAt: new Date(OLD_TOKEN.getTime() + 5 * MINUTE),
    });
    await scan({ now: NOW });
    expect(mockPost.mock.calls[0][0].content).not.toContain('but not the listener command');
  });

  it('falls back to the generic nudge when every copy predates the token', async () => {
    setup();
    copiedKinds({
      byoCommandCopiedAt: new Date(OLD_TOKEN.getTime() - 60 * MINUTE),
      byoCommandType: 'mcp',
      byoMcpCopiedAt: new Date(OLD_TOKEN.getTime() - 60 * MINUTE),
    });
    await scan({ now: NOW });
    expect(mockPost.mock.calls[0][0].content).toContain('nothing has ever started me');
  });

  it.each([['linux', 'Linux'], ['windows', 'Windows']])(
    'MCP-only from a %s browser does not say the listener command was missed',
    async (os, label) => {
      setup();
      copiedKinds({
        byoCommandCopiedAt: new Date(OLD_TOKEN.getTime() + 8 * MINUTE),
        byoCommandType: 'mcp',
        byoMcpCopiedAt: new Date(OLD_TOKEN.getTime() + 8 * MINUTE),
        byoOpenedOs: os,
      });
      await scan({ now: NOW });
      const { content } = mockPost.mock.calls[0][0];
      expect(content).toContain(`You first opened this page on ${label}.`);
      expect(content).toContain('in a Terminal on a Mac');
      expect(content).not.toContain('but not the listener command');
    },
  );

  // docs/agents/byo-support-matrix.md: Linux and Windows are unverified, not
  // impossible, so no nudge may say the listener runs only on a Mac, and none
  // may suggest --unsandboxed before a real Windows walk exists.
  it.each([
    ['cli', 'linux'], ['cli', 'windows'], ['mcp', 'linux'], ['mcp', 'windows'],
  ])('a %s copy from a %s browser claims no Mac-only listener and offers no --unsandboxed', async (kind, os) => {
    setup();
    copiedKinds({
      byoCommandCopiedAt: new Date(OLD_TOKEN.getTime() + 8 * MINUTE),
      byoCommandType: kind,
      ...(kind === 'mcp' ? { byoMcpCopiedAt: new Date(OLD_TOKEN.getTime() + 8 * MINUTE) } : {}),
      byoOpenedOs: os,
    });
    await scan({ now: NOW });
    const { content } = mockPost.mock.calls[0][0];
    expect(content).toContain("isn't verified yet");
    expect(content).not.toMatch(/only (from|on) a Mac|Mac only|--unsandboxed/i);
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
        runtimeTokens: [{ createdAt: OLD_TOKEN, lastListenedAt: new Date(NOW.getTime() - MINUTE) }],
      })],
    });
    const r = await scan({ now: NOW });

    expect(r.nudged).toHaveLength(0);
    expect(r.skippedNotStalled).toBe(1);
  });

  it('nudges a seat that made MCP calls but never checked in as a listener', async () => {
    setup({
      installs: [install({
        runtimeTokens: [{ createdAt: OLD_TOKEN, lastUsedAt: new Date(NOW.getTime() - MINUTE) }],
      })],
    });
    const r = await scan({ now: NOW });

    expect(r.nudged).toHaveLength(1);
    expect(mockPost).toHaveBeenCalledTimes(1);
  });

  it('does not nudge an old seat whose lastListenedAt was backfilled from lastUsedAt', async () => {
    const lastSeen = new Date(NOW.getTime() - 3 * 24 * 60 * MINUTE);
    setup({
      installs: [install({
        runtimeTokens: [{ createdAt: OLD_TOKEN, lastUsedAt: lastSeen, lastListenedAt: lastSeen }],
      })],
    });
    const r = await scan({ now: NOW });

    expect(r.nudged).toHaveLength(0);
    expect(r.skippedNotStalled).toBe(1);
    expect(mockPost).not.toHaveBeenCalled();
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

  it('reads every candidate\'s bot tokens in one query, not one round trip per candidate', async () => {
    // Measured on production 2026-11-02: 169 candidates read one by one took
    // 7.0s, and the same rows in one query took 104ms. The pass held the
    // */5 tick for the whole 7s.
    const installs = ['a', 'b', 'c'].map((n) => install({
      _id: `inst-${n}`, agentName: `Seat-${n}`, instanceId: n === 'c' ? undefined : n,
    }));
    setup({ installs });

    const r = await scan({ now: NOW });

    expect(mockUserFindOne).not.toHaveBeenCalled();
    expect(mockUserFind).toHaveBeenCalledTimes(1);
    const [filter] = mockUserFind.mock.calls[0];
    expect(filter.isBot).toBe(true);
    // Same match as the per-seat read it replaces: lowercased name, and
    // 'default' for a missing instance.
    expect(filter.$or).toEqual([
      { 'botMetadata.agentName': 'seat-a', 'botMetadata.instanceId': 'a' },
      { 'botMetadata.agentName': 'seat-b', 'botMetadata.instanceId': 'b' },
      { 'botMetadata.agentName': 'seat-c', 'botMetadata.instanceId': 'default' },
    ]);
    expect(r.candidates).toBe(3);
  });

  it('gives each seat its own bot row\'s tokens, and none to a seat with no bot row', async () => {
    const installs = [
      install({ _id: 'inst-used', agentName: 'used', runtimeTokens: [] }),
      install({ _id: 'inst-orphan', agentName: 'orphan', runtimeTokens: [] }),
    ];
    setup({ installs });
    mockUserFind.mockImplementation(() => ({
      select: () => ({
        lean: () => Promise.resolve([{
          botMetadata: { agentName: 'used', instanceId: 'default' },
          agentRuntimeTokens: [{ createdAt: OLD_TOKEN }],
        }]),
      }),
    }));

    const r = await scan({ now: NOW });

    // The seat with a User-row token is a candidate episode; the orphan has
    // no token in either store, so nothing was ever promised to connect.
    expect(r.nudged).toHaveLength(1);
    expect(mockEpCreate.mock.calls[0][0]).toEqual(expect.objectContaining({ tokenSource: 'user' }));
  });

  it('asks once for a pair two installs share, and keeps the first bot row, as findOne did', async () => {
    const installs = [
      install({ _id: 'inst-1', runtimeTokens: [] }),
      install({ _id: 'inst-2', podId: 'pod2', runtimeTokens: [] }),
    ];
    setup({ installs });
    mockUserFind.mockImplementation((filter) => ({
      select: () => ({
        lean: () => Promise.resolve([
          { botMetadata: { agentName: 'ai1-agent', instanceId: 'default' }, agentRuntimeTokens: [{ createdAt: OLD_TOKEN }] },
          { botMetadata: { agentName: 'ai1-agent', instanceId: 'default' }, agentRuntimeTokens: [] },
        ].slice(0, 2 * filter.$or.length)),
      }),
    }));

    await scan({ now: NOW });

    expect(mockUserFind.mock.calls[0][0].$or).toHaveLength(1);
    // Both installs got the first row's token, so both are stalled episodes.
    expect(mockEpCreate.mock.calls.map(([doc]) => doc.tokenSource)).toEqual(['user', 'user']);
  });

  it('only considers BYO seats — nothing else can derive never-connected', async () => {
    setup();
    await scan({ now: NOW });

    const [filter] = mockInstallFind.mock.calls[0];
    expect(filter.status).toBe('active');
    expect(filter).not.toHaveProperty('runtimeTokens.0');
    expect(filter.$or).toEqual(expect.arrayContaining([{ 'config.runtime.host': 'byo' }]));
  });

  it('pre-filters the legacy unstamped polling seat that classifyRuntime calls BYO (TASK-655, #1320)', async () => {
    setup();
    await scan({ now: NOW });

    const [filter] = mockInstallFind.mock.calls[0];
    expect(filter.$or).toEqual(expect.arrayContaining([{
      'config.runtime.runtimeType': 'webhook',
      'config.runtime.host': { $in: [null, ''] },
      'config.runtime.webhookUrl': { $in: [null, ''] },
    }]));
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
      lean: () => Promise.resolve(install({ runtimeTokens: [{ createdAt: OLD_TOKEN, lastListenedAt: usedAt }] })),
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

  it('resolves only the episode whose own bot row shows it connected, from the one batched read', async () => {
    // Neither installation token has been used; the User-row token of seat
    // "used" has. If the pass stopped reading the batched bot rows, or handed
    // one seat another seat's row, the wrong set would resolve.
    const usedAt = new Date(NOW.getTime() - 10 * MINUTE);
    const episodes = [
      { ...openEpisode, _id: 'ep-used', installationId: 'inst-used', agentName: 'used' },
      { ...openEpisode, _id: 'ep-quiet', installationId: 'inst-quiet', agentName: 'quiet' },
    ];
    setup({ installs: [], open: episodes });
    mockInstallFindById.mockImplementation((id) => ({
      lean: () => Promise.resolve(install({
        _id: id, agentName: id.replace('inst-', ''), runtimeTokens: [{ createdAt: OLD_TOKEN }],
      })),
    }));
    // The store answers the query it is given, as Mongo would: a row comes back
    // only when one `$or` clause matches both its name and its instance. A
    // connected "quiet" seat on another instance must not resolve ep-quiet, and a
    // query that left out ep-used's pair would leave ep-used open.
    const rows = [
      { botMetadata: { agentName: 'used', instanceId: 'default' }, agentRuntimeTokens: [{ createdAt: OLD_TOKEN, lastListenedAt: usedAt }] },
      { botMetadata: { agentName: 'quiet', instanceId: 'default' }, agentRuntimeTokens: [{ createdAt: OLD_TOKEN }] },
      { botMetadata: { agentName: 'quiet', instanceId: 'other' }, agentRuntimeTokens: [{ createdAt: OLD_TOKEN, lastListenedAt: usedAt }] },
    ];
    const matches = (row, clause) => Object.entries(clause)
      .every(([path, value]) => path.split('.').reduce((v, k) => v?.[k], row) === value);
    mockUserFind.mockImplementation((filter) => ({
      select: () => ({
        lean: () => Promise.resolve(rows.filter((row) => filter.$or.some((clause) => matches(row, clause)))),
      }),
    }));

    const r = await scan({ now: NOW });

    expect(mockUserFind).toHaveBeenCalledTimes(1);
    expect(mockUserFindOne).not.toHaveBeenCalled();
    expect(r.resolved).toHaveLength(1);
    const resolvedIds = mockEpUpdate.mock.calls
      .filter(([, update]) => update?.$set?.status === 'resolved')
      .map(([filter]) => filter._id);
    expect(resolvedIds).toEqual(['ep-used']);
  });

  it('resolves the instance whose bot row connected, not its sibling on another instance', async () => {
    // One agent, two instances. Only the non-default instance's bot row has
    // listened. Reading every episode's row as `default`, or keying by name
    // alone, resolves the wrong episode or both.
    const usedAt = new Date(NOW.getTime() - 10 * MINUTE);
    const episodes = [
      { ...openEpisode, _id: 'ep-home', installationId: 'inst-home', agentName: 'twin', instanceId: 'default' },
      { ...openEpisode, _id: 'ep-east', installationId: 'inst-east', agentName: 'twin', instanceId: 'east' },
    ];
    setup({ installs: [], open: episodes });
    mockInstallFindById.mockImplementation((id) => ({
      lean: () => Promise.resolve(install({ _id: id, agentName: 'twin', runtimeTokens: [{ createdAt: OLD_TOKEN }] })),
    }));
    const rows = [
      { botMetadata: { agentName: 'twin', instanceId: 'default' }, agentRuntimeTokens: [{ createdAt: OLD_TOKEN }] },
      { botMetadata: { agentName: 'twin', instanceId: 'east' }, agentRuntimeTokens: [{ createdAt: OLD_TOKEN, lastListenedAt: usedAt }] },
    ];
    mockUserFind.mockImplementation((filter) => ({
      select: () => ({
        lean: () => Promise.resolve(rows.filter((row) => filter.$or.some((clause) => (
          clause['botMetadata.agentName'] === row.botMetadata.agentName
          && clause['botMetadata.instanceId'] === row.botMetadata.instanceId
        )))),
      }),
    }));

    const r = await scan({ now: NOW });

    expect(mockUserFind).toHaveBeenCalledTimes(1);
    expect(r.resolved).toHaveLength(1);
    const resolvedIds = mockEpUpdate.mock.calls
      .filter(([, update]) => update?.$set?.status === 'resolved')
      .map(([filter]) => filter._id);
    expect(resolvedIds).toEqual(['ep-east']);
  });

  it('reports the present honestly when it connected and has since gone quiet', async () => {
    // Connected 3 hours ago, stale now: the past is still a fact, the present
    // is not "listening". This is the connect-then-disconnect case.
    const usedAt = new Date(NOW.getTime() - 180 * MINUTE);
    setup({ installs: [], open: [openEpisode] });
    mockInstallFindById.mockReturnValue({
      lean: () => Promise.resolve(install({ runtimeTokens: [{ createdAt: OLD_TOKEN, lastListenedAt: usedAt }] })),
    });

    await scan({ now: NOW });

    const posted = mockPost.mock.calls[0][0];
    expect(posted.content).toContain('first seen 09:00');
    expect(posted.content).toContain("isn't running right now");
    expect(posted.content).toContain('commonly agent run ai1-agent');
  });

  it("resolves the installer's needs-you row for the nudge once the agent connects", async () => {
    const usedAt = new Date(NOW.getTime() - 10 * MINUTE);
    setup({ installs: [], open: [{ ...openEpisode, nudgeMessageId: 'msg-nudge-1' }] });
    mockInstallFindById.mockReturnValue({
      lean: () => Promise.resolve(install({ runtimeTokens: [{ createdAt: OLD_TOKEN, lastListenedAt: usedAt }] })),
    });

    await scan({ now: NOW });

    expect(mockAttentionResolve).toHaveBeenCalledWith('message', 'msg-nudge-1');
  });

  it('resolves the nudge row even when the confirmation post fails: the person still did it', async () => {
    const usedAt = new Date(NOW.getTime() - 10 * MINUTE);
    setup({ installs: [], open: [{ ...openEpisode, nudgeMessageId: 'msg-nudge-2' }] });
    mockInstallFindById.mockReturnValue({
      lean: () => Promise.resolve(install({ runtimeTokens: [{ createdAt: OLD_TOKEN, lastListenedAt: usedAt }] })),
    });
    mockPost.mockRejectedValueOnce(new Error('post down'));

    await scan({ now: NOW });

    expect(mockAttentionResolve).toHaveBeenCalledWith('message', 'msg-nudge-2');
  });

  // TASK-345: an MCP client uses its token and never listens, so the
  // listener-based state never leaves never-connected. It did connect, and the
  // promise is kept, without claiming it will answer @mentions.
  const mcpEpisode = { ...openEpisode, installedBy: 'user1', nudgeMessageId: 'nudge1', tokenIssuedAt: OLD_TOKEN };
  // The installer read asks only for the OS; the mock returns only what was asked.
  const installer = (onboarding) => mockUserFindById.mockReturnValue({
    select: (fields) => {
      expect(fields).toContain('onboarding.byoOpenedOs');
      const asked = new Set(String(fields).split(/\s+/).map((f) => f.replace(/^onboarding\./, '')));
      const picked = Object.fromEntries(Object.entries(onboarding).filter(([k]) => asked.has(k)));
      return { lean: () => Promise.resolve({ username: 'alice', onboarding: picked }) };
    },
  });
  const seenAt = new Date(NOW.getTime() - 4 * MINUTE);
  // A call the MCP client made on this episode's token.
  const mcpTokenOfThisEpisode = { createdAt: OLD_TOKEN, lastUsedAt: seenAt, lastMcpSeenAt: seenAt };
  const withInstallTokens = (runtimeTokens) => mockInstallFindById.mockReturnValue({
    lean: () => Promise.resolve(install({ runtimeTokens })),
  });

  it('closes the episode for an MCP client that called in, without promising an answer to mentions', async () => {
    setup({ installs: [], open: [mcpEpisode] });
    installer({});
    withInstallTokens([mcpTokenOfThisEpisode]);

    const r = await scan({ now: NOW });

    expect(r.resolved).toHaveLength(1);
    const { content } = mockPost.mock.calls[0][0];
    expect(content).toContain('connected from your MCP client (seen 2026-08-15 11:56 UTC)');
    expect(content).toContain("won't answer @ai1-agent on my own");
    expect(content).toContain('in a Terminal on the machine where I should live');
    expect(content).not.toMatch(/Listening now|I'll answer/);
    expect(mockAttentionResolve).toHaveBeenCalledWith('message', 'nudge1');
    expect(mockEpUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ _id: 'ep9', status: 'open' }),
      expect.objectContaining({ $set: expect.objectContaining({ status: 'resolved' }) }),
    );
  });

  it('counts an MCP call recorded only on the bot row, and points a Windows installer at Run it here', async () => {
    setup({ installs: [], open: [mcpEpisode], userTokens: [mcpTokenOfThisEpisode] });
    installer({ byoOpenedOs: 'windows' });
    withInstallTokens([]);

    const r = await scan({ now: NOW });

    expect(r.resolved).toHaveLength(1);
    const { content } = mockPost.mock.calls[0][0];
    expect(content).toContain("The listener is tested on a Mac. On Linux and Windows it isn't verified yet");
    expect(content).toContain('Run it here');
  });

  it('keeps waiting on a token used by something other than the MCP client (attach, memory import)', async () => {
    // `lastUsedAt` alone: `commonly agent attach` and the BYO page's memory
    // import both use the token without being an MCP client.
    setup({ installs: [], open: [mcpEpisode], userTokens: [{ createdAt: OLD_TOKEN, lastUsedAt: seenAt }] });
    installer({});
    withInstallTokens([{ createdAt: OLD_TOKEN, lastUsedAt: seenAt }]);

    const r = await scan({ now: NOW });

    expect(r.resolved).toHaveLength(0);
    expect(mockPost).not.toHaveBeenCalled();
    expect(mockEpUpdate).not.toHaveBeenCalled();
  });

  it('keeps waiting when the only MCP call belongs to a token from before this episode, even a later call', async () => {
    setup({ installs: [], open: [mcpEpisode] });
    installer({});
    const before = new Date(OLD_TOKEN.getTime() - 60 * MINUTE);
    withInstallTokens([
      { createdAt: before, lastMcpSeenAt: new Date(OLD_TOKEN.getTime() - 30 * MINUTE) },
      // Superseded but called after this episode began: still not this episode's token.
      { createdAt: before, lastMcpSeenAt: seenAt },
      { createdAt: OLD_TOKEN },
    ]);

    const r = await scan({ now: NOW });

    expect(r.resolved).toHaveLength(0);
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('still posts the MCP resolution when the installer OS cannot be read', async () => {
    setup({ installs: [], open: [mcpEpisode] });
    mockUserFindById.mockReturnValue({ select: () => ({ lean: () => Promise.reject(new Error('mongo down')) }) });
    withInstallTokens([mcpTokenOfThisEpisode]);

    const r = await scan({ now: NOW });

    expect(r.resolved).toHaveLength(1);
    expect(mockPost.mock.calls[0][0].content).toContain('in a Terminal on the machine where I should live');
  });

  it('a failed lookup on one episode leaves it open and still resolves the episodes after it', async () => {
    const failing = { ...mcpEpisode, _id: 'epA', installationId: 'instA' };
    setup({ installs: [], open: [failing, openEpisode] });
    mockInstallFindById.mockImplementation((id) => ({
      lean: () => (id === 'instA'
        ? Promise.reject(new Error('read failed'))
        : Promise.resolve(install({ runtimeTokens: [{ createdAt: OLD_TOKEN, lastListenedAt: seenAt }] }))),
    }));

    const r = await scan({ now: NOW });

    expect(r.resolved.map((x) => x.episodeId)).toEqual(['ep9']);
    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(mockEpUpdate).not.toHaveBeenCalledWith(expect.objectContaining({ _id: 'epA' }), expect.anything());
  });

  it('keeps waiting when the episode has no token issue time to scope by', async () => {
    setup({ installs: [], open: [{ ...mcpEpisode, tokenIssuedAt: undefined }] });
    installer({});
    withInstallTokens([mcpTokenOfThisEpisode]);

    const r = await scan({ now: NOW });

    expect(r.resolved).toHaveLength(0);
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('keeps waiting while it is still never-connected', async () => {
    setup({ installs: [], open: [openEpisode] });
    mockInstallFindById.mockReturnValue({ lean: () => Promise.resolve(install()) });

    const r = await scan({ now: NOW });

    expect(r.resolved).toHaveLength(0);
    expect(mockPost).not.toHaveBeenCalled();
    expect(mockAttentionResolve).not.toHaveBeenCalled();
  });

  it('closes silently when the seat was uninstalled — no room, no promise to keep', async () => {
    setup({ installs: [], open: [openEpisode] });
    mockInstallFindById.mockReturnValue({ lean: () => Promise.resolve(null) });

    await scan({ now: NOW });

    expect(mockPost).not.toHaveBeenCalled();
    expect(mockEpUpdate).toHaveBeenCalled();
  });
});
