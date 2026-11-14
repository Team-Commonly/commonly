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

  // F167: init's install carries the narrowing confirmation only on the flag.
  test('--confirm-narrowing reaches the install, and is absent by default', async () => {
    const plain = makeClient();
    await performInit({ client: plain, language: 'python', agentName: 'plain-bot', podId: 'pod-1', targetDir: tmp });
    expect(plain.post.mock.calls.find(([route]) => route === '/api/registry/install')[1])
      .not.toHaveProperty('confirmNarrowing');

    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-init-narrowing-'));
    try {
      const confirmed = makeClient();
      await performInit({
        client: confirmed, language: 'python', agentName: 'ok-bot', podId: 'pod-1', targetDir: other,
        confirmNarrowing: true,
      });
      expect(confirmed.post).toHaveBeenCalledWith('/api/registry/install', expect.objectContaining({
        confirmNarrowing: true,
      }));
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  // F167 (CodeRabbit on #4101): the refusal says to re-run with the flag, so a
  // refused install must not leave files that make that re-run refuse to overwrite.
  test('a narrowing refusal leaves the directory so the advised re-run installs', async () => {
    const client = makeClient();
    const post = client.post.getMockImplementation();
    client.post.mockImplementationOnce(async () => {
      throw Object.assign(new Error('x'), {
        status: 409,
        body: {
          code: 'outsider_grant_narrowing_confirm_required',
          message: 'It would stop writing in Ops. Send confirmNarrowing: true to install anyway.',
        },
      });
    });
    await expect(performInit({
      client, language: 'python', agentName: 'retry-bot', podId: 'pod-1', targetDir: tmp,
    })).rejects.toThrow('Re-run with --confirm-narrowing to install anyway.');
    expect(fs.readdirSync(tmp)).toEqual([]);

    client.post.mockImplementation(post);
    await performInit({
      client, language: 'python', agentName: 'retry-bot', podId: 'pod-1', targetDir: tmp, confirmNarrowing: true,
    });
    expect(client.post).toHaveBeenLastCalledWith('/api/registry/install', expect.objectContaining({ confirmNarrowing: true }));
    expect(fs.existsSync(path.join(tmp, 'retry-bot.py'))).toBe(true);
  });

  test('a failed install never removes a file it did not write', async () => {
    fs.writeFileSync(path.join(tmp, 'notes.txt'), 'mine', 'utf8');
    const client = makeClient();
    client.post.mockImplementationOnce(async () => { throw new Error('Pod not found'); });
    await expect(performInit({
      client, language: 'python', agentName: 'gone-bot', podId: 'pod-1', targetDir: tmp,
    })).rejects.toThrow('Pod not found');
    expect(fs.readdirSync(tmp)).toEqual(['notes.txt']);
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
