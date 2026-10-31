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
    'from a %s browser, says the listener answers @mentions only on a Mac, if it ran there',
    async (os, label) => {
      setup();
      copiedListenerOn(os);
      await scan({ now: NOW });
      const { content } = mockPost.mock.calls[0][0];
      // Conditional: the page shows this command only on its Mac tab, so the
      // browser's OS is not proof of where it ran.
      expect(content).toContain(`If you ran it on ${label}, that's likely why: the listener answers @mentions only from a Mac for now.`);
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
      expect(content).toContain(`you first opened this page on ${label}`);
      expect(content).toContain('in a Terminal on a Mac');
      expect(content).not.toContain('but not the listener command');
    },
  );

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

  it("resolves the installer's needs-you row for the nudge once the agent connects", async () => {
    const usedAt = new Date(NOW.getTime() - 10 * MINUTE);
    setup({ installs: [], open: [{ ...openEpisode, nudgeMessageId: 'msg-nudge-1' }] });
    mockInstallFindById.mockReturnValue({
      lean: () => Promise.resolve(install({ runtimeTokens: [{ createdAt: OLD_TOKEN, lastUsedAt: usedAt }] })),
    });

    await scan({ now: NOW });

    expect(mockAttentionResolve).toHaveBeenCalledWith('message', 'msg-nudge-1');
  });

  it('resolves the nudge row even when the confirmation post fails: the person still did it', async () => {
    const usedAt = new Date(NOW.getTime() - 10 * MINUTE);
    setup({ installs: [], open: [{ ...openEpisode, nudgeMessageId: 'msg-nudge-2' }] });
    mockInstallFindById.mockReturnValue({
      lean: () => Promise.resolve(install({ runtimeTokens: [{ createdAt: OLD_TOKEN, lastUsedAt: usedAt }] })),
    });
    mockPost.mockRejectedValueOnce(new Error('post down'));

    await scan({ now: NOW });

    expect(mockAttentionResolve).toHaveBeenCalledWith('message', 'msg-nudge-2');
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
