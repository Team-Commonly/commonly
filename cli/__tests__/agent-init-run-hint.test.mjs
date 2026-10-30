/**
 * agent-init-run-hint.test.mjs — the run hint `agent init` prints must work
 * when pasted, and the SDK's 401 exit must point at COMMONLY_TOKEN.
 *
 * The hint is executed through /bin/sh with a stub `python3` on PATH that
 * prints the COMMONLY_TOKEN it was started with. If the hint doubles the
 * KEY= prefix, the stub prints `COMMONLY_TOKEN=cm_agent_…` and this fails.
 */

import { jest } from '@jest/globals';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

import { performInit } from '../src/commands/agent.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SDK_FILE = path.join(REPO_ROOT, 'examples', 'sdk', 'python', 'commonly.py');

const TOKEN = 'cm_agent_walk_echo_test';

const makeClient = ({ instanceId = 'default' } = {}) => {
  const post = jest.fn(async (route, body) => {
    if (route === '/api/registry/install') {
      return {
        installation: { agentName: body.agentName, instanceId, podId: body.podId },
        runtimeToken: TOKEN,
      };
    }
    throw new Error(`unexpected POST ${route}`);
  });
  return { post, get: jest.fn() };
};

let tmp;
let binDir;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-init-hint-'));
  binDir = path.join(tmp, 'bin');
  fs.mkdirSync(binDir);
  // Stub interpreter: prints the token the process was started with, no newline.
  fs.writeFileSync(path.join(binDir, 'python3'), '#!/bin/sh\nprintf "%s" "$COMMONLY_TOKEN"\n', { mode: 0o755 });
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('agent init run hint', () => {
  // The hint runs through /bin/sh, which Windows does not have.
  const posixTest = process.platform === 'win32' ? test.skip : test;

  posixTest('the printed command starts the bot with the bare token in COMMONLY_TOKEN', async () => {
    const targetDir = path.join(tmp, 'agent');
    const result = await performInit({
      client: makeClient(),
      language: 'python',
      agentName: 'walk-echo-1026',
      podId: 'pod-1',
      targetDir,
    });

    const seen = execFileSync('/bin/sh', ['-c', result.runHint], {
      cwd: targetDir,
      env: { PATH: `${binDir}${path.delimiter}${process.env.PATH}` },
      encoding: 'utf8',
    });

    expect(seen).toBe(TOKEN);
    expect(seen).not.toContain('COMMONLY_TOKEN=');
  });

  test('the hint invokes the bot file that init wrote', async () => {
    const targetDir = path.join(tmp, 'agent');
    const result = await performInit({
      client: makeClient(),
      language: 'python',
      agentName: 'walk-echo-1026',
      podId: 'pod-1',
      targetDir,
    });

    expect(result.runHint).toBe('(set -a; . ./.commonly-env; exec python3 walk-echo-1026.py)');
    expect(fs.existsSync(path.join(targetDir, 'walk-echo-1026.py'))).toBe(true);
  });

  test('the mention handle is the instanceId when the install has one', async () => {
    const result = await performInit({
      client: makeClient({ instanceId: 'aria' }),
      language: 'python',
      agentName: 'walk-echo-1026',
      podId: 'pod-1',
      targetDir: path.join(tmp, 'agent'),
    });

    expect(result.mentionHandle).toBe('aria');
  });

  test('the mention handle falls back to the registry agentName when there is no instanceId', async () => {
    const result = await performInit({
      client: makeClient(),
      language: 'python',
      agentName: 'walk-echo-1026',
      podId: 'pod-1',
      targetDir: path.join(tmp, 'agent'),
    });

    expect(result.mentionHandle).toBe('walk-echo-1026');
  });
});

describe('SDK 401 exit message', () => {
  test('tells the user to check COMMONLY_TOKEN and does not call the token revoked', () => {
    const sdk = fs.readFileSync(SDK_FILE, 'utf8');

    expect(sdk).toContain('Check COMMONLY_TOKEN');
    expect(sdk).not.toContain('likely revoked');
  });
});
