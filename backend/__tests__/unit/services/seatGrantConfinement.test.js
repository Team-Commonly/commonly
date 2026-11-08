/**
 * TASK-175 — the broker call refuses a seat that cannot confine it.
 *
 * The refusal ran where the broker is OFFERED (the server projection, the grant
 * read, the daemon's derive) and never where it is USED, so a seat nothing
 * confines could spend a grant whose only bound, for a read, is confinement.
 *
 * Real RoomGrant, User, Machine and AgentInstallation rows on memory Mongo: the
 * thing under test is the resolution (which row of which owner judges this
 * caller) and the predicate's adapter rule, and a mocked model would prove a
 * fact about the mock. The Postgres trail, the connection and the provider are
 * mocked at their module boundaries as `toolBrokerService.test.js` does.
 */
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

const mockPod = { findById: jest.fn() };
const mockIntegration = { findOne: jest.fn(), findById: jest.fn(), find: jest.fn() };
const mockToolCall = { create: jest.fn() };
const mockReserveBudgetLineage = jest.fn();
const mockGithub = {
  listOpenIssues: jest.fn(),
  createIssue: jest.fn(),
  addIssueComment: jest.fn(),
  closeIssue: jest.fn(),
};

// `runtimeIdentityOwnership` requires the module and calls `Pod.find` on it.
jest.mock('../../../models/Pod', () => ({
  __esModule: true, default: mockPod, find: (...args) => mockPod.find(...args),
}));
jest.mock('../../../models/Integration', () => ({ __esModule: true, default: mockIntegration }));
jest.mock('../../../models/ToolCall', () => ({
  __esModule: true,
  default: mockToolCall,
  // eslint-disable-next-line global-require
  digestArgs: (args) => require('crypto').createHash('sha256').update(JSON.stringify(args || {})).digest('hex'),
  reserveBudgetLineage: mockReserveBudgetLineage,
}));
jest.mock('../../../services/githubAppService', () => mockGithub);
jest.mock('../../../services/approvalActionService', () => ({
  proposeAction: jest.fn().mockResolvedValue({ ok: true, approvalId: 'approval-test' }),
}));
jest.mock('../../../services/dmService', () => ({
  getOrCreateAgentRoom: jest.fn().mockResolvedValue({ _id: 'room-1' }),
}));

const RoomGrant = require('../../../models/RoomGrant');
const User = require('../../../models/User');
const Machine = require('../../../models/Machine');
const { AgentInstallation } = require('../../../models/AgentRegistry');
const { judgeSeatConfinement } = require('../../../services/seatGrantConfinement');
const { recordMachineHeartbeat } = require('../../../services/machineService');
const { callTool, listToolsForGrant } = require('../../../services/toolBrokerService');

const POD = 'aaaaaaaaaaaaaaaaaaaaaa01';
const POD_TWO = 'aaaaaaaaaaaaaaaaaaaaaa02'; // the same seat in a second pod
const OWNER = 'bbbbbbbbbbbbbbbbbbbbbb01'; // the machine's owner: the projection scope
const OTHER_OWNER = 'bbbbbbbbbbbbbbbbbbbbbb02'; // a second installer of the same seat
const SEAT = 'cccccccccccccccccccccc01';
const AGENT = 'openclaw';
const INSTANCE = 'aria';
const MACHINE = 'machine-1';
const CONNECTION_CREATED_AT = new Date('2026-01-01T00:00:00.000Z');
const GRANT_CREATED_AT = new Date('2026-01-02T00:00:00.000Z');

