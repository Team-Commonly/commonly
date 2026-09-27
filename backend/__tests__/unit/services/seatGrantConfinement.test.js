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
const mockIntegration = { findOne: jest.fn(), findById: jest.fn() };
const mockToolCall = { create: jest.fn() };
const mockReserveBudgetLineage = jest.fn();
const mockGithub = {
  listOpenIssues: jest.fn(),
  createIssue: jest.fn(),
  addIssueComment: jest.fn(),
  closeIssue: jest.fn(),
};

jest.mock('../../../models/Pod', () => ({ __esModule: true, default: mockPod }));
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
  mockIntegration.findOne.mockResolvedValue({
    type: 'github-app',
    status: 'connected',
    createdBy: OWNER,
    createdAt: CONNECTION_CREATED_AT,
    config: { installationId: 'gh-install-1', owner: 'Team-Commonly', repo: 'commonly' },
  });
  mockGithub.listOpenIssues.mockResolvedValue([]);
  mockPod.findById.mockImplementation(() => ({
    select: () => ({ lean: async () => ({ _id: POD, type: 'team', members: [OWNER, SEAT] }) }),
  }));
});

/** The seat's own User row and the machine binding that makes an owner. */
const bindSeat = async ({
  owner = OWNER, machineId = MACHINE, agentName = AGENT, instanceId = INSTANCE,
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

describe('judgeSeatConfinement — which declaration judges the caller', () => {
  test('a pi seat tagged only by runtimeType is refused (the hand-attached shape)', async () => {
    // `commonly agent attach pi` writes {runtimeType: 'pi', host: 'byo'} and no
    // adapter key, so a predicate reading `adapter` alone admitted it.
    await bindSeat();
    await installRow({ runtime: { runtimeType: 'pi', host: 'byo' } });

    const judgement = await judge();

    expect(judgement.refusal).toMatchObject({
      code: 'grant_broker_unconfined',
      reason: 'adapter_cannot_confine',
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
    expect((await judge()).refusal?.reason).toBe('adapter_cannot_confine');

    await AgentInstallation.deleteMany({});
    await installRow({ runtime: { adapter: ' PI ', host: 'byo' } });
    // The daemon trims and lowercases before spawning, so ' PI ' reaches pi too.
    expect((await judge()).refusal?.reason).toBe('adapter_cannot_confine');
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

    expect((await judge()).refusal?.reason).toBe('adapter_cannot_confine');

    // Same two rows, opposite insertion order: whichever projection is scanned
    // first, the refusing one decides.
    await AgentInstallation.deleteMany({});
    await installRow({ runtime: { runtimeType: 'pi' }, installedBy: OTHER_OWNER });
    await installRow({ runtime: { runtimeType: 'claude-code' }, installedBy: OWNER, podId: POD_TWO });
    expect((await judge()).refusal?.reason).toBe('adapter_cannot_confine');
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
      .toBe('adapter_cannot_confine');
  });

  test('a row installed by someone other than the machine owner is still judged', async () => {
    // The machine owner IS the scope the grant read projects through, and it
    // holds no row for this seat, so the read would report `not_installed` here.
    // The installer scan is what makes the broker call refuse anyway: the
    // declaration exists, and a refusal that a sibling surface cannot see is
    // still the right direction (a refusal can only be ADDED).
    await bindSeat({ owner: OWNER });
    await installRow({ runtime: { runtimeType: 'pi' }, installedBy: OTHER_OWNER, podId: POD_TWO });

    expect((await judge()).refusal?.reason).toBe('adapter_cannot_confine');
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
      details: expect.objectContaining({ reason: 'adapter_cannot_confine' }),
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

  test('positive control: the same grant and seat on claude-code runs', async () => {
    await bindSeat();
    await installRow({ runtime: { runtimeType: 'claude-code', host: 'byo' } });
    await RoomGrant.create(seatGrant());

    const result = await callTool({
      grantId: 'grant-1',
      agentUserId: SEAT,
      agentName: AGENT,
      instanceId: INSTANCE,
      tool: 'github.list_issues',
      args: {},
    });

    expect(result.callId).toBeTruthy();
    expect(mockGithub.listOpenIssues).toHaveBeenCalled();
    expect(mockToolCall.create).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'ok' }));
  });

  test('the tool list is refused too — an unconfined seat is handed no definitions', async () => {
    await bindSeat();
    await installRow({ runtime: { runtimeType: 'pi' } });
    await RoomGrant.create(seatGrant());

    await expect(listToolsForGrant({
      grantId: 'grant-1', agentUserId: SEAT, agentName: AGENT, instanceId: INSTANCE,
    })).rejects.toMatchObject({ code: 'grant_broker_unconfined' });
  });

  test('positive control: the list resolves for a confining seat', async () => {
    await bindSeat();
    await installRow({ runtime: { runtimeType: 'claude-code' } });
    await RoomGrant.create(seatGrant());

    const listed = await listToolsForGrant({
      grantId: 'grant-1', agentUserId: SEAT, agentName: AGENT, instanceId: INSTANCE,
    });
    expect(listed.map((definition) => definition.name)).toContain('github.list_issues');
  });

  test('a hosted turn is out of scope: no shell, web or file tools to confine', async () => {
    // The native runtime dispatches in process and sets `hosted`; refusing there
    // would refuse the hosted path the ruling excludes (Wren 74882).
    await bindSeat();
    await installRow({ runtime: { runtimeType: 'pi' } });
    await RoomGrant.create(seatGrant());

    const result = await callTool({
      grantId: 'grant-1',
      agentUserId: SEAT,
      agentName: AGENT,
      instanceId: INSTANCE,
      tool: 'github.list_issues',
      args: {},
      hosted: true,
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
