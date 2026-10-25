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
  AgentInstallation: { findOne: () => ({ sort: () => ({ lean: async () => null }) }), install: jest.fn() },
}));
const DMService = require('../../../services/dmService');
const { AgentInstallation } = require('../../../models/AgentRegistry');

test.each([
  ['openclaw (nova)', 'nova'], ['OpenClaw (NOVA)', 'nova'], ['openclaw', 'nova'],
  ['Nova, the reviewer', 'Nova, the reviewer'],
])('room and installation names resolve %s as %s', async (displayName, expected) => {
  mockUser.value = { username: 'openclaw-nova', botMetadata: { agentName: 'openclaw', instanceId: 'nova', displayName } };
  const room = await DMService.getOrCreateAgentRoom('agent-1', 'person-1', { agentName: 'openclaw', instanceId: 'nova' });
  expect(room.name).toBe(expected);
  expect(AgentInstallation.install).toHaveBeenLastCalledWith('openclaw', 'room-1', expect.objectContaining({ displayName: expected }));
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