let mongod;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  jest.clearAllMocks();
  await Promise.all([
    RoomGrant.deleteMany({}),
    User.deleteMany({}),
    Machine.deleteMany({}),
    AgentInstallation.deleteMany({}),
  ]);
  mockToolCall.create.mockResolvedValue(undefined);
  mockReserveBudgetLineage.mockResolvedValue(true);
  mockIntegration.findById.mockResolvedValue(null);
  mockIntegration.find.mockImplementation(() => ({
    select: () => ({ lean: async () => [] }),
  }));
  mockIntegration.findOne.mockResolvedValue({
    type: 'github-app',
    status: 'connected',
    createdBy: OWNER,
    createdAt: CONNECTION_CREATED_AT,
    config: { installationId: 'gh-install-1', owner: 'Team-Commonly', repo: 'commonly' },
  });
  mockGithub.listOpenIssues.mockResolvedValue([]);
  mockPod.findById.mockImplementation(() => ({
    select: () => ({ lean: async () => ({
      _id: POD, type: 'team', members: [OWNER, SEAT], publicRead: false, joinPolicy: 'invite-only',
    }) }),
  }));
});

/** The seat's own User row and the machine binding that makes an owner. */
const bindSeat = async ({
  owner = OWNER, machineId = MACHINE, agentName = AGENT, instanceId = INSTANCE, reported = true,
} = {}) => {
  await User.create({
    _id: SEAT,
    username: `${agentName}-${instanceId}`,
    email: `${agentName}-${instanceId}@agents.test`,
    // The model requires a password for accounts with no OAuth identity; the
    // value is never read here (only botMetadata is).
    password: 'fixture-only',
    botMetadata: { agentName, instanceId, machineId },
  });
  await Machine.create({
    ownerUserId: owner, machineId, name: 'laptop', status: 'online',
    ...(reported ? { hostSandboxReportedAt: new Date() } : {}),
  });
};

/** One active installation row: `config.runtime` and/or `config.environment`. */
const installRow = async ({
  runtime, environment, installedBy = OWNER, agentName = AGENT, instanceId = INSTANCE, podId = POD,
} = {}) => {
  const config = {};
  if (runtime !== undefined) config.runtime = runtime;
  if (environment !== undefined) config.environment = environment;
  return AgentInstallation.create({
    agentName, podId, instanceId, version: '1.0.0', status: 'active', installedBy, config,
  });
};

const judge = (over = {}) => judgeSeatConfinement({
  agentName: AGENT, instanceId: INSTANCE, agentUserId: SEAT, ...over,
});

const seatGrant = (over = {}) => ({
  grantId: 'grant-1',
  installationId: 'install-1',
  connectionId: 'conn-1',
  target: { kind: 'seat', id: SEAT },
  tools: ['github.list_issues'],
  writeMode: 'read',
  audience: [SEAT],
  expiresAt: new Date(Date.now() + 60000),
  createdAt: GRANT_CREATED_AT,
  brokerId: 'broker-1',
  ...over,
});

const podGrant = (over = {}) => seatGrant({ target: { kind: 'pod', id: POD }, audience: [OWNER, SEAT], ...over });

// F356: the daemon adopts seats in tick() before its first heartbeat reports
// the host's sandbox, and an old daemon never reports it. Until a report lands
// the host is "not reported": refused like an unconfined one, never confined.
describe('judgeSeatConfinement — a computer that has not reported its sandbox (F356)', () => {
  test('a seat adopted before the first heartbeat is refused as not reported, and admitted once it reports', async () => {
    await bindSeat({ reported: false });
    await installRow({ runtime: { adapter: 'claude', host: 'byo' }, environment: { sandbox: { trust: 'public' } } });
    expect(await judge()).toEqual({
      refusal: expect.objectContaining({ code: 'grant_broker_unconfined', reason: 'sandbox_not_reported', decidedBy: 'server' }),
      scope: 'seat',
      hostUnconfined: true,
      hostUnreported: true,
    });

    const machine = await Machine.findOne({ machineId: MACHINE });
    await recordMachineHeartbeat(machine, undefined, undefined, 'default');
    expect(await judge()).toEqual({ refusal: null, scope: 'seat' });
  });

  test('a first report of native-windows refuses as unconfined, not as not reported', async () => {
    await bindSeat({ reported: false });
    await installRow({ runtime: { adapter: 'claude', host: 'byo' }, environment: { sandbox: { trust: 'public' } } });
    const machine = await Machine.findOne({ machineId: MACHINE });
    await recordMachineHeartbeat(machine, undefined, undefined, 'native-windows');
    expect(await judge()).toEqual({
      refusal: expect.objectContaining({ reason: 'sandbox_mode_unenforceable' }),
      scope: 'seat',
      hostUnconfined: true,
    });
  });

  test('a heartbeat with no sandbox field leaves the host not reported', async () => {
    await bindSeat({ reported: false });
    await installRow({ runtime: { adapter: 'claude', host: 'byo' }, environment: { sandbox: { trust: 'public' } } });
    const machine = await Machine.findOne({ machineId: MACHINE });
    await recordMachineHeartbeat(machine, [], undefined, undefined);
    expect((await judge()).refusal).toEqual(expect.objectContaining({ reason: 'sandbox_not_reported' }));
  });
});

