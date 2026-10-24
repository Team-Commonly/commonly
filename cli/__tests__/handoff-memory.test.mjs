import { jest } from '@jest/globals';
import { copyHandoffMemory } from '../src/lib/handoff-memory.js';
const identities = { sourceAgentName: 'hosted', sourceInstanceId: 'source-1', targetAgentName: 'local' };
const envelope = (content, updatedAt = null) => ({ sections: { long_term: { content, updatedAt, visibility: 'private' } } });
const clientFor = (source, target) => ({ get: jest.fn().mockResolvedValueOnce(source).mockResolvedValueOnce(target), patch: jest.fn().mockResolvedValue({}) });

test('copies the selected hosted instance using the logged-in owner revision API', async () => {
  const client = clientFor(envelope('remember X'), envelope(''));
  await expect(copyHandoffMemory(client, identities)).resolves.toEqual({ copied: true });
  expect(client.get.mock.calls).toEqual([
    ['/api/agent-memory/hosted/source-1/editable'], ['/api/agent-memory/local/default/editable'],
  ]);
  expect(client.patch).toHaveBeenCalledWith('/api/agent-memory/local/default/editable/long_term', { content: 'remember X', expectedUpdatedAt: null });
});

test('retry with the same memory is idempotent', async () => {
  const client = clientFor(envelope('X'), envelope('X'));
  await expect(copyHandoffMemory(client, identities)).resolves.toMatchObject({ reason: 'already-copied' });
  expect(client.patch).not.toHaveBeenCalled();
});

test('never replaces different local memory', async () => {
  const client = clientFor(envelope('hosted X'), envelope('local Y'));
  await expect(copyHandoffMemory(client, identities)).rejects.toThrow(/different memory/);
  expect(client.patch).not.toHaveBeenCalled();
});

test('refuses unreadable or malformed source memory rather than claiming it was copied', async () => {
  const client = clientFor({}, envelope(''));
  await expect(copyHandoffMemory(client, identities)).rejects.toThrow(/missing/);
  expect(client.patch).not.toHaveBeenCalled();
  client.get.mockReset().mockRejectedValue(new Error('Forbidden'));
  await expect(copyHandoffMemory(client, identities)).rejects.toThrow('Forbidden');
});

test('propagates concurrent-write refusal and preserves the selected revision', async () => {
  const client = clientFor(envelope('X'), envelope('', '2026-10-24T00:00:00.000Z'));
  client.patch.mockRejectedValue(new Error('Memory changed'));
  await expect(copyHandoffMemory(client, identities)).rejects.toThrow('Memory changed');
  expect(client.patch.mock.calls[0][1].expectedUpdatedAt).toBe('2026-10-24T00:00:00.000Z');
});


test('never copies private memory into a shared target section', async () => {
  const client = clientFor(envelope('private X'), { sections: { long_term: { content: '', visibility: 'shared' } } });
  await expect(copyHandoffMemory(client, identities)).rejects.toThrow(/must be private/);
  expect(client.patch).not.toHaveBeenCalled();
});
