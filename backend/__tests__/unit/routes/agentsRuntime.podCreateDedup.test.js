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

// Default seeding is the DM case: two members, and the caller (bot-1) is NOT
// one of them — that is the shape the guard has to refuse.
const existing = (type, members = [{ _id: 'human-9' }, { _id: 'bot-7' }], flags = {}) => ({
  _id: `pod-${type}`,
  name: 'Nova and Theo',
  type,
  members,
  // Absent by default — an unlisted, non-public pod is the common case and
  // the one a non-member must not be able to join by guessing its name.
  ...flags,
  save: podSave,
  populate: podPopulate,
});

const asMember = [{ _id: 'human-9' }, { _id: 'bot-1' }];
const LISTED_OPEN = { publicRead: true, communityListed: true, joinPolicy: 'open' };

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

    test('refuses with 403 pod_name_unavailable', async () => {
      const res = await createPod();
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('pod_name_unavailable');
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
  // agent-admin is deliberately NOT in the DM guard set. Seeded with the
  // caller already a member, because agent-admin is in NON_LISTABLE_POD_TYPES
  // and so is never directly joinable — a non-member is refused by the
  // joinability gate below, which is correct but would test the wrong thing
  // here. What this pins is only that the DM guard does not claim it.
  test('agent-admin is NOT refused as a DM — admin pods are N:1 by design', async () => {
    mockFoundPod.value = existing('agent-admin', asMember);
    const res = await createPod();
    expect(res.status).not.toBe(403);
  });

  // ------------------------------------------------------------------
  // A guessed name was a credential for joining any non-DM pod. The five
  // other writers to `members` all gate on joinability; this branch gated on
  // nothing. `POST /pods/:podId/self-install` — the dedicated agent-join
  // path — refuses invite-only, refuses non-members, and requires an active
  // installation; the dedup branch enforced none of the three.
  // ------------------------------------------------------------------
  describe('a non-member cannot join a non-joinable pod by guessing its name', () => {
    const cases = [
      ['invite-only, otherwise listed', { ...LISTED_OPEN, joinPolicy: 'invite-only' }],
      ['unlisted and non-public', {}],
      ['public but not community-listed', { publicRead: true, communityListed: false }],
      // ADR-016:46 — `joinPolicy: 'open'` below the community tier is a
      // DORMANT declaration: it means "open once listed", not "open now".
      // This is the case a joinPolicy-only gate lets through, which is why
      // the check is isDirectlyJoinable and not `joinPolicy !== 'invite-only'`.
      ['dormant open — joinPolicy open but never listed', { publicRead: false, communityListed: false, joinPolicy: 'open' }],
    ];

    test.each(cases)('refuses %s', async (_label, flags) => {
      mockFoundPod.value = existing('chat', undefined, flags);
      const res = await createPod();
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('pod_name_unavailable');
    });

    test.each(cases)('performs none of the three writes for %s', async (_label, flags) => {
      mockFoundPod.value = existing('chat', undefined, flags);
      await createPod();
      expect(podSave).not.toHaveBeenCalled();
      expect(mockFoundPod.value.members).toHaveLength(2);
      expect(mockInstall).not.toHaveBeenCalled();
    });
  });

  test('a directly joinable pod still joins — the gate is not a blanket refusal', async () => {
    mockFoundPod.value = existing('chat', undefined, LISTED_OPEN);
    const res = await createPod();
    expect(res.status).toBe(200);
    expect(podSave).toHaveBeenCalled();
    expect(mockFoundPod.value.members).toContain('bot-1');
  });

  // Pod names are guessable by construction — resolveAgentDisplayLabel emits
  // "Nova and Theo" — so a refusal that names its reason is an existence
  // oracle for other people's private pods. Both refusals must be byte-identical.
  test('the DM refusal and the non-joinable refusal are indistinguishable', async () => {
    mockFoundPod.value = existing('agent-dm');
    const dm = await createPod();
    jest.clearAllMocks();
    mockFoundPod.value = existing('chat', undefined, {});
    const other = await createPod();

    expect(dm.status).toBe(other.status);
    expect(dm.body).toEqual(other.body);
    // The remedy (`commonly_open_dm`) is offered in both, so it discloses
    // nothing. What must never appear is anything about the pod that was
    // FOUND — its type or its id — since that is what the caller is fishing
    // for and did not already know.
    const body = JSON.stringify(dm.body);
    expect(body).not.toMatch(/agent-dm|agent-room|pod-agent-dm/);
  });

  // The caller is seeded as ALREADY a member here, deliberately. What this
  // test guards is the dedup path itself — a name collision on an ordinary pod
  // returns the existing pod rather than erroring or creating a duplicate.
  //
  // Seeding a non-member instead would make the assertion defend the widening:
  // "a caller who guesses a chat pod's name is pushed into its members" would
  // become a pinned behaviour under the name "as before", and the follow-up
  // gate (refuse unless the pod is directly joinable — isDirectlyJoinable, not
  // joinPolicy alone, since publicRead:false + joinPolicy:'open' is a dormant
  // declaration per ADR-016:46) would have to delete a green test to land.
  // That gate is a separate PR; this file must not pre-approve its absence.
  test('an ordinary chat pod still dedups and returns the existing pod', async () => {
    mockFoundPod.value = existing('chat', [{ _id: 'human-9' }, { _id: 'bot-1' }]);
    const res = await createPod();
    expect(res.status).toBe(200);
    expect(res.body._id).toBe('pod-chat');
    // Already a member → no membership write at all. Dedup is idempotent.
    expect(podSave).not.toHaveBeenCalled();
    // ...but the branch does run to completion: the install still happens,
    // so this is a real pass through the dedup path, not an early return.
    expect(mockInstall).toHaveBeenCalled();
  });
});
