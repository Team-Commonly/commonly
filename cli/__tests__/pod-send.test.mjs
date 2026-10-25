import { jest } from '@jest/globals';
import { Command } from 'commander';

const post = jest.fn();
await jest.unstable_mockModule('../src/lib/api.js', () => ({ createClient: () => ({ post }) }));
await jest.unstable_mockModule('../src/lib/config.js', () => ({
  getToken: () => 'own-runtime-fixture', resolveInstanceUrl: () => 'https://api.example.org',
}));
const { registerPod } = await import('../src/commands/pod.js');
const run = async (...args) => {
  const program = new Command();
  registerPod(program);
  await program.parseAsync(['node', 'commonly', 'pod', 'send', 'pod-1', 'text fallback', ...args]);
};
beforeEach(() => {
  post.mockReset().mockResolvedValue({ id: 'm1' });
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(process, 'exit').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

test('sends UI JSON on the real pod command with the content fallback', async () => {
  const payload = { catalogId: 'commonly.ui', catalogRev: 1, catalogHash: 'sha256:bb8b4de07f90c06ee48f254d86478b5bd347c738b3e86cf65e2f32e26534db57', kind: 'ui', v: 1, lang: 'openui@1', source: 'root = Text("hi")' };
  await run('--payload', JSON.stringify(payload));
  expect(post).toHaveBeenCalledTimes(1);
  expect(post).toHaveBeenCalledWith('/api/agents/runtime/pods/pod-1/messages', {
    content: 'text fallback', messageType: 'card', payload,
  });
});
test.each([400, 401, 403, 409, 500])('never retries a card refusal (%s) through the human writer', async (status) => {
  post.mockRejectedValueOnce(Object.assign(new Error('refused'), { status }));
  await run('--payload', '{"kind":"approval"}');
  expect(post).toHaveBeenCalledTimes(1);
  expect(process.exit).toHaveBeenCalledWith(1);
});
test('malformed JSON sends no requests', async () => {
  await run('--payload', '{broken');
  expect(post).not.toHaveBeenCalled();
  expect(process.exit).toHaveBeenCalledWith(1);
});
test('ordinary text retains the existing login fallback', async () => {
  post.mockRejectedValueOnce(new Error('agent auth required'));
  await run();
  expect(post).toHaveBeenCalledTimes(2);
  expect(post).toHaveBeenLastCalledWith('/api/messages/pod-1', { content: 'text fallback' });
});
