/**
 * agent-init.test.mjs — ADR-006 Phase 1 scaffolder.
 *
 * Drives `performInit` with a mocked CAP client and a temp `targetDir`,
 * asserting:
 *  - SDK + bot.py are copied verbatim from examples/
 *  - .commonly-env is written 0600 with the runtime token
 *  - install POSTed with runtimeType:'webhook'
 *  - clobber-protection refuses to overwrite any of the three files
 *  - unknown languages are rejected
 */

import { jest } from '@jest/globals';
import os from 'os';
import path from 'path';
import fs from 'fs';

import { performInit } from '../src/commands/agent.js';

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const SDK_FILE = path.join(REPO_ROOT, 'examples', 'sdk', 'python', 'commonly.py');
const BOT_FILE = path.join(REPO_ROOT, 'examples', 'hello-world-python', 'bot.py');

const makeClient = ({ runtimeToken = 'cm_agent_init_test' } = {}) => {
  const post = jest.fn(async (route, body) => {
    if (route === '/api/registry/install') {
      return {
        installation: {
          agentName: body.agentName,
          instanceId: 'default',
          podId: body.podId,
        },
        runtimeToken,
      };
    }
    if (route.endsWith('/runtime-tokens')) {
      return { token: runtimeToken };
    }
    throw new Error(`unexpected POST ${route}`);
  });
  return { post, get: jest.fn() };
};

let tmp;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-init-test-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('performInit (python)', () => {
  test('copies SDK + template, mints token, writes .commonly-env', async () => {
    const client = makeClient({ runtimeToken: 'cm_agent_xyz' });
    const result = await performInit({
      client,
      language: 'python',
      agentName: 'research-bot',
      podId: 'pod-1',
      targetDir: tmp,
    });

    // Files written
    const sdkPath = path.join(tmp, 'commonly.py');
    const botPath = path.join(tmp, 'research-bot.py');
    const envPath = path.join(tmp, '.commonly-env');
    expect(fs.existsSync(sdkPath)).toBe(true);
    expect(fs.existsSync(botPath)).toBe(true);
    expect(fs.existsSync(envPath)).toBe(true);

    // SDK + bot are byte-for-byte copies of the canonical examples
    expect(fs.readFileSync(sdkPath, 'utf8')).toBe(fs.readFileSync(SDK_FILE, 'utf8'));
    expect(fs.readFileSync(botPath, 'utf8')).toBe(fs.readFileSync(BOT_FILE, 'utf8'));

    // Token file: KEY=VALUE format (sourceable + dotenv-friendly), mode 0600
    expect(fs.readFileSync(envPath, 'utf8')).toBe('COMMONLY_TOKEN=cm_agent_xyz\n');
    if (process.platform !== 'win32') {
      const mode = fs.statSync(envPath).mode & 0o777;
      expect(mode).toBe(0o600);
    }

    // Install was issued with runtimeType:'webhook' (drives self-serve path)
    expect(client.post).toHaveBeenCalledWith(
      '/api/registry/install',
      expect.objectContaining({
        agentName: 'research-bot',
        podId: 'pod-1',
        config: expect.objectContaining({
          runtime: expect.objectContaining({ runtimeType: 'webhook' }),
        }),
      }),
    );

    // Result object exposes the run hint for the CLI to print
    expect(result.runtimeToken).toBe('cm_agent_xyz');
    expect(result.runHint).toContain('python3 research-bot.py');
    expect(result.files.env).toBe(envPath);
  });

  test('falls back to /runtime-tokens when install omits runtimeToken', async () => {
    const client = {
      post: jest.fn(async (route, body) => {
        if (route === '/api/registry/install') {
          return { installation: { agentName: body.agentName, instanceId: 'default' } };
        }
        if (route.endsWith('/runtime-tokens')) {
          return { token: 'cm_agent_from_tokens_route' };
        }
        throw new Error(`unexpected POST ${route}`);
      }),
      get: jest.fn(),
    };
    const res = await performInit({
      client, language: 'python', agentName: 'fallback-bot',
      podId: 'pod-2', targetDir: tmp,
    });
    expect(res.runtimeToken).toBe('cm_agent_from_tokens_route');
    // force:true required for re-attach race fix; see attach.test.mjs.
    expect(client.post).toHaveBeenCalledWith(
      '/api/registry/pods/pod-2/agents/fallback-bot/runtime-tokens',
      { force: true },
    );
  });

  test('refuses to clobber an existing file in the target directory', async () => {
    fs.writeFileSync(path.join(tmp, 'commonly.py'), '# user file', 'utf8');

    const client = makeClient();
    await expect(performInit({
      client, language: 'python', agentName: 'collide',
      podId: 'pod-1', targetDir: tmp,
    })).rejects.toThrow(/Refusing to overwrite/);
    // No install was issued — bail-before-write semantics.
    expect(client.post).not.toHaveBeenCalled();
    // The pre-existing user file is untouched.
    expect(fs.readFileSync(path.join(tmp, 'commonly.py'), 'utf8')).toBe('# user file');
  });

  test('rejects unknown languages without writing anything', async () => {
    const client = makeClient();
    await expect(performInit({
      client, language: 'rust', agentName: 'r',
      podId: 'pod-1', targetDir: tmp,
    })).rejects.toThrow(/Unsupported language "rust"/);
    expect(fs.readdirSync(tmp)).toEqual([]);
    expect(client.post).not.toHaveBeenCalled();
  });
});
