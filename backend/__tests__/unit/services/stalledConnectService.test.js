// Stalled-connect nudge (W4 item 3). Spec: ux-lead 2026-08-14; calibration and
// corrections from pod-architect / sprint-impl, 2026-08-15.
//
// The load-bearing rules, each one a decision that could be silently undone:
//   - one nudge per TOKEN-episode, and a reissue earns another
//   - the episode key is max(createdAt) across BOTH token stores
//   - 15 min is a patience window on top of deriveAgentState, not a 2nd rule
//   - the episode is claimed BEFORE the row is written, so a race loses silently
//   - nothing is posted into the pod (F666): the installer gets a private
//     Needs-you row, and connecting resolves it

const MINUTE = 60 * 1000;
const NOW = new Date('2026-08-15T12:00:00Z');
const OLD_TOKEN = new Date(NOW.getTime() - 30 * MINUTE);
const FRESH_TOKEN = new Date(NOW.getTime() - 2 * MINUTE);

const mockInstallFind = jest.fn();
const mockOwns = jest.fn();
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
const mockAttentionDismiss = jest.fn();
const mockRecord = jest.fn();
const mockRowClose = jest.fn();
jest.mock('../../../services/attentionItemService', () => ({
  resolveActioned: (...a) => mockAttentionResolve(...a),
  resolve: (...a) => mockAttentionDismiss(...a),
  recordStalledConnect: (...a) => mockRecord(...a),
  resolveStalledConnectEpisode: (...a) => mockRowClose(...a),
}));

const mockEpCreate = jest.fn();
const mockEpFind = jest.fn();
const mockEpUpdate = jest.fn();
const mockEpFindOne = jest.fn();
jest.mock('../../../models/Pod', () => ({ exists: () => Promise.resolve(true) }));
jest.mock('../../../services/runtimeIdentityOwnership', () => ({
  ...jest.requireActual('../../../services/runtimeIdentityOwnership'),
  ownsRuntimeIdentity: (...args) => mockOwns(...args),
}));
jest.mock('../../../models/StalledConnectEpisode', () => ({
  create: (...a) => mockEpCreate(...a),
  find: (...a) => mockEpFind(...a),
  updateOne: (...a) => mockEpUpdate(...a),
  findOne: (...a) => mockEpFindOne(...a),
}));

const { scan, resolveTokenEpisode, RESOLVE_PAGE_SIZE } = require('../../../services/stalledConnectService');

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

const setup = ({ installs = [install()], userTokens = [], open = [], machineId } = {}) => {
  mockOwns.mockResolvedValue({ owned: true });
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
      expect(fields).toContain('agentRuntimeTokens.lastUsedAt');
      expect(fields).toContain('botMetadata.machineId');
      const rows = (filter.$or || []).map((pair) => ({
        botMetadata: {
          agentName: pair['botMetadata.agentName'],
          instanceId: pair['botMetadata.instanceId'],
          machineId,
        },
        agentRuntimeTokens: userTokens,
      }));
      return { lean: () => Promise.resolve(rows) };
    },
  }));
  mockUserFindById.mockReturnValue({
    select: () => ({ lean: () => Promise.resolve({ username: 'alice' }) }),
  });
  // The resolution sweep pages open episodes in _id order (F505); honour the
  // cursor and the page size so a test past one page sees every page.
  mockEpFind.mockImplementation((filter = {}) => {
    const rows = filter.status === 'open'
      ? open.filter((ep) => !filter._id || String(ep._id) > String(filter._id.$gt)) : [];
    // A $gt cursor over unsorted pages skips episodes: the sweep must sort by _id.
    let sortedById = false;
    const chain = {
      sort: (order) => { sortedById = JSON.stringify(order) === '{"_id":1}'; return chain; },
      limit: (n) => {
        if (filter.status === 'open') expect(sortedById).toBe(true);
        return { lean: () => Promise.resolve(rows.slice(0, n)) };
      },
      select: () => ({ lean: () => Promise.resolve([]) }),
      lean: () => Promise.resolve(rows),
    };
    return chain;
  });
  mockEpCreate.mockImplementation((d) => Promise.resolve({ _id: 'ep1', ...d }));
  mockEpUpdate.mockResolvedValue({});
  mockEpFindOne.mockReturnValue({ lean: () => Promise.resolve(null) });
  mockRowClose.mockResolvedValue(undefined);
  mockPost.mockResolvedValue({ success: true, message: { id: 'msg1' } });
  mockRecord.mockResolvedValue({ recorded: true });
};

beforeEach(() => jest.clearAllMocks());
// Nothing in this service may post into a pod (F666).
afterEach(() => expect(mockPost).not.toHaveBeenCalled());

