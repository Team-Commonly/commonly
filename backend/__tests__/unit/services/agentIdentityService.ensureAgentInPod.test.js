// ADR-001 §3.10 enforcement: ensureAgentInPod must NOT auto-add a third
// member to an agent-room (1:1 DM). Existing 2-member agent-rooms still
// work (the agent is already a member; the guard short-circuits before
// the cap check). Other pod types are unaffected.

// agentIdentityService.ts uses try/require for PG models so unit tests that
// don't stub them still work — only Pod + User need explicit mocks here.
jest.mock('../../../models/Pod', () => ({ findById: jest.fn() }));
jest.mock('../../../models/User', () => ({ findOne: jest.fn(), findById: jest.fn() }));

const Pod = require('../../../models/Pod');
const AgentIdentityService = require('../../../services/agentIdentityService');

describe('AgentIdentityService.ensureAgentInPod — agent-room 1:1 invariant', () => {
  beforeEach(() => jest.clearAllMocks());

  it('refuses to add a third agent to an existing agent-room', async () => {
    const pod = {
      _id: 'p-room',
      type: 'agent-room',
      members: ['agent-host-id', 'human-id'],
      save: jest.fn(),
    };
    Pod.findById.mockResolvedValue(pod);

    const newAgent = { _id: 'agent-intruder-id' };
    const result = await AgentIdentityService.ensureAgentInPod(newAgent, 'p-room');

    expect(result).toBeNull();
    expect(pod.save).not.toHaveBeenCalled();
    expect(pod.members).toEqual(['agent-host-id', 'human-id']);
  });

  it('still adds the agent on a regular chat pod (no regression)', async () => {
    const pod = {
      _id: 'p-chat',
      type: 'chat',
      members: ['user-a', 'user-b'],
      save: jest.fn().mockResolvedValue(undefined),
    };
    Pod.findById.mockResolvedValue(pod);

    const newAgent = { _id: 'agent-1' };
    const result = await AgentIdentityService.ensureAgentInPod(newAgent, 'p-chat');

    expect(result).toBe(pod);
    expect(pod.save).toHaveBeenCalled();
    expect(pod.members).toContain('agent-1');
  });

  it('refuses to add a third agent to an existing agent-dm (same 1:1 invariant)', async () => {
    // ADR-001 §3.10 — agent-dm is the type for any 1:1 DM (agent↔agent or
    // human↔agent). Same rule as agent-room: a third party always spawns
    // a NEW DM pod, never widens the existing one.
    const pod = {
      _id: 'p-dm',
      type: 'agent-dm',
      members: ['agent-pixel-id', 'agent-codex-id'],
      save: jest.fn(),
    };
    Pod.findById.mockResolvedValue(pod);

    const newAgent = { _id: 'agent-rogue-id' };
    const result = await AgentIdentityService.ensureAgentInPod(newAgent, 'p-dm');

    expect(result).toBeNull();
    expect(pod.save).not.toHaveBeenCalled();
    expect(pod.members).toEqual(['agent-pixel-id', 'agent-codex-id']);
  });

  it('does NOT block adds to agent-admin (admin pods can have multiple admins)', async () => {
    // agent-admin is N:1 (multiple admins ↔ one agent), not strictly 1:1.
    // The DM_POD_TYPES_GUARD intentionally excludes it. Adding admins on
    // top of an existing agent-admin pod is legitimate.
    const pod = {
      _id: 'p-admin',
      type: 'agent-admin',
      members: ['admin-a', 'agent-host'],
      save: jest.fn().mockResolvedValue(undefined),
    };
    Pod.findById.mockResolvedValue(pod);

    const secondAdmin = { _id: 'admin-b' };
    const result = await AgentIdentityService.ensureAgentInPod(secondAdmin, 'p-admin');

    expect(result).toBe(pod);
    expect(pod.save).toHaveBeenCalled();
    expect(pod.members).toContain('admin-b');
  });

  it('is a no-op when the agent is already a member of an agent-room (Mongoose ObjectId equality)', async () => {
    // Regression for the .includes()-vs-ObjectId bug: production stores
    // pod.members as ObjectId instances whose `===` always differs even
    // for equal ids. Members carry .equals(); the production code now
    // uses .some(.equals) instead of .includes(). This test exercises
    // that path with no manual override.
    const hostId = 'agent-host-id';
    const fakeObjectId = (val) => ({
      equals: (other) => String(other) === val,
      toString: () => val,
    });
    const pod = {
      _id: 'p-room',
      type: 'agent-room',
      members: [fakeObjectId(hostId), fakeObjectId('human-id')],
      save: jest.fn(),
    };
    Pod.findById.mockResolvedValue(pod);

    const hostAgent = { _id: hostId };
    const result = await AgentIdentityService.ensureAgentInPod(hostAgent, 'p-room');

    expect(result).toBe(pod);
    expect(pod.save).not.toHaveBeenCalled();
  });
});