describe('judgeSeatConfinement — a seat on a computer that runs agents without a sandbox (D245)', () => {
  test('is refused whatever its declaration says, and admitted again once the daemon reports default', async () => {
    await bindSeat();
    // The stored declaration still reads public trust: the projection alone would admit it.
    await installRow({ runtime: { adapter: 'claude', host: 'byo' }, environment: { sandbox: { trust: 'public' } } });
    expect(await judge()).toEqual({ refusal: null, scope: 'seat' });

    await Machine.updateOne({ machineId: MACHINE }, { $set: { hostUnconfined: true } });
    expect(await judge()).toEqual({
      refusal: expect.objectContaining({ code: 'grant_broker_unconfined', reason: 'sandbox_mode_unenforceable', decidedBy: 'server' }),
      scope: 'seat',
      // F94: the one refusal a grant's consent never lifts says so.
      hostUnconfined: true,
    });

    await Machine.updateOne({ machineId: MACHINE }, { $set: { hostUnconfined: false } });
    expect(await judge()).toEqual({ refusal: null, scope: 'seat' });
  });

  test('a foreground run with no machine is refused once it marks the seat, and naming can\'t lift it', async () => {
    await bindSeat();
    await User.updateOne({ _id: SEAT }, { $set: { 'botMetadata.machineId': null } });
    await installRow({ runtime: { adapter: 'codex', host: 'byo' }, environment: { sandbox: { trust: 'public' } } });
    expect(await judge()).toEqual({ refusal: null, scope: 'seat' });

    await User.updateOne({ _id: SEAT }, { $set: { 'botMetadata.hostUnconfined': true } });
    expect(await judge()).toEqual({
      refusal: expect.objectContaining({ code: 'grant_broker_unconfined', reason: 'sandbox_mode_unenforceable' }),
      scope: 'seat',
      hostUnconfined: true,
    });
  });

  test('refuses even a seat no projection holds (a refusal can only be added)', async () => {
    await bindSeat();
    await Machine.updateOne({ machineId: MACHINE }, { $set: { hostUnconfined: true } });
    expect((await judge()).refusal?.reason).toBe('sandbox_mode_unenforceable');
  });

  test('another machine being unconfined does not refuse this seat', async () => {
    await bindSeat();
    await installRow({ runtime: { adapter: 'claude', host: 'byo' }, environment: { sandbox: { trust: 'public' } } });
    await Machine.create({ ownerUserId: OWNER, machineId: 'machine-2', name: 'pc', status: 'online', hostUnconfined: true });
    expect((await judge()).refusal).toBeNull();
  });
});