const notice = () => mockRecord.mock.calls[0][0];

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
  const madeOnPage = { config: { runtime: { runtimeType: 'webhook', adapter: 'claude', host: 'byo' } } };

  it('sends an agent made on the page to Connect, since its key is on no computer', async () => {
    setup({ installs: [install(madeOnPage)] });
    await scan({ now: NOW });

    expect(notice().detail).toContain('press Connect in its panel');
    expect(notice().detail).not.toContain('agent run');
  });

  it('sends a second instance made on the page to Connect too: the link carries its instance (F306)', async () => {
    setup({ installs: [install({ ...madeOnPage, instanceId: 'other' })] });
    await scan({ now: NOW });

    expect(notice().detail).toContain('press Connect');
  });

  it.each([
    ['an attached agent, whose key is saved', { config: { runtime: { runtimeType: 'claude-code', host: 'byo' } } }, undefined],
    ['an agent init bot, whose key is saved', { config: { runtime: { runtimeType: 'webhook', host: 'byo' } } }, undefined],
    ['a seat on a machine', madeOnPage, 'machine-1'],
  ])('points at the start command for %s', async (_label, over, machineId) => {
    setup({ installs: [install(over)], machineId });
    await scan({ now: NOW });

    expect(notice().detail).toContain('its panel has the command that starts it');
    expect(notice().detail).not.toContain('Connect');
  });

  it('points at the start command when the owner can\'t be read: Connect could be refused', async () => {
    setup({ installs: [install(madeOnPage)] });
    mockOwns.mockRejectedValue(new Error('read failed'));
    await scan({ now: NOW });

    expect(notice().detail).toContain('its panel has the command that starts it');
    expect(notice().detail).not.toContain('Connect');
  });

  it.each([
    ['the bot row', { userTokens: [{ createdAt: OLD_TOKEN, lastUsedAt: OLD_TOKEN }] }],
    ['an older token', { userTokens: [{ createdAt: new Date(OLD_TOKEN.getTime() - 60 * 1000), lastUsedAt: OLD_TOKEN }] }],
    ['a token with no issue time', { userTokens: [{ lastUsedAt: OLD_TOKEN }] }],
    ['the installation', { runtimeTokens: [{ createdAt: OLD_TOKEN, lastUsedAt: OLD_TOKEN }] }],
  ])('points at the start command once %s shows a call, because Settings stops offering Connect', async (_label, { userTokens, runtimeTokens }) => {
    setup({ installs: [install({ ...madeOnPage, ...(runtimeTokens ? { runtimeTokens } : {}) })], userTokens });
    await scan({ now: NOW });

    expect(notice().detail).toContain('its panel has the command that starts it');
    expect(notice().detail).not.toContain('Connect');
  });

  it('gives the installer a private row for a seat whose token was issued long ago and never used', async () => {
    setup();
    const r = await scan({ now: NOW });

    expect(r.nudged).toHaveLength(1);
    expect(mockRecord).toHaveBeenCalledTimes(1);
    expect(notice()).toEqual(expect.objectContaining({
      recipientUserId: 'user1', podId: 'pod1', installationId: 'inst1',
    }));
    expect(notice().title).toBe("AI1 Agent hasn't connected yet");
    // The command lives in the owner's panel, never in the row.
    expect(notice().detail).not.toMatch(/npx|agent run/);
    expect(mockEpUpdate).toHaveBeenCalledWith({ _id: 'ep1' }, { $set: { noticedAt: NOW } });
  });

  it('passes the bot id, which the first listen closes the row by', async () => {
    setup();
    mockUserFind.mockImplementation((filter) => ({
      select: () => ({
        lean: () => Promise.resolve((filter.$or || []).map((pair) => ({
          _id: 'bot1',
          botMetadata: { agentName: pair['botMetadata.agentName'], instanceId: pair['botMetadata.instanceId'] },
          agentRuntimeTokens: [],
        }))),
      }),
    }));
    await scan({ now: NOW });

    expect(notice().agentUserId).toBe('bot1');
  });


  it('holds fire inside the patience window', async () => {
    setup({ installs: [install({ runtimeTokens: [{ createdAt: FRESH_TOKEN }] })] });
    const r = await scan({ now: NOW });

    expect(r.nudged).toHaveLength(0);
    expect(r.skippedTooRecent).toBe(1);
    expect(mockRecord).not.toHaveBeenCalled();
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
    expect(mockRecord).toHaveBeenCalledTimes(1);
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
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('claims the episode BEFORE writing the row, so a losing race never reopens a handled row', async () => {
    setup();
    const order = [];
    mockEpCreate.mockImplementation(async (d) => { order.push('claim'); return { _id: 'ep1', ...d }; });
    mockRecord.mockImplementation(async () => {
      order.push('row');
      return { recorded: true };
    });

    await scan({ now: NOW });

    expect(order).toEqual(['claim', 'row']);
  });

  it('stays silent when the episode was already explained (duplicate key)', async () => {
    setup();
    mockEpCreate.mockRejectedValue(Object.assign(new Error('dup'), { code: 11000 }));

    const r = await scan({ now: NOW });

    expect(r.nudged).toHaveLength(0);
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('does not count it as told when the installer is no longer in the pod', async () => {
    setup();
    mockRecord.mockResolvedValue({ recorded: false, reason: 'recipient_not_member' });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const r = await scan({ now: NOW });
    warn.mockRestore();

    expect(r.nudged).toHaveLength(0);
    expect(mockEpUpdate).not.toHaveBeenCalled();
  });

  it('gives an MCP client that called in no row: it did connect', async () => {
    const seen = new Date(NOW.getTime() - MINUTE);
    setup({ installs: [install({ runtimeTokens: [{ createdAt: OLD_TOKEN, lastUsedAt: seen, lastMcpSeenAt: seen }] })] });

    const r = await scan({ now: NOW });

    expect(mockEpCreate).toHaveBeenCalledTimes(1);
    expect(mockRecord).not.toHaveBeenCalled();
    expect(r.nudged).toHaveLength(0);
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
    expect(mockRecord).toHaveBeenCalledTimes(1);
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

    const result = await scan({ now: NOW });

    expect(mockUserFind.mock.calls[0][0].$or).toHaveLength(1);
    // Both installs got the first row's token: one person, one row.
    expect(mockEpCreate.mock.calls.map(([doc]) => doc.tokenSource)).toEqual(['user']);
    expect(result.skippedSameToken).toBe(1);
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

describe('closing the row when the agent connects', () => {
  const openEpisode = {
    _id: 'ep9',
    installationId: 'inst1',
    podId: 'pod1',
    agentName: 'ai1-agent',
    instanceId: 'default',
    displayName: 'AI1 Agent',
    status: 'open',
  };

  it('resolves the row as actioned once the token is used, closes the episode, and posts nothing', async () => {
    const usedAt = new Date(NOW.getTime() - 10 * MINUTE);
    setup({ installs: [], open: [openEpisode] });
    mockInstallFindById.mockReturnValue({
      lean: () => Promise.resolve(install({ runtimeTokens: [{ createdAt: OLD_TOKEN, lastListenedAt: usedAt }] })),
    });

    const r = await scan({ now: NOW });

    expect(r.resolved).toHaveLength(1);
    expect(mockRowClose).toHaveBeenCalledWith('inst1', 'ep9', { actioned: true });
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

  it("resolves a pre-F666 nudge's needs-you row once the agent connects", async () => {
    const usedAt = new Date(NOW.getTime() - 10 * MINUTE);
    setup({ installs: [], open: [{ ...openEpisode, nudgeMessageId: 'msg-nudge-1' }] });
    mockInstallFindById.mockReturnValue({
      lean: () => Promise.resolve(install({ runtimeTokens: [{ createdAt: OLD_TOKEN, lastListenedAt: usedAt }] })),
    });

    await scan({ now: NOW });

    expect(mockAttentionResolve).toHaveBeenCalledWith('message', 'msg-nudge-1', { strict: true });
  });

  // TASK-345: an MCP client uses its token and never listens, so the
  // listener-based state never leaves never-connected. It did connect.
  const mcpEpisode = { ...openEpisode, installedBy: 'user1', nudgeMessageId: 'nudge1', tokenIssuedAt: OLD_TOKEN };
  const seenAt = new Date(NOW.getTime() - 4 * MINUTE);
  // A call the MCP client made on this episode's token.
  const mcpTokenOfThisEpisode = { createdAt: OLD_TOKEN, lastUsedAt: seenAt, lastMcpSeenAt: seenAt };
  const withInstallTokens = (runtimeTokens) => mockInstallFindById.mockReturnValue({
    lean: () => Promise.resolve(install({ runtimeTokens })),
  });

  it('closes the episode and its row for an MCP client that called in', async () => {
    setup({ installs: [], open: [mcpEpisode] });
    withInstallTokens([mcpTokenOfThisEpisode]);

    const r = await scan({ now: NOW });

    expect(r.resolved).toHaveLength(1);
    expect(mockAttentionResolve).toHaveBeenCalledWith('message', 'nudge1', { strict: true });
    expect(mockRowClose).toHaveBeenCalledWith('inst1', 'ep9', { actioned: true });
    expect(mockEpUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ _id: 'ep9', status: 'open' }),
      expect.objectContaining({ $set: expect.objectContaining({ status: 'resolved' }) }),
    );
  });

  it('counts an MCP call recorded only on the bot row', async () => {
    setup({ installs: [], open: [mcpEpisode], userTokens: [mcpTokenOfThisEpisode] });
    withInstallTokens([]);

    const r = await scan({ now: NOW });

    expect(r.resolved).toHaveLength(1);
  });

  it('keeps waiting on a token used by something other than the MCP client (attach, memory import)', async () => {
    // `lastUsedAt` alone: `commonly agent attach` and the BYO page's memory
    // import both use the token without being an MCP client.
    setup({ installs: [], open: [mcpEpisode], userTokens: [{ createdAt: OLD_TOKEN, lastUsedAt: seenAt }] });
    withInstallTokens([{ createdAt: OLD_TOKEN, lastUsedAt: seenAt }]);

    const r = await scan({ now: NOW });

    expect(r.resolved).toHaveLength(0);
    expect(mockEpUpdate).not.toHaveBeenCalled();
  });

  it('keeps waiting when the only MCP call belongs to a token from before this episode, even a later call', async () => {
    setup({ installs: [], open: [mcpEpisode] });
    const before = new Date(OLD_TOKEN.getTime() - 60 * MINUTE);
    withInstallTokens([
      { createdAt: before, lastMcpSeenAt: new Date(OLD_TOKEN.getTime() - 30 * MINUTE) },
      // Superseded but called after this episode began: still not this episode's token.
      { createdAt: before, lastMcpSeenAt: seenAt },
      { createdAt: OLD_TOKEN },
    ]);

    const r = await scan({ now: NOW });

    expect(r.resolved).toHaveLength(0);
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
    expect(mockEpUpdate).not.toHaveBeenCalledWith(expect.objectContaining({ _id: 'epA' }), expect.anything());
  });

  it('keeps waiting when the episode has no token issue time to scope by', async () => {
    setup({ installs: [], open: [{ ...mcpEpisode, tokenIssuedAt: undefined }] });
    withInstallTokens([mcpTokenOfThisEpisode]);

    const r = await scan({ now: NOW });

    expect(r.resolved).toHaveLength(0);
  });

  it('keeps waiting while it is still never-connected', async () => {
    setup({ installs: [], open: [openEpisode] });
    mockInstallFindById.mockReturnValue({ lean: () => Promise.resolve(install()) });

    const r = await scan({ now: NOW });

    expect(r.resolved).toHaveLength(0);
    expect(mockAttentionResolve).not.toHaveBeenCalled();
    expect(mockRowClose).not.toHaveBeenCalled();
  });

  it('closes when the seat was uninstalled: nothing left to start', async () => {
    setup({ installs: [], open: [openEpisode] });
    mockInstallFindById.mockReturnValue({ lean: () => Promise.resolve(null) });

    await scan({ now: NOW });

    expect(mockEpUpdate).toHaveBeenCalled();
    expect(mockRowClose).toHaveBeenCalledWith('inst1', 'ep9', { actioned: false });
  });

  // F505: one unsorted batch of 200 left every open episode past it open for
  // good, since never-connected ones never leave the open set.
  it('reaches every open episode, past the first page too', async () => {
    const many = Array.from({ length: RESOLVE_PAGE_SIZE + 1 }, (_, i) => ({
      ...openEpisode, _id: `ep${String(i).padStart(4, '0')}`,
    }));
    setup({ installs: [], open: many });
    mockInstallFindById.mockReturnValue({ lean: () => Promise.resolve(null) });

    const r = await scan({ now: NOW });

    expect(r.resolved).toHaveLength(RESOLVE_PAGE_SIZE + 1);
    expect(r.resolved.map((x) => x.episodeId)).toContain(`ep${String(RESOLVE_PAGE_SIZE).padStart(4, '0')}`);
    const pages = mockEpFind.mock.calls.filter(([f]) => f?.status === 'open');
    expect(pages.map(([f]) => f._id?.$gt || null)).toEqual([null, `ep${String(RESOLVE_PAGE_SIZE - 1).padStart(4, '0')}`]);
  });

  it('treats an uninstall as gone: the install row stays, and nobody started it', async () => {
    mockAttentionDismiss.mockClear();
    setup({ installs: [], open: [{ ...openEpisode, nudgeMessageId: 'nudge9' }] });
    mockInstallFindById.mockReturnValue({
      lean: () => Promise.resolve(install({ status: 'uninstalled' })),
    });

    const result = await scan({ now: NOW });

    expect(result.resolved).toHaveLength(1);
    expect(mockEpUpdate.mock.calls[0][1].$set.status).toBe('resolved');
    // Its "needs you" row goes too, and not as acted on.
    expect(mockAttentionDismiss).toHaveBeenCalledWith('message', 'nudge9', { strict: true });
    expect(mockAttentionResolve).not.toHaveBeenCalled();
    expect(mockRowClose).toHaveBeenCalledWith('inst1', 'ep9', { actioned: false });
  });
});
