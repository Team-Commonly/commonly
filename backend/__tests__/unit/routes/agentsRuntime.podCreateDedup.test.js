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

// Default seeding is the DM/private case: two members, the caller (bot-1) is
// NOT one of them, and no visibility flags — that is both the shape the DM
// guard must refuse and the shape the property gate must refuse. Tests that
// need a joinable pod say so explicitly, so forgetting to opt in fails closed.
const existing = (type, overrides = {}) => ({
  _id: `pod-${type}`,
  name: 'Nova and Theo',
  type,
  members: [{ _id: 'human-9' }, { _id: 'bot-7' }],
  save: podSave,
  populate: podPopulate,
  ...overrides,
});

// tier = community ∧ joinPolicy = 'open' — the only self-joinable shape
// (ADR-016 §Join). This is what the dedup branch is legitimately for.
const joinable = (type, overrides = {}) => existing(type, {
  publicRead: true,
  communityListed: true,
  joinPolicy: 'open',
  ...overrides,
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

  // agent-admin is deliberately NOT in DM_POD_TYPES_GUARD — admin pods are
  // N:1 (multiple admins <-> one agent), per CLAUDE.md, so the DM guard must
  // not claim it. It IS in NON_LISTABLE_POD_TYPES, so the property gate does.
  // Asserted on the CODE, not just the status, so a future "tidy up the set"
  // edit that moves it into the DM guard has to argue with a test.
  test('agent-admin is refused by the property gate, not the DM guard', async () => {
    mockFoundPod.value = existing('agent-admin');
    const res = await createPod();
    // Still refused — but by the PROPERTY gate, not the DM guard, and the
    // distinct code is the point. agent-admin is deliberately outside
    // DM_POD_TYPES_GUARD because it is N:1 by design; it is inside
    // NON_LISTABLE_POD_TYPES because N:1 does not mean anyone may be the N
    // (ADR-016:21, "terminally private like a DM for a different reason").
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('pod_not_directly_joinable');
    expect(res.body.code).not.toBe('dm_membership_refused');
  });

  // The caller is seeded as ALREADY a member here, deliberately. What this
  // test guards is the dedup path itself — a name collision on an ordinary pod
  // returns the existing pod rather than erroring or creating a duplicate.
  // Seeding a non-member instead would make the assertion defend the widening
  // that the property gate below now refuses.
  test('an ordinary chat pod still dedups and returns the existing pod', async () => {
    mockFoundPod.value = existing('chat', { members: [{ _id: 'human-9' }, { _id: 'bot-1' }] });
    const res = await createPod();
    expect(res.status).toBe(200);
    expect(res.body._id).toBe('pod-chat');
    // Already a member → no membership write at all. Dedup is idempotent.
    expect(podSave).not.toHaveBeenCalled();
    // ...but the branch does run to completion: the install still happens,
    // so this is a real pass through the dedup path, not an early return.
    expect(mockInstall).toHaveBeenCalled();
  });

  // The other legitimate case, and the one that proves the gate is a gate and
  // not a blanket refusal: a NON-member joining a pod they could have found in
  // Discover. tier = community AND joinPolicy = 'open' is the only shape that
  // passes, and it must keep passing or the dedup branch is dead code.
  test('a community-listed open pod still admits a non-member', async () => {
    mockFoundPod.value = joinable('chat');
    const res = await createPod();
    expect(res.status).toBe(200);
    expect(podSave).toHaveBeenCalled();
    expect(mockFoundPod.value.members).toContain('bot-1');
    expect(mockInstall).toHaveBeenCalled();
  });

  describe('a non-member cannot join by guessing the name (ADR-016 invariant 2)', () => {
    // The case a joinPolicy-only gate misses, and the reason this gate reads
    // the tier instead. ADR-016:46 — `joinPolicy:'open'` below community tier
    // is "a dormant declaration, not an incoherence: open once listed."
    test('private + joinPolicy:open — the dormant declaration is not permission', async () => {
      mockFoundPod.value = existing('chat', { publicRead: false, joinPolicy: 'open' });
      const res = await createPod();
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('pod_not_directly_joinable');
      expect(podSave).not.toHaveBeenCalled();
      expect(mockInstall).not.toHaveBeenCalled();
    });

    test('showcase tier (publicRead, not listed) is readable but not joinable', async () => {
      mockFoundPod.value = existing('chat', { publicRead: true, communityListed: false });
      const res = await createPod();
      expect(res.status).toBe(403);
      expect(mockInstall).not.toHaveBeenCalled();
    });

    test('community + invite-only is findable but not self-joinable', async () => {
      mockFoundPod.value = joinable('chat', { joinPolicy: 'invite-only' });
      const res = await createPod();
      expect(res.status).toBe(403);
      expect(mockInstall).not.toHaveBeenCalled();
    });

    // The write that actually grants access, asserted on the general case and
    // not only the DM one: refusing the push while still installing would
    // hand a stranger posting rights on a private pod.
    test('refusal covers commonly-bot too — no context:read on a private pod', async () => {
      mockFoundPod.value = existing('team');
      await createPod();
      const installed = mockInstall.mock.calls.map(([agentName]) => agentName);
      expect(installed).not.toContain('commonly-bot');
      expect(mockInstall).not.toHaveBeenCalled();
    });
  });
});
