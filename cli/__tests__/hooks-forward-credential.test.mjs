/**
 * hooks-forward-credential.test.mjs — TASK-083
 *
 * The hook command is the credential path that was wired to nothing.
 *
 * `resolveHookToken` (launcher FILE first, value variable second) was written,
 * documented and unit-tested while the command that actually runs — the one
 * `hooks-config` puts in Claude settings — read `process.env.COMMONLY_AGENT_TOKEN`
 * directly. So the migration was real in the library and absent in production,
 * and because a hook fails OPEN by design the failure has no error surface: on a
 * seat whose MCP declaration moved to the file, the token was absent, the
 * forwarder returned `hook_unavailable`, and the tool-policy hook silently
 * stopped deciding anything.
 *
 * That is why these tests drive the real command instead of the resolver: the
 * defect was in the wiring, so a test of the resolver alone would have stayed
 * green through it. The command is invoked through the same `registerAgent`
 * call the binary makes, with a stubbed fetch, and the assertion is on the
 * Authorization header the backend would see.
 */

import { Command } from 'commander';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { jest } from '@jest/globals';
import { registerAgent } from '../src/commands/agent.js';

const FILE_TOKEN = 'cm_agent_'.padEnd(73, 'F');
const ENV_TOKEN = 'cm_agent_'.padEnd(73, 'E');

const runHookForward = async ({ env }) => {
  const saved = { ...process.env };
  const savedTTY = process.stdin.isTTY;
  const requests = [];
  const originalFetch = globalThis.fetch;
  // The command skips reading stdin when it is a TTY, which is what the runner
  // would do when Claude invokes the hook with a payload on stdin. This test
  // supplies no payload, so the TTY branch is the one to take.
  process.stdin.isTTY = true;
  process.env.COMMONLY_API_URL = 'https://api.example.test';
  delete process.env.COMMONLY_AGENT_TOKEN;
  delete process.env.COMMONLY_TOKEN_FILE;
  Object.assign(process.env, env || {});
  globalThis.fetch = async (url, opts) => {
    requests.push({ url, headers: opts?.headers || {} });
    return { ok: true, status: 200, json: async () => ({}) };
  };
  try {
    const program = new Command();
    program.exitOverride();
    registerAgent(program);
    await program.parseAsync(
      ['agent', 'hooks-forward', 'kai-hook-test', '--pod', 'pod-abc', '--timeout', '500'],
      { from: 'user' },
    );
    return requests;
  } finally {
    globalThis.fetch = originalFetch;
    process.stdin.isTTY = savedTTY;
    for (const key of ['COMMONLY_API_URL', 'COMMONLY_AGENT_TOKEN', 'COMMONLY_TOKEN_FILE']) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
};

describe('the hook command resolves the credential the way its runtime carries it (TASK-083)', () => {
  test('a launcher file is enough: the header carries the file credential, with no value in the environment', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kai-hook-cred-'));
    const file = join(dir, 'token');
    writeFileSync(file, `${FILE_TOKEN}\n`, { mode: 0o600 });
    try {
      const requests = await runHookForward({ env: { COMMONLY_TOKEN_FILE: file } });
      expect(requests).toHaveLength(1);
      expect(requests[0].headers.Authorization).toBe(`Bearer ${FILE_TOKEN}`);
      expect(requests[0].url).toBe('https://api.example.test/api/agents/runtime/pods/pod-abc/hooks');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the file wins over a value in the same environment', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kai-hook-cred-'));
    const file = join(dir, 'token');
    writeFileSync(file, `${FILE_TOKEN}\n`, { mode: 0o600 });
    try {
      const requests = await runHookForward({
        env: { COMMONLY_TOKEN_FILE: file, COMMONLY_AGENT_TOKEN: ENV_TOKEN },
      });
      expect(requests[0].headers.Authorization).toBe(`Bearer ${FILE_TOKEN}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a seat whose declaration has not migrated still works from the value', async () => {
    const requests = await runHookForward({ env: { COMMONLY_AGENT_TOKEN: ENV_TOKEN } });
    expect(requests[0].headers.Authorization).toBe(`Bearer ${ENV_TOKEN}`);
  });

  test('no credential at all forwards nothing, which is the documented fail-open posture', async () => {
    const requests = await runHookForward({ env: {} });
    expect(requests).toEqual([]);
  });
});