describe('judgeSeatConfinement — which declaration judges the caller', () => {
  test('a pi seat tagged only by runtimeType is refused (the hand-attached shape)', async () => {
    // `commonly agent attach pi` writes {runtimeType: 'pi', host: 'byo'} and no
    // adapter key, so a predicate reading `adapter` alone admitted it.
    await bindSeat();
    await installRow({ runtime: { runtimeType: 'pi', host: 'byo' } });

    const judgement = await judge();

    expect(judgement.refusal).toMatchObject({
      code: 'grant_broker_unconfined',
      reason: 'adapter_confines_public_only',
      decidedBy: 'server',
    });
    expect(judgement.scope).toBe('seat');
  });

  test('a declared adapter wins over a pi runtimeType (the daemon order)', async () => {
    await bindSeat();
    await installRow({ runtime: { adapter: 'claude', runtimeType: 'pi', host: 'byo' } });

    expect(await judge()).toEqual({ refusal: null, scope: 'seat' });
  });

  test('an explicit adapter pi is refused, and so is a shouted one', async () => {
    await bindSeat();
    await installRow({ runtime: { adapter: 'pi', host: 'byo' } });
    expect((await judge()).refusal?.reason).toBe('adapter_confines_public_only');

    await AgentInstallation.deleteMany({});
    await installRow({ runtime: { adapter: ' PI ', host: 'byo' } });
    // The daemon trims and lowercases before spawning, so ' PI ' reaches pi too.
    expect((await judge()).refusal?.reason).toBe('adapter_confines_public_only');
  });

  test('a claude-code runtimeType is not refused', async () => {
    await bindSeat();
    await installRow({ runtime: { runtimeType: 'claude-code', host: 'byo' } });

    expect(await judge()).toEqual({ refusal: null, scope: 'seat' });
  });

  test('a row naming NEITHER field stays daemon-decided, not refused', async () => {
    // The arm that rejects "refuse anything without an adapter": undeclared, the
    // daemon resolves only claude or codex, so failing closed here would refuse
    // working claude seats.
    await bindSeat();
    await installRow({ runtime: { host: 'byo' } });

    expect(await judge()).toEqual({ refusal: null, scope: 'seat' });
  });

  test('a webhook connect-page seat stays admitted', async () => {
    await bindSeat();
    await installRow({ runtime: { runtimeType: 'webhook', host: 'byo' } });

    expect(await judge()).toEqual({ refusal: null, scope: 'seat' });
  });

  test('the sandbox half still decides: mode none refuses, workspace+public does not', async () => {
    await bindSeat();
    await installRow({ runtime: { runtimeType: 'claude-code' }, environment: { sandbox: { mode: 'none' } } });
    expect((await judge()).refusal?.reason).toBe('sandbox_mode_none');

    await AgentInstallation.deleteMany({});
    await installRow({
      runtime: { runtimeType: 'claude-code' },
      environment: { sandbox: { mode: 'workspace', trust: 'public' } },
    });
    expect(await judge()).toEqual({ refusal: null, scope: 'seat' });
  });

  test('a seat no projection holds is unbound, and a sibling seat does not judge it', async () => {
    // The tripwire: an implementation that judged the first installation row it
    // found, rather than the calling seat's key, would refuse here.
    await bindSeat();
    await installRow({ runtime: { runtimeType: 'pi' }, agentName: 'other-agent', instanceId: 'other' });
    expect(await judge()).toEqual({ refusal: null, scope: 'unbound' });

    await AgentInstallation.deleteMany({});
    expect(await judge()).toEqual({ refusal: null, scope: 'unbound' });
  });

  test('two owners whose projections disagree fail closed, in either row order', async () => {
    await bindSeat({ owner: OWNER });
    await installRow({ runtime: { runtimeType: 'claude-code' }, installedBy: OWNER });
    await installRow({
      runtime: { runtimeType: 'pi' }, installedBy: OTHER_OWNER, podId: POD_TWO,
    });

    expect((await judge()).refusal?.reason).toBe('adapter_confines_public_only');

    // Same two rows, opposite insertion order: whichever projection is scanned
    // first, the refusing one decides.
    await AgentInstallation.deleteMany({});
    await installRow({ runtime: { runtimeType: 'pi' }, installedBy: OTHER_OWNER });
    await installRow({ runtime: { runtimeType: 'claude-code' }, installedBy: OWNER, podId: POD_TWO });
    expect((await judge()).refusal?.reason).toBe('adapter_confines_public_only');
  });

  test('an agentUserId that is not an ObjectId is unbound, not a 500', async () => {
    // The routes in front of this pass the token's identity, and a legacy path
    // can hand over a username: `User.findById` would cast-error and turn the
    // judgement into a broken broker response rather than a verdict.
    await expect(judgeSeatConfinement({
      agentName: AGENT, instanceId: INSTANCE, agentUserId: 'openclaw-aria',
    })).resolves.toEqual({ refusal: null, scope: 'unbound' });
  });

  test('a caller that names no identity is still judged through the bot row', async () => {
    // The legacy token path passes no agentName; the middleware resolved the
    // identity from the User row, so the same seat must still be judged.
    await bindSeat();
    await installRow({ runtime: { runtimeType: 'pi' } });

    expect((await judge({ agentName: undefined, instanceId: undefined })).refusal?.reason)
      .toBe('adapter_confines_public_only');
  });

  test('a row installed by someone other than the machine owner is still judged', async () => {
    // The machine owner IS the scope the grant read projects through, and it
    // holds no row for this seat, so the read would report `not_installed` here.
    // The installer scan is what makes the broker call refuse anyway: the
    // declaration exists, and a refusal that a sibling surface cannot see is
    // still the right direction (a refusal can only be ADDED).
    await bindSeat({ owner: OWNER });
    await installRow({ runtime: { runtimeType: 'pi' }, installedBy: OTHER_OWNER, podId: POD_TWO });

    expect((await judge()).refusal?.reason).toBe('adapter_confines_public_only');
  });
});

