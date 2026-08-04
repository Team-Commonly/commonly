/**
 * POST /api/agents/runtime/pods — the dedup-by-name branch was the sixth
 * writer to `Pod.members` and the only one that never consulted
 * DM_POD_TYPES_GUARD.
 *
 * VALID_POD_TYPES gates the type the CALLER ASKED FOR. The dedup lookup is
 * `Pod.findOne({ name })` — name alone, no type filter — so a name collision
 * turned a create call into a join against someone else's strictly-1:1 DM
 * (ADR-001 §3.10). The five writers that do consult the guard are
 * podController.joinPod, podInvites ×2, registry/admin, and
 * ensureAgentInPod; scripts/migrate-agent-dm-multimember.ts exists because
 * multi-member DMs already happened once.
 *
 * The membership count is the least of it, so these tests assert all three
 * writes are refused, not just the push:
 *   1. members.push            → a third party in a 1:1 pod
 *   2. AgentInstallation.install → POSTING rights (auth goes through
 *      AgentInstallation.find, not pod.members — see CLAUDE.md)
 *   3. ensureCommonlyBotInstalled → the summarizer with context:read on a
 *      private conversation
 */

jest.mock('jsonwebtoken', () => ({ sign: jest.fn(), verify: jest.fn(), decode: jest.fn() }));

jest.mock('../../../middleware/agentRuntimeAuth', () => (req, res, next) => {
  req.agentUser = { _id: 'bot-1' };
  req.agentInstallation = {
    agentName: 'openclaw', instanceId: 'nova', version: '1.0.0', config: {}, scopes: [],
  };
  next();
});
jest.mock('../../../middleware/auth', () => (req, res, next) => next());
jest.mock('../../../middleware/apiTokenScopes', () => ({
  requireApiTokenScopes: () => (req, res, next) => next(),
}));

const podSave = jest.fn().mockResolvedValue(undefined);
const podPopulate = jest.fn().mockResolvedValue(undefined);
const mockFoundPod = { value: null };

jest.mock('../../../models/Pod', () => {
  const findOne = jest.fn(() => ({
    populate: () => ({ populate: async () => mockFoundPod.value }),
  }));
  return { findOne, find: jest.fn() };
});

const mockInstall = jest.fn().mockResolvedValue({});
jest.mock('../../../models/AgentRegistry', () => ({
  AgentInstallation: { findOne: jest.fn().mockResolvedValue(null), find: jest.fn(), install: mockInstall },
}));

jest.mock('../../../services/agentIdentityService', () => ({
  DM_POD_TYPES_GUARD: new Set(['agent-room', 'agent-dm']),
  buildAgentUsername: jest.fn((a) => a),
  ensureAgentInPod: jest.fn(),
}));

jest.mock('../../../services/agentEventService', () => ({}));
jest.mock('../../../services/agentMessageService', () => ({}));
jest.mock('../../../services/agentThreadService', () => ({}));
jest.mock('../../../services/podContextService', () => ({}));
jest.mock('../../../services/globalModelConfigService', () => ({}));
jest.mock('../../../services/socialPolicyService', () => ({}));
jest.mock('../../../services/dmService', () => ({ getOrCreateAgentDM: jest.fn() }));
jest.mock('../../../services/chatSummarizerService', () => ({
  getMultiplePodSummaries: jest.fn().mockResolvedValue({}),
}));
jest.mock('../../../integrations', () => ({ get: jest.fn() }));
jest.mock('../../../models/Activity', () => ({}));
jest.mock('../../../models/User', () => ({ find: jest.fn(), findById: jest.fn() }));
jest.mock('../../../models/Post', () => ({ findById: jest.fn() }));
jest.mock('../../../models/Integration', () => ({ find: jest.fn(), findOne: jest.fn() }));

const express = require('express');
const request = require('supertest');
const router = require('../../../routes/agentsRuntime');

const app = express();
app.use(express.json());
app.use('/api/agents/runtime', router);

const existing = (type) => ({
  _id: `pod-${type}`,
  name: 'Nova and Theo',
  type,
  // The colliding pod's two members; the caller (bot-1) is NOT one of them.
  members: [{ _id: 'human-9' }, { _id: 'bot-7' }],
  save: podSave,
  populate: podPopulate,
});

const createPod = () => request(app)
  .post('/api/agents/runtime/pods')
  .send({ name: 'Nova and Theo', type: 'chat' });

describe('POST /pods dedup refuses to widen a 1:1 DM (ADR-001 §3.10)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFoundPod.value = null;
  });

  describe.each(['agent-room', 'agent-dm'])('name collides with an existing %s', (type) => {
    beforeEach(() => { mockFoundPod.value = existing(type); });

    test('refuses with 403 dm_membership_refused', async () => {
      const res = await createPod();
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('dm_membership_refused');
    });

    test('does not add the caller as a third member', async () => {
      await createPod();
      expect(podSave).not.toHaveBeenCalled();
      expect(mockFoundPod.value.members).toHaveLength(2);
    });

    // The write that actually grants access: posting is gated on
    // AgentInstallation, not pod.members, so fixing only the push would
    // still hand a stranger write rights on the DM.
    test('does not install the caller — the write that grants posting', async () => {
      await createPod();
      expect(mockInstall).not.toHaveBeenCalled();
    });

    // And commonly-bot would arrive with context:read on a private 1:1.
    test('does not install commonly-bot into the DM', async () => {
      await createPod();
      const installedAgents = mockInstall.mock.calls.map(([agentName]) => agentName);
      expect(installedAgents).not.toContain('commonly-bot');
    });
  });

  // agent-admin is deliberately NOT in the guard set — admin pods are N:1
  // (multiple admins ↔ one agent), per CLAUDE.md. Asserted so a future
  // "tidy up the set" edit has to argue with a test.
  test('agent-admin is NOT refused — admin pods are N:1 by design', async () => {
    mockFoundPod.value = existing('agent-admin');
    const res = await createPod();
    expect(res.status).not.toBe(403);
  });

  test('an ordinary chat pod still dedups and joins as before', async () => {
    mockFoundPod.value = existing('chat');
    const res = await createPod();
    expect(res.status).toBe(200);
    expect(podSave).toHaveBeenCalled();
    expect(mockFoundPod.value.members).toContain('bot-1');
  });
});
