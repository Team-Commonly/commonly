/**
 * #915 — Your Team's "last seen" must cover every runtime class.
 *
 * `lastHeartbeatAt` derives from delivered heartbeat AgentEvents, which only
 * gateway moltbots produce. Native agents (the Guide) run via AgentRun rows
 * and BYO wrappers stamp runtime-token lastUsedAt — with heartbeats as the
 * only source, the Guide's card read "Never connected" two minutes after it
 * replied. The route now projects `lastActiveAt` = max(heartbeat, token use,
 * AgentRun start) alongside the unchanged `lastHeartbeatAt`.
 */
const request = require('supertest');
const express = require('express');

jest.mock('../../../middleware/auth', () => (req, res, next) => {
  req.user = { id: 'user-1' };
  req.userId = 'user-1';
  next();
});

jest.mock('../../../middleware/adminAuth', () => (req, res, next) => next());

jest.mock('../../../models/Pod', () => ({
  findById: jest.fn(),
}));

jest.mock('../../../models/AgentRegistry', () => ({
  AgentRegistry: {
    find: jest.fn(),
  },
  AgentInstallation: {
    getInstalledAgents: jest.fn(),
  },
}));

jest.mock('../../../models/AgentProfile', () => ({
  find: jest.fn(),
}));
jest.mock('../../../models/AgentTemplate', () => ({
  find: jest.fn(),
}));
jest.mock('../../../models/AgentEvent', () => ({
  aggregate: jest.fn().mockResolvedValue([]),
}));
jest.mock('../../../models/AgentRun', () => ({
  aggregate: jest.fn().mockResolvedValue([]),
}));
jest.mock('../../../models/AgentCredential', () => ({ find: jest.fn() }));
jest.mock('../../../models/Machine', () => ({ find: jest.fn() }));

jest.mock('../../../models/User', () => ({
  find: jest.fn().mockReturnValue({
    select: jest.fn().mockReturnValue({
      lean: jest.fn().mockResolvedValue([]),
    }),
  }),
}));

jest.mock('../../../services/dmService', () => ({
  canViewPod: jest.fn().mockResolvedValue(true),
}));

jest.mock('../../../services/agentIdentityService', () => ({
  buildAgentUsername: jest.fn((agentName, instanceId) => `${agentName}-${instanceId}`),
  resolveAgentDisplayLabel: jest.fn((user, fallback) => user.botMetadata?.displayName || user.username || fallback),
  default: {
    getAgentTypeConfig: jest.fn().mockReturnValue(null),
  },
}));

jest.mock('../../../routes/registry/presets', () => ({
  PRESET_DEFINITIONS: [],
  DEFAULT_BRANCH: 'main',
}));

const Pod = require('../../../models/Pod');
const AgentProfile = require('../../../models/AgentProfile');
const AgentTemplate = require('../../../models/AgentTemplate');
const AgentEvent = require('../../../models/AgentEvent');
const AgentRun = require('../../../models/AgentRun');
const User = require('../../../models/User');
const AgentCredential = require('../../../models/AgentCredential');
const Machine = require('../../../models/Machine');
const { AgentRegistry, AgentInstallation } = require('../../../models/AgentRegistry');
const registryRoutes = require('../../../routes/registry');

const app = express();
app.use(express.json());
app.use('/api/registry', registryRoutes);

// Valid 24-hex id: the route casts podId to ObjectId for the AgentRun $match
// (aggregation does not cast), and an invalid id would short-circuit the
// lookup through its defensive catch.
const POD_ID = 'aaaaaaaaaaaaaaaaaaaaaaaa';

const baseInstallation = (over = {}) => ({
  agentName: 'guide',
  instanceId: 'default',
  displayName: 'Guide',
  version: '1.0.0',
  status: 'active',
  scopes: [],
  createdAt: new Date('2026-08-01T00:00:00.000Z'),
  usage: {},
  installedBy: 'user-1',
  config: new Map(Object.entries({ runtime: { runtimeType: 'native' } })),
  ...over,
});