describe('the broker call and the tool list refuse an unconfined seat', () => {
  test('a pi seat is refused, trailed `refused`, and spends nothing', async () => {
    await bindSeat();
    await installRow({ runtime: { runtimeType: 'pi', host: 'byo' } });
    // The grant carries a budget ON PURPOSE: without one `budgetEntriesFor`
    // returns nothing, the reserve is never reachable, and the ordering this
    // arm asserts would pass even if the refusal ran after the reserve.
    await RoomGrant.create(seatGrant({ budget: { calls: 5, windowMs: 60000 } }));

    await expect(callTool({
      grantId: 'grant-1',
      agentUserId: SEAT,
      agentName: AGENT,
      instanceId: INSTANCE,
      tool: 'github.list_issues',
      args: {},
    })).rejects.toMatchObject({
      code: 'grant_broker_unconfined',
      statusCode: 403,
      details: expect.objectContaining({ reason: 'adapter_confines_public_only' }),
    });

    // Not a spendable call: the provider was never reached and no budget line
    // was reserved — the refusal runs before both.
    expect(mockGithub.listOpenIssues).not.toHaveBeenCalled();
    expect(mockReserveBudgetLineage).not.toHaveBeenCalled();
    // But it IS trailed, with the predicate's own reason.
    expect(mockToolCall.create).toHaveBeenCalledWith(expect.objectContaining({
      grantId: 'grant-1',
      agentUserId: SEAT,
      outcome: 'refused',
      reason: 'grant_broker_unconfined',
    }));
  });

  test('a confining seat still cannot use an outsider-writable seat grant', async () => {
    await bindSeat();
    await installRow({ runtime: { runtimeType: 'claude-code', host: 'byo' } });
    await RoomGrant.create(seatGrant());

    await expect(callTool({
      grantId: 'grant-1',
      agentUserId: SEAT,
      agentName: AGENT,
      instanceId: INSTANCE,
      tool: 'github.list_issues',
      args: {},
    })).rejects.toMatchObject({ code: 'outsider_grant_pod_required', statusCode: 403 });
    expect(mockGithub.listOpenIssues).not.toHaveBeenCalled();
  });

  test('the tool list is refused too — an unconfined seat is handed no definitions', async () => {
    await bindSeat();
    await installRow({ runtime: { runtimeType: 'pi' } });
    await RoomGrant.create(seatGrant());

    await expect(listToolsForGrant({
      grantId: 'grant-1', agentUserId: SEAT, agentName: AGENT, instanceId: INSTANCE,
    })).rejects.toMatchObject({ code: 'grant_broker_unconfined' });
  });

  test('a confining seat cannot list an outsider-writable seat grant', async () => {
    await bindSeat();
    await installRow({ runtime: { runtimeType: 'claude-code' } });
    await RoomGrant.create(seatGrant());

    await expect(listToolsForGrant({
      grantId: 'grant-1', agentUserId: SEAT, agentName: AGENT, instanceId: INSTANCE,
    })).rejects.toMatchObject({ code: 'outsider_grant_pod_required', statusCode: 403 });
  });

  test('a hosted turn does not exempt an outsider-writable seat grant', async () => {
    await bindSeat();
    await installRow({ runtime: { runtimeType: 'pi' } });
    await RoomGrant.create(seatGrant());

    await expect(callTool({
      grantId: 'grant-1',
      agentUserId: SEAT,
      agentName: AGENT,
      instanceId: INSTANCE,
      tool: 'github.list_issues',
      args: {},
      hostedTurn: true,
    })).rejects.toMatchObject({ code: 'outsider_grant_pod_required', statusCode: 403 });
    expect(mockGithub.listOpenIssues).not.toHaveBeenCalled();
  });

  test('positive control: a closed native pod grant lists and calls the tool', async () => {
    await bindSeat();
    await User.updateOne({ _id: SEAT }, { $set: { isBot: true, botType: 'agent' } });
    await installRow({ runtime: { runtimeType: 'native' } });
    mockPod.findById.mockImplementation(() => ({
      select: () => ({ lean: async () => ({
        _id: POD, type: 'team', members: [SEAT], publicRead: false, joinPolicy: 'invite-only',
      }) }),
    }));
    await RoomGrant.create(podGrant({ audience: [SEAT] }));

    const listed = await listToolsForGrant({
      grantId: 'grant-1', agentUserId: SEAT, agentName: AGENT, instanceId: INSTANCE,
    });
    expect(listed.map((definition) => definition.name)).toContain('github.list_issues');

    const result = await callTool({
      grantId: 'grant-1', agentUserId: SEAT, agentName: AGENT, instanceId: INSTANCE,
      tool: 'github.list_issues', args: {}, hostedTurn: true,
    });
    expect(result.callId).toBeTruthy();
    expect(mockGithub.listOpenIssues).toHaveBeenCalled();
  });

  test('grant-level refusals still win: a revoked grant is revoked, not unconfined', async () => {
    await bindSeat();
    await installRow({ runtime: { runtimeType: 'pi' } });
    await RoomGrant.create(seatGrant({ revokedAt: new Date(), revokedBy: OWNER }));

    await expect(callTool({
      grantId: 'grant-1',
      agentUserId: SEAT,
      agentName: AGENT,
      instanceId: INSTANCE,
      tool: 'github.list_issues',
      args: {},
    })).rejects.toMatchObject({ code: 'grant_revoked' });
  });
});

