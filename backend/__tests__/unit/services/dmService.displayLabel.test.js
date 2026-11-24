const mockUser = { value: null };
jest.mock('../../../models/User', () => ({
  findById: () => ({ select: () => ({ lean: async () => mockUser.value }) }),
}));
jest.mock('../../../models/Pod', () => {
  const Pod = jest.fn(function Pod(data) {
    Object.assign(this, data, { _id: 'room-1', save: async () => {} });
  });
  Pod.findOne = jest.fn().mockResolvedValue(null);
  Pod.find = () => ({ sort: () => ({ limit: async () => [] }) });
  return Pod;
});
jest.mock('../../../models/pg/Pod', () => null);
jest.mock('../../../models/AgentRegistry', () => ({
  AgentInstallation: { findOne: () => ({ sort: () => ({ lean: async () => null }) }), exists: async () => null, install: jest.fn() },
}));
const DMService = require('../../../services/dmService');
const { AgentInstallation } = require('../../../models/AgentRegistry');

// codex, like openclaw, is a shared-runtime agentName whose name can leak into
// a label. openclaw itself is retired (ADR-021 Part B), so its rooms get no
// installation row; the case below pins that its room still gets the clean name.
test.each([
  ['codex (nova)', 'nova'], ['Codex (NOVA)', 'nova'], ['codex', 'nova'],
  ['Nova, the reviewer', 'Nova, the reviewer'],
])('room and installation names resolve %s as %s', async (displayName, expected) => {
  mockUser.value = { username: 'codex-nova', botMetadata: { agentName: 'codex', instanceId: 'nova', displayName } };
  const room = await DMService.getOrCreateAgentRoom('agent-1', 'person-1', { agentName: 'codex', instanceId: 'nova' });
  expect(room.name).toBe(expected);
  expect(AgentInstallation.install).toHaveBeenLastCalledWith('codex', 'room-1', expect.objectContaining({ displayName: expected }));
});

test('a retired openclaw agent\'s room gets the clean name and no installation row', async () => {
  AgentInstallation.install.mockClear();
  mockUser.value = { username: 'openclaw-nova', botMetadata: { agentName: 'openclaw', instanceId: 'nova', displayName: 'openclaw (nova)' } };
  const room = await DMService.getOrCreateAgentRoom('agent-1', 'person-1', { agentName: 'openclaw', instanceId: 'nova' });
  expect(room.name).toBe('nova');
  expect(AgentInstallation.install).not.toHaveBeenCalled();
});

test('the agent-admin DM creation path uses the same runtime-leak guard', async () => {
  mockUser.value = { username: 'openclaw-nova', botMetadata: { agentName: 'openclaw', instanceId: 'nova', displayName: 'openclaw (nova)' } };
  const room = await DMService.getOrCreateAgentDM('agent-1', 'person-1', { agentName: 'openclaw', instanceId: 'nova' });
  expect(room.name).toBe('DM: nova');
  expect(room.description).toBe('Debug channel for nova');
});
test('a curated default-instance label is preserved in a new room', async () => {
  mockUser.value = { username: 'pixel-default', botMetadata: { agentName: 'pixel', instanceId: 'default', displayName: 'Pixel' } };
  const room = await DMService.getOrCreateAgentRoom('agent-1', 'person-1', { agentName: 'pixel', instanceId: 'default' });
  expect(room.name).toBe('Pixel');
});
