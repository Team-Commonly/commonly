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

  it('is a no-op when the agent is already a member of an agent-room', async () => {
    // The host agent re-running ensureAgentInPod for its own DM must not
    // be rejected — the guard only triggers when the agent isn't already in.
    const pod = {
      _id: 'p-room',
      type: 'agent-room',
      members: [
        { equals: (id) => id === 'agent-host-id', toString: () => 'agent-host-id' },
        { equals: (id) => id === 'human-id', toString: () => 'human-id' },
      ],
      save: jest.fn(),
    };
    // Mongoose Array.includes uses equals(); fake it.
    pod.members.includes = (id) => pod.members.some((m) => m.equals(id));
    Pod.findById.mockResolvedValue(pod);

    const hostAgent = { _id: 'agent-host-id' };
    const result = await AgentIdentityService.ensureAgentInPod(hostAgent, 'p-room');

    expect(result).toBe(pod);
    expect(pod.save).not.toHaveBeenCalled();
  });
});
