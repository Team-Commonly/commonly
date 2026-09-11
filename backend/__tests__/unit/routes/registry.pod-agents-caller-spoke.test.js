/**
 * #1648 — the Activity day-zero step "Say something to it" closes on the
 * caller's own act (ux-lead 67071, sprint-impl 67078): the account's own
 * message in a pod that has a seat, reply or not. The seat's install intro
 * sets its `lastMessage` before anyone spoke, so the roster carries a
 * pod-level `callerSpoke` read from the message store for the caller.
 */
const request = require('supertest');
const express = require('express');

jest.mock('../../../middleware/auth', () => (req, res, next) => {
  req.user = { id: 'user-1' };
  req.userId = 'user-1';
  next();
});
jest.mock('../../../middleware/adminAuth', () => (req, res, next) => next());
jest.mock('../../../models/Pod', () => ({ findById: jest.fn() }));
jest.mock('../../../models/AgentRegistry', () => ({
  AgentRegistry: { find: jest.fn() },
  AgentInstallation: { getInstalledAgents: jest.fn() },
}));
jest.mock('../../../models/AgentProfile', () => ({ find: jest.fn() }));
jest.mock('../../../models/AgentTemplate', () => ({ find: jest.fn() }));
jest.mock('../../../models/AgentEvent', () => ({ aggregate: jest.fn().mockResolvedValue([]) }));
jest.mock('../../../models/AgentRun', () => ({ aggregate: jest.fn().mockResolvedValue([]) }));
jest.mock('../../../models/User', () => ({
  find: jest.fn().mockReturnValue({
    select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([]) }),
  }),
}));
jest.mock('../../../services/dmService', () => ({ canViewPod: jest.fn().mockResolvedValue(true) }));
jest.mock('../../../services/agentIdentityService', () => ({
  buildAgentUsername: jest.fn((agentName, instanceId) => `${agentName}-${instanceId}`),
  default: { getAgentTypeConfig: jest.fn().mockReturnValue(null) },
}));
jest.mock('../../../routes/registry/presets', () => ({ PRESET_DEFINITIONS: [], DEFAULT_BRANCH: 'main' }));
jest.mock('../../../models/pg/Message', () => ({
  findLastMessagePerUserInPod: jest.fn().mockResolvedValue([]),
  hasMessageByUserInPod: jest.fn(),
}));

const Pod = require('../../../models/Pod');
const AgentProfile = require('../../../models/AgentProfile');
const AgentTemplate = require('../../../models/AgentTemplate');
const PgMessage = require('../../../models/pg/Message');
const { AgentRegistry, AgentInstallation } = require('../../../models/AgentRegistry');
const registryRoutes = require('../../../routes/registry');

const app = express();
app.use(express.json());
app.use('/api/registry', registryRoutes);

const POD_ID = 'aaaaaaaaaaaaaaaaaaaaaaaa';

const installation = () => ({
  agentName: 'scout',
  instanceId: 'default',
  displayName: 'Scout',
  version: '1.0.0',
  status: 'active',
  scopes: [],
  createdAt: new Date('2026-09-01T00:00:00.000Z'),
  usage: {},
  installedBy: 'user-1',
  config: new Map(Object.entries({ runtime: { runtimeType: 'native' } })),
});

beforeEach(() => {
  jest.clearAllMocks();
  AgentRegistry.find.mockReturnValue({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([]) }) });
  AgentProfile.find.mockReturnValue({ lean: jest.fn().mockResolvedValue([]) });
  AgentTemplate.find.mockReturnValue({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([]) }) });
  Pod.findById.mockReturnValue({ lean: jest.fn().mockResolvedValue({ _id: POD_ID, createdBy: 'user-1', members: ['user-1'] }) });
  AgentInstallation.getInstalledAgents.mockResolvedValue([installation()]);
});

describe('GET /pods/:podId/agents callerSpoke (#1648)', () => {
  it('reads the caller, in this pod, from the message store', async () => {
    PgMessage.hasMessageByUserInPod.mockResolvedValue(true);
    const res = await request(app).get(`/api/registry/pods/${POD_ID}/agents`);
    expect(res.status).toBe(200);
    expect(res.body.callerSpoke).toBe(true);
    expect(PgMessage.hasMessageByUserInPod).toHaveBeenCalledWith(POD_ID, 'user-1');
    expect(res.body.agents).toHaveLength(1);
  });

  it('is false while the account has said nothing, whatever the seat has posted', async () => {
    PgMessage.hasMessageByUserInPod.mockResolvedValue(false);
    PgMessage.findLastMessagePerUserInPod.mockResolvedValue([{ userId: 'bot-1', content: 'Hi, I am Scout.', createdAt: new Date() }]);
    const res = await request(app).get(`/api/registry/pods/${POD_ID}/agents`);
    expect(res.status).toBe(200);
    expect(res.body.callerSpoke).toBe(false);
  });

  it('keeps the roster alive and reads "not yet" when the message store fails', async () => {
    PgMessage.hasMessageByUserInPod.mockRejectedValue(new Error('pg down'));
    const res = await request(app).get(`/api/registry/pods/${POD_ID}/agents`);
    expect(res.status).toBe(200);
    expect(res.body.callerSpoke).toBe(false);
    expect(res.body.agents).toHaveLength(1);
  });
});