// F150 security review (HIGH): a seat with no machine has no daemon to derive a
// sandbox baseline, so an ABSENT sandbox block on its row confines nothing. The
// per-call judgement refuses it with a refusal naming lifts (F94); a daemon
// seat (with a machineId) keeps today's daemon-decided reading.
describe('judgeSeatConfinement — a seat with no daemon and no sandbox block (F150)', () => {
  beforeEach(() => {
    // The naming check reads the granter's installations' pods (ownsRuntimeIdentity).
    mockPod.find = jest.fn(() => ({ select: () => ({ lean: async () => [] }) }));
  });
  afterEach(() => {
    delete mockPod.find;
  });
  const unboundSeat = async () => {
    // No machineId: a seat run with `commonly agent run`, or a Connect-page token.
    await User.create({
      _id: SEAT, username: `${AGENT}-${INSTANCE}`, email: `${AGENT}-${INSTANCE}@agents.test`,
      password: 'fixture-only', isBot: true, botType: 'agent', botMetadata: { agentName: AGENT, instanceId: INSTANCE },
    });
  };
  const namedPodGrant = () => podGrant({
    audience: [SEAT],
    ownerId: OWNER,
    byoAgents: [SEAT],
    byoConsent: { by: OWNER, at: new Date(), version: 'byo-v1', agents: [{ userId: SEAT, sandbox: 'unknown' }] },
  });
  const call = () => callTool({
    grantId: 'grant-1', agentUserId: SEAT, agentName: AGENT, instanceId: INSTANCE,
    tool: 'github.list_issues', args: {},
  });

  test('is refused as sandbox_absent, a refusal naming can lift', async () => {
    await unboundSeat();
    await installRow({ runtime: { runtimeType: 'webhook', host: 'byo' } });
    expect(await judge()).toEqual({
      refusal: expect.objectContaining({ code: 'grant_broker_unconfined', decidedBy: 'server', reason: 'sandbox_absent' }),
      scope: 'seat',
    });
  });

  test.each([
    [{ runtimeType: 'native' }],
    [{ runtimeType: 'moltbot' }],
  ])('a runtime Commonly runs (%j) keeps the old reading: no refusal', async (runtime) => {
    await unboundSeat();
    await installRow({ runtime });
    expect(await judge()).toEqual({ refusal: null, scope: 'seat' });
  });

  test('an adapter-shaped BYO row with no sandbox block is refused too', async () => {
    await unboundSeat();
    await installRow({ runtime: { adapter: 'claude', host: 'byo' } });
    expect((await judge()).refusal?.reason).toBe('sandbox_absent');
  });

  test.each([
    [{ runtimeType: 'codex', adapter: 'codex' }],
    // The same row after the owner's Settings harness switch.
    [{ runtimeType: 'codex', adapter: 'claude' }],
  ])('a codex row that names an adapter (%j) is a BYO seat: refused', async (runtime) => {
    await unboundSeat();
    await installRow({ runtime });
    expect((await judge()).refusal?.reason).toBe('sandbox_absent');
  });

  test('a cloud codex row (no adapter, no host) keeps the old reading', async () => {
    await unboundSeat();
    await installRow({ runtime: { runtimeType: 'codex' } });
    expect(await judge()).toEqual({ refusal: null, scope: 'seat' });
  });

  test('a declared confining sandbox still judges the seat confinable', async () => {
    await unboundSeat();
    await installRow({
      runtime: { runtimeType: 'webhook' }, environment: { sandbox: { mode: 'workspace', trust: 'public' } },
    });
    expect(await judge()).toEqual({ refusal: null, scope: 'seat' });
  });

  test('a daemon seat with no sandbox block is unchanged: daemon-decided, not refused', async () => {
    await bindSeat();
    await installRow({ runtime: { runtimeType: 'webhook', host: 'byo' } });
    expect(await judge()).toEqual({ refusal: null, scope: 'seat' });
  });

  test('an unnamed grant is refused per call, before any tool work', async () => {
    await unboundSeat();
    await installRow({ runtime: { runtimeType: 'webhook', host: 'byo' } });
    mockPod.findById.mockImplementation(() => ({
      select: () => ({ lean: async () => ({
        _id: POD, type: 'team', members: [SEAT], publicRead: false, joinPolicy: 'invite-only',
      }) }),
    }));
    await RoomGrant.create(podGrant({ audience: [SEAT] }));
    await expect(call()).rejects.toMatchObject({
      code: 'grant_broker_unconfined', statusCode: 403,
      details: expect.objectContaining({ reason: 'sandbox_absent' }),
    });
    expect(mockGithub.listOpenIssues).not.toHaveBeenCalled();
  });

  test('the grant that names it is allowed and recorded named_unconfined', async () => {
    await unboundSeat();
    await installRow({ runtime: { runtimeType: 'webhook', host: 'byo' } });
    mockPod.findById.mockImplementation(() => ({
      select: () => ({ lean: async () => ({
        _id: POD, type: 'team', members: [SEAT], publicRead: false, joinPolicy: 'invite-only',
      }) }),
    }));
    await RoomGrant.create(namedPodGrant());
    const result = await call();
    expect(result.callId).toBeTruthy();
    expect(mockGithub.listOpenIssues).toHaveBeenCalled();
    expect(mockToolCall.create).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'ok', callerConfinement: 'named_unconfined',
    }));
  });
});
