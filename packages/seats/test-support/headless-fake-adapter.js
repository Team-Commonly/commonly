/**
 * test-support/fake-cli.mjs driven through src/adapters/headless.js, so the
 * shared one-turn runner is proven against the full compat suite with a real
 * child process before any third-party CLI leans on it. Also an adapter for
 * a CLI that cannot reach the provider, built the way gemini, cursor and amp
 * are, with fake-cli as its pinned binary.
 */
import { FAKE_CLI_PATH } from './fake-cli-adapter.js';
import { createHeadlessAdapter, createProviderUnsupportedAdapter } from '../src/adapters/headless.js';

const versionArgs = [FAKE_CLI_PATH, '--version'];

export const readFakeCliLine = (line, state) => {
  const event = JSON.parse(line);
  if (event.type === 'message' && event.text) state.chunks.push(event.text);
  if (event.type !== 'result') return;
  if (event.ok) {
    state.text = event.text;
    state.sessionId = event.session_id;
  } else {
    state.error = `${event.status}: ${event.error}`;
  }
};

export const createHeadlessFakeAdapter = createHeadlessAdapter({
  name: 'headless-fake',
  cli: 'fake-cli',
  command: process.execPath,
  versionArgs,
  versionPattern: /fake-cli (\S+)/,
  async launch(prompt, ctx, { provider, env }) {
    return {
      args: [FAKE_CLI_PATH, 'run', ...(ctx.sessionId ? ['--resume', ctx.sessionId] : [])],
      stdin: prompt,
      env: { ...env, FAKE_CLI_BASE_URL: provider.baseURL, FAKE_CLI_MODEL: provider.model, FAKE_CLI_API_KEY: provider.apiKey },
    };
  },
  read: readFakeCliLine,
});

export const createUnsupportedFakeAdapter = createProviderUnsupportedAdapter({
  name: 'unsupported-fake',
  cli: 'fake-cli',
  command: process.execPath,
  versionArgs,
  versionPattern: /fake-cli (\S+)/,
  detail: 'this CLI only talks to its vendor\'s own service',
});
