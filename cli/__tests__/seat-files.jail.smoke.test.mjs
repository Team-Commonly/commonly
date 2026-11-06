/**
 * seat-files.jail.smoke.test.mjs — F219
 *
 * Under real sandbox-exec, with the profile each adapter's own spawn built:
 * what jailed code can do to the files an adapter keeps for one turn. Goose
 * and OpenCode are not installed here, so the jail holds a shell in place of
 * the harness; the profile is what is under test. The positive controls keep
 * the denials from passing vacuously.
 */

import { spawnSync } from 'child_process';
import { EventEmitter } from 'events';
import {
  chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';

import goose, { TESTED_GOOSE_VERSIONS } from '../src/lib/adapters/goose.js';
import opencode, { TESTED_OPENCODE_VERSIONS } from '../src/lib/adapters/opencode.js';
import { commonlyMcpServer } from '../src/lib/default-environment.js';

const macTest = process.platform === 'darwin' ? test : test.skip;

const PROBE = `
attempt() { name=$1; shift; if "$@" >/dev/null 2>&1; then echo "$name=ok"; else echo "$name=denied"; fi; }
attempt readToken cat "$TOKEN_FILE"
attempt appendToken sh -c 'echo x >> "$TOKEN_FILE"'
attempt moveTokenDir mv "$(dirname "$TOKEN_FILE")" "$(dirname "$TOKEN_FILE").moved"
attempt readConfig cat "$CONFIG_FILE"
attempt appendConfig sh -c 'echo x >> "$CONFIG_FILE"'
attempt plantBesideConfig sh -c 'echo x > "$CONFIG_FILE.planted"'
attempt writeState sh -c 'echo x > "$STATE_DIR/probe-state"'
`;

const inJail = (profile, { cwd, env }) => {
  const result = spawnSync('/usr/bin/sandbox-exec', ['-p', profile, '/bin/sh', '-c', PROBE], {
    cwd, env, encoding: 'utf8',
  });
  return Object.fromEntries(result.stdout.trim().split('\n').map((line) => line.split('=')));
};

const childWith = (stdout) => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  queueMicrotask(() => {
    child.stdout.emit('data', Buffer.from(stdout));
    child.emit('close', 0);
  });
  return child;
};

const filesUnder = (dir) => readdirSync(dir, { recursive: true })
  .map((name) => join(dir, name))
  .filter((path) => statSync(path).isFile());

const seat = () => {
  const root = mkdtempSync(join(tmpdir(), 'seat-files-'));
  const cwd = join(root, 'workspace');
  mkdirSync(cwd);
  const keyFile = join(root, 'provider-key');
  writeFileSync(keyFile, 'upstream-secret', { mode: 0o600 });
  return { root, cwd, keyFile };
};

const provider = (keyFile) => ({ id: 'local', baseURL: 'http://127.0.0.1:9/v1', keyFile });

const withPreparedMcp = async (root, fn) => {
  const home = join(root, 'mcp-home');
  const pkgDir = join(home, '0.3.13', 'node_modules', '@commonlyai', 'mcp');
  mkdirSync(join(pkgDir, 'src'), { recursive: true });
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({
    name: '@commonlyai/mcp', version: '0.3.13', bin: { 'commonly-mcp': 'src/index.js' },
  }));
  writeFileSync(join(pkgDir, 'src', 'index.js'), '');
  writeFileSync(join(home, 'current'), '0.3.13\n');
  // A held warm lock keeps prepareMcpSpawn from starting a real warm.
  writeFileSync(join(home, '.warm.lock'), 'warming\n');
  const prior = process.env.COMMONLY_MCP_HOME;
  process.env.COMMONLY_MCP_HOME = home;
  try {
    await fn();
  } finally {
    if (prior === undefined) delete process.env.COMMONLY_MCP_HOME;
    else process.env.COMMONLY_MCP_HOME = prior;
  }
};