const stubLeanChains = () => {
  User.find.mockReturnValue({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([]) }) });
  AgentRegistry.find.mockReturnValue({
    select: jest.fn().mockReturnValue({
      lean: jest.fn().mockResolvedValue([]),
    }),
  });
  AgentProfile.find.mockReturnValue({
    lean: jest.fn().mockResolvedValue([]),
  });
  AgentTemplate.find.mockReturnValue({
    select: jest.fn().mockReturnValue({
      lean: jest.fn().mockResolvedValue([]),
    }),
  });
  Pod.findById.mockReturnValue({
    lean: jest.fn().mockResolvedValue({
      _id: POD_ID,
      createdBy: 'user-1',
      members: ['user-1'],
    }),
  });
  AgentCredential.find.mockReturnValue({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([]) }) });
  Machine.find.mockReturnValue({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([]) }) });
};

describe('pod agents lastActiveAt derivation (#915)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    stubLeanChains();
  });

  it('projects a revoked BYO credential to the roster even when the bearer was removed', async () => {
    AgentInstallation.getInstalledAgents.mockResolvedValue([baseInstallation({
      agentName: 'local', config: new Map([['runtime', { runtimeType: 'webhook' }]]),
    })]);
    User.find.mockReturnValue({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([{
      _id: 'bot-1', username: 'local-default', botMetadata: {}, agentRuntimeTokens: [],
    }]) }) });
    AgentCredential.find.mockReturnValue({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([{
      kind: 'runtime', agentUserId: 'bot-1', status: 'revoked',
    }]) }) });
    const res = await request(app).get(`/api/registry/pods/${POD_ID}/agents`);
    expect(res.status).toBe(200);
    expect(res.body.agents[0].connection).toEqual({ state: 'revoked', lastSeenAt: null });
  });

  it('projects a running legacy CLI seat after its runtime label is normalized', async () => {
    AgentInstallation.getInstalledAgents.mockResolvedValue([baseInstallation({
      agentName: 'local', config: new Map([['runtime', { runtimeType: 'local-cli', wrappedCli: 'codex' }]]),
    })]);
    User.find.mockReturnValue({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([{
      _id: 'bot-1', username: 'local-default', botMetadata: {}, agentRuntimeTokens: [],
    }]) }) });
    AgentCredential.find.mockReturnValue({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([{
      kind: 'runtime', agentUserId: 'bot-1', status: 'active', lastUsedAt: new Date(),
    }]) }) });
    const res = await request(app).get(`/api/registry/pods/${POD_ID}/agents`);
    expect(res.status).toBe(200);
    expect(res.body.agents[0].runtime).toEqual(expect.objectContaining({ runtimeType: 'codex', host: 'byo' }));
    expect(res.body.agents[0].connection.state).toBe('connected');
  });

  it('projects a revoked credential despite stale embedded copies on User and installation', async () => {
    AgentInstallation.getInstalledAgents.mockResolvedValue([baseInstallation({
      agentName: 'local', config: new Map([['runtime', { runtimeType: 'webhook' }]]),
      runtimeTokens: [{ tokenHash: 'dead-hash', lastUsedAt: new Date() }],
    })]);
    User.find.mockReturnValue({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([{
      _id: 'bot-1', username: 'local-default', botMetadata: {},
      agentRuntimeTokens: [{ tokenHash: 'dead-hash', lastUsedAt: new Date() }],
    }]) }) });
    AgentCredential.find.mockReturnValue({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([{
      kind: 'runtime', agentUserId: 'bot-1', tokenHash: 'dead-hash', status: 'revoked',
    }]) }) });
    const res = await request(app).get(`/api/registry/pods/${POD_ID}/agents`);
    expect(res.status).toBe(200);
    expect(res.body.agents[0].connection).toEqual({ state: 'revoked', lastSeenAt: null });
  });

  it('keeps a revoked wrapper key disconnected despite a live machine', async () => {
    AgentInstallation.getInstalledAgents.mockResolvedValue([baseInstallation({
      agentName: 'local', config: new Map([['runtime', { runtimeType: 'wrapper' }]]),
    })]);
    User.find.mockReturnValue({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([{
      _id: 'bot-1', username: 'local-default', botMetadata: { machineId: 'machine-1' }, agentRuntimeTokens: [],
    }]) }) });
    AgentCredential.find.mockReturnValue({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([
      { kind: 'runtime', agentUserId: 'bot-1', status: 'revoked' },
      { kind: 'daemon', machineId: 'machine-1', status: 'active' },
    ]) }) });
    Machine.find.mockReturnValue({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([{
      machineId: 'machine-1', lastSeenAt: new Date(),
    }]) }) });
    const res = await request(app).get(`/api/registry/pods/${POD_ID}/agents`);
    expect(res.status).toBe(200);
    expect(res.body.agents[0].connection.state).toBe('revoked');
  });

  it('projects a running daemon-bound wrapper from its live machine and active seat key', async () => {
    AgentInstallation.getInstalledAgents.mockResolvedValue([baseInstallation({
      agentName: 'local', config: new Map([['runtime', { runtimeType: 'wrapper' }]]),
    })]);
    User.find.mockReturnValue({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([{
      _id: 'bot-1', username: 'local-default', botMetadata: { machineId: 'machine-1' }, agentRuntimeTokens: [],
    }]) }) });
    AgentCredential.find.mockReturnValue({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([
      { kind: 'runtime', agentUserId: 'bot-1', status: 'active', lastUsedAt: new Date() },
      { kind: 'daemon', machineId: 'machine-1', status: 'active' },
    ]) }) });
    Machine.find.mockReturnValue({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([{
      machineId: 'machine-1', lastSeenAt: new Date(),
    }]) }) });
    const res = await request(app).get(`/api/registry/pods/${POD_ID}/agents`);
    expect(res.status).toBe(200);
    expect(res.body.agents[0].connection.state).toBe('connected');
    expect(res.body.agents[0].connection.lastSeenAt).toEqual(expect.any(String));
  });

  it('projects a daemon-bound seat as a wrapper even when its install label is not wrapper', async () => {
    AgentInstallation.getInstalledAgents.mockResolvedValue([baseInstallation({
      agentName: 'local', config: new Map([['runtime', { runtimeType: 'claude-code' }]]),
    })]);
    User.find.mockReturnValue({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([{
      _id: 'bot-1', username: 'local-default', botMetadata: { machineId: 'machine-1' }, agentRuntimeTokens: [],
    }]) }) });
    AgentCredential.find.mockReturnValue({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([
      { kind: 'runtime', agentUserId: 'bot-1', status: 'active', lastUsedAt: new Date() },
      { kind: 'daemon', machineId: 'machine-1', status: 'active' },
    ]) }) });
    Machine.find.mockReturnValue({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([{
      machineId: 'machine-1', lastSeenAt: new Date(),
    }]) }) });
    const res = await request(app).get(`/api/registry/pods/${POD_ID}/agents`);
    expect(res.status).toBe(200);
    expect(res.body.agents[0].connection.state).toBe('connected');
    expect(res.body.agents[0].connection.lastSeenAt).toEqual(expect.any(String));
    expect(res.body.agents[0].runtime.runtimeType).toBe('wrapper');
    expect(res.body.agents[0].runtime.adapter).toBe('claude-code');
  });

  it('reports a daemon-bound seat with no live signal as never connected, not missing', async () => {
    AgentInstallation.getInstalledAgents.mockResolvedValue([baseInstallation({
      agentName: 'local', config: new Map([['runtime', { runtimeType: 'claude-code' }]]),
    })]);
    User.find.mockReturnValue({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([{
      _id: 'bot-1', username: 'local-default', botMetadata: { machineId: 'machine-1' }, agentRuntimeTokens: [],
    }]) }) });
    AgentCredential.find.mockReturnValue({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([]) }) });
    Machine.find.mockReturnValue({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([]) }) });
    const res = await request(app).get(`/api/registry/pods/${POD_ID}/agents`);
    expect(res.status).toBe(200);
    expect(res.body.agents[0].connection).toEqual({ state: 'never', lastSeenAt: null });
  });

  it('surfaces AgentRun activity for native agents with no heartbeats and no tokens', async () => {
    AgentInstallation.getInstalledAgents.mockResolvedValue([baseInstallation()]);
    AgentRun.aggregate.mockResolvedValue([
      {
        _id: { agentName: 'guide', instanceId: 'default' },
        lastRunAt: new Date('2026-08-12T19:04:00.000Z'),
      },
    ]);

    const res = await request(app).get(`/api/registry/pods/${POD_ID}/agents`);

    expect(res.status).toBe(200);
    expect(res.body.agents).toHaveLength(1);
    expect(res.body.agents[0].lastHeartbeatAt).toBeNull();
    expect(res.body.agents[0].lastActiveAt).toBe('2026-08-12T19:04:00.000Z');
    expect(res.body.agents[0].connection).toEqual({ state: 'available', lastSeenAt: null });
  });

  it('shows a provisioned native-engine hosted seat as available without a runtime token', async () => {
    AgentInstallation.getInstalledAgents.mockResolvedValue([baseInstallation({
      config: new Map([
        ['runtime', { runtimeType: 'hosted' }],
        ['hosted', { engine: 'native', provisionedAt: new Date() }],
      ]),
    })]);
    const res = await request(app).get(`/api/registry/pods/${POD_ID}/agents`);
    expect(res.status).toBe(200);
    expect(res.body.agents[0].connection).toEqual({ state: 'available', lastSeenAt: null });
  });

  it('takes the max across heartbeat events and runtime-token use', async () => {
    AgentInstallation.getInstalledAgents.mockResolvedValue([
      baseInstallation({ agentName: 'my-byo', config: new Map() }),
    ]);
    AgentEvent.aggregate.mockResolvedValue([
      {
        _id: { agentName: 'my-byo', instanceId: 'default' },
        lastHeartbeatAt: new Date('2026-08-10T00:00:00.000Z'),
      },
    ]);
    User.find.mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue([
          {
            username: 'my-byo-default',
            agentRuntimeTokens: [
              { lastUsedAt: new Date('2026-08-12T19:30:00.000Z') },
              { lastUsedAt: new Date('2026-08-01T00:00:00.000Z') },
            ],
          },
        ]),
      }),
    });

    const res = await request(app).get(`/api/registry/pods/${POD_ID}/agents`);

    expect(res.status).toBe(200);
    // Heartbeat field stays what it always was; the new field takes the max.
    expect(res.body.agents[0].lastHeartbeatAt).toBe('2026-08-10T00:00:00.000Z');
    expect(res.body.agents[0].lastActiveAt).toBe('2026-08-12T19:30:00.000Z');
  });

  it('returns null lastActiveAt when no source has ever seen the agent', async () => {
    AgentInstallation.getInstalledAgents.mockResolvedValue([
      baseInstallation({ agentName: 'never-started', config: new Map() }),
    ]);

    const res = await request(app).get(`/api/registry/pods/${POD_ID}/agents`);

    expect(res.status).toBe(200);
    expect(res.body.agents[0].lastActiveAt).toBeNull();
    expect(res.body.agents[0].lastHeartbeatAt).toBeNull();
  });

  it('keeps the roster alive when the AgentRun lookup fails', async () => {
    AgentInstallation.getInstalledAgents.mockResolvedValue([baseInstallation()]);
    AgentRun.aggregate.mockRejectedValue(new Error('collection offline'));

    const res = await request(app).get(`/api/registry/pods/${POD_ID}/agents`);

    expect(res.status).toBe(200);
    expect(res.body.agents).toHaveLength(1);
    expect(res.body.agents[0].lastActiveAt).toBeNull();
  });
});