describe('what jailed code can do to a turn\'s own files (F219)', () => {
  macTest('Goose: the credential is read-only, the recipe cannot be changed, and no proxy token is on disk', async () => {
    const { root, cwd, keyFile } = seat();
    let seen;
    let proxyToken;
    let onDisk = [];
    try {
      await withPreparedMcp(root, () => goose.spawn('hello', {
        agentName: 'jail-goose', cwd, runtimeToken: 'cm_agent_fake_token',
        instanceUrl: 'https://api.commonly.me', _version: TESTED_GOOSE_VERSIONS[0],
        _binaryPath: '/usr/bin/true',
        env: { PATH: process.env.PATH },
        environment: {
          model: 'test-model', mcp: [commonlyMcpServer()], provider: provider(keyFile),
          sandbox: { trust: 'public', mode: 'workspace' },
        },
        _spawnImpl: (_cmd, args, options) => {
          const recipePath = args[args.indexOf('--recipe') + 1];
          const recipe = JSON.parse(readFileSync(recipePath, 'utf8'));
          proxyToken = options.env.OPENAI_API_KEY;
          // Every folder this turn was given, read from the host side.
          onDisk = [options.env.HOME, dirname(dirname(recipePath))].flatMap(filesUnder)
            .map((path) => ({ path, text: readFileSync(path, 'utf8') }));
          seen = inJail(args[1], {
            cwd,
            env: {
              ...options.env,
              TOKEN_FILE: recipe.extensions[0].envs.COMMONLY_TOKEN_FILE,
              CONFIG_FILE: recipePath,
              STATE_DIR: options.env.HOME,
            },
          });
          return childWith(`${JSON.stringify({ type: 'complete' })}\n`);
        },
      }));
      expect(seen).toEqual({
        // The Commonly MCP child runs in this jail and has to read it.
        readToken: 'ok',
        appendToken: 'denied',
        moveTokenDir: 'denied',
        readConfig: 'ok',
        appendConfig: 'denied',
        plantBesideConfig: 'denied',
        writeState: 'ok',
      });
      expect(proxyToken).toBeTruthy();
      expect(onDisk.length).toBeGreaterThan(0);
      expect(onDisk.filter(({ text }) => text.includes(proxyToken)).map(({ path }) => path)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  macTest('OpenCode: the folder granted as mcpConfigDir is read-only', async () => {
    const { root, cwd, keyFile } = seat();
    const binary = join(root, 'opencode');
    writeFileSync(binary, `#!/bin/sh\necho ${TESTED_OPENCODE_VERSIONS[0]}\n`);
    chmodSync(binary, 0o755);
    let seen;
    try {
      await withPreparedMcp(root, () => opencode.spawn('hello', {
        agentName: 'jail-opencode', cwd, runtimeToken: 'cm_agent_fake_token',
        instanceUrl: 'https://api.commonly.me',
        _binaryPath: binary, _opencodeHomeRoot: join(root, 'opencode-state'),
        env: { PATH: process.env.PATH },
        environment: {
          model: 'test-model', mcp: [commonlyMcpServer()], provider: provider(keyFile),
          sandbox: { trust: 'public', mode: 'workspace' },
        },
        _spawnImpl: (_cmd, args, options) => {
          seen = inJail(args[1], {
            cwd,
            env: {
              ...options.env,
              TOKEN_FILE: options.env.COMMONLY_TOKEN_FILE,
              CONFIG_FILE: options.env.OPENCODE_CONFIG,
              STATE_DIR: options.env.XDG_STATE_HOME,
            },
          });
          return childWith(`${JSON.stringify({
            type: 'text', sessionID: 'ses_jail', part: { type: 'text', text: 'ok' },
          })}\n`);
        },
      }));
      expect(seen).toEqual({
        readToken: 'ok',
        appendToken: 'denied',
        moveTokenDir: 'denied',
        readConfig: 'ok',
        appendConfig: 'denied',
        plantBesideConfig: 'denied',
        writeState: 'ok',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
