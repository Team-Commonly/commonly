/**
 * F460 on Goose. A public Goose seat's runtime credential file is deleted once
 * our Commonly extension has written its ready file (in the seat home, the one
 * folder the jail writes), or at the deadline. A delete that fails ends the
 * turn. A warm build from before ready files is refused on a public seat.
 */
import { EventEmitter } from 'node:events';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { jest } from '@jest/globals';
import goose, { TESTED_GOOSE_VERSIONS } from '../src/lib/adapters/goose.js';
import { commonlyMcpServer } from '../src/lib/default-environment.js';

const reply = [
  JSON.stringify({ type: 'message', message: {
    role: 'assistant', content: [{ type: 'text', text: 'Goose reply' }], metadata: { userVisible: true },
  } }),
  JSON.stringify({ type: 'complete', total_tokens: 3 }),
  '',
].join('\n');

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// A Goose whose Commonly extension writes its ready file (or not), then answers
// after `turnMs`. Records whether the credential existed at start and at end.
const fakeGoose = ({ writeReady = true, turnMs = 400 } = {}) => {
  const seen = {};
  const impl = (_cmd, args) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = jest.fn(() => { setTimeout(() => child.emit('close', null), 5); });
    const recipe = JSON.parse(readFileSync(args[args.indexOf('--recipe') + 1], 'utf8'));
    const envs = recipe.extensions.find((extension) => extension.name === 'commonly')?.envs || {};
    seen.tokenFile = envs.COMMONLY_TOKEN_FILE;
    seen.readyFile = envs.COMMONLY_MCP_READY_FILE;
    seen.atStart = Boolean(seen.tokenFile && existsSync(seen.tokenFile));
    setTimeout(async () => {
      if (writeReady && seen.readyFile) await writeFile(seen.readyFile, 'ready\n');
      await sleep(turnMs);
      seen.atEnd = Boolean(seen.tokenFile && existsSync(seen.tokenFile));
      if (child.kill.mock.calls.length) return;
      child.stdout.emit('data', Buffer.from(reply));
      child.emit('close', 0);
    }, 10);
    return child;
  };
  return { impl, seen };
};

const withSeat = async (fn, { readyFile = true } = {}) => {
  const root = mkdtempSync(join(tmpdir(), 'goose-f460-'));
  const cwd = join(root, 'workspace');
  mkdirSync(cwd);
  const keyFile = join(root, 'provider-key');
  writeFileSync(keyFile, 'upstream-secret', { mode: 0o600 });
  const home = join(root, 'mcp-home');
  const pkgDir = join(home, '0.3.20', 'node_modules', '@commonlyai', 'mcp');
  mkdirSync(join(pkgDir, 'src'), { recursive: true });
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({
    name: '@commonlyai/mcp', version: '0.3.20', bin: { 'commonly-mcp': 'src/index.js' },
    ...(readyFile ? { commonly: { readyFile: true } } : {}),
  }));
  writeFileSync(join(pkgDir, 'src', 'index.js'), '');
  writeFileSync(join(home, 'current'), '0.3.20\n');
  writeFileSync(join(home, '.warm.lock'), 'warming\n');
  const prior = process.env.COMMONLY_MCP_HOME;
  process.env.COMMONLY_MCP_HOME = home;
  const ctx = {
    agentName: 'goose-f460', cwd, runtimeToken: 'cm_agent_f460_runtime_token',
    instanceUrl: 'https://api.commonly.me', _version: TESTED_GOOSE_VERSIONS[0],
    env: { PATH: process.env.PATH },
    environment: {
      model: 'deepseek-v4-flash',
      mcp: [commonlyMcpServer()],
      provider: { id: 'local', baseURL: 'http://127.0.0.1:9/v1', keyFile },
      sandbox: { trust: 'public', mode: 'workspace' },
    },
    _binaryPath: '/usr/bin/true',
    _platform: 'darwin',
    _wrapArgvWithSeatbelt: (argv) => argv,
  };
  try {
    await fn(ctx);
  } finally {
    if (prior === undefined) delete process.env.COMMONLY_MCP_HOME;
    else process.env.COMMONLY_MCP_HOME = prior;
    rmSync(root, { recursive: true, force: true });
  }
};

test('the credential is gone once the Commonly extension has written its ready file', async () => {
  await withSeat(async (ctx) => {
    const fake = fakeGoose();
    const result = await goose.spawn('hello', { ...ctx, _spawnImpl: fake.impl });
    expect(result.text).toBe('Goose reply');
    expect(fake.seen.readyFile).toEqual(expect.stringContaining('mcp-ready'));
    expect(fake.seen.atStart).toBe(true);
    expect(fake.seen.atEnd).toBe(false);
  });
});

test('an extension that never gets ready: the credential still goes, at the deadline', async () => {
  await withSeat(async (ctx) => {
    const fake = fakeGoose({ writeReady: false, turnMs: 500 });
    const warn = jest.fn();
    await goose.spawn('hello', { ...ctx, _spawnImpl: fake.impl, _credentialRelease: { deadlineMs: 150, warn } });
    expect(fake.seen.atStart).toBe(true);
    expect(fake.seen.atEnd).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/public Goose seat: MCP servers not ready .*deleted anyway/));
  });
});

test('a delete that fails ends the turn and kills Goose', async () => {
  await withSeat(async (ctx) => {
    const fake = fakeGoose();
    await expect(goose.spawn('hello', {
      ...ctx,
      _spawnImpl: fake.impl,
      _credentialRelease: { fs: { rmSync: () => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); }, existsSync } },
    })).rejects.toThrow(/could not delete its runtime credential.*EPERM/);
  });
});

// A delete made to fail for real, as the walk of the published build did: the
// folder holding the credential is read-only, so the release cannot delete it
// and the adapter's own cleanup cannot remove that folder either. The turn ends
// with the release's error, not the cleanup's. Root ignores the mode, so skip.
const asRoot = process.getuid?.() === 0;
(asRoot ? test.skip : test)('a delete that fails for real ends the turn with the release error, not the cleanup one', async () => {
  await withSeat(async (ctx) => {
    let locked = null;
    const fake = fakeGoose({ turnMs: 600 });
    const impl = (...args) => {
      const child = fake.impl(...args);
      locked = dirname(dirname(fake.seen.tokenFile));
      chmodSync(locked, 0o500);
      return child;
    };
    try {
      await expect(goose.spawn('hello', { ...ctx, _spawnImpl: impl })).rejects.toThrow(/could not delete its runtime credential/);
    } finally {
      if (locked) { chmodSync(locked, 0o700); rmSync(locked, { recursive: true, force: true }); }
    }
  });
});

// CodeRabbit on #3997: a private seat arms no release, so the temp folder's
// removal is the one delete of its credential. A turn that worked but whose
// cleanup failed reports that failure instead of success.
(asRoot ? test.skip : test)('a private turn whose cleanup fails reports it rather than success', async () => {
  await withSeat(async (ctx) => {
    let locked = null;
    let answered = false;
    // A private Goose names the credential inside --with-extension, not a recipe.
    const impl = (_cmd, args) => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = jest.fn();
      const tokenFile = args.join(' ').match(/COMMONLY_TOKEN_FILE=(\S+)/)[1];
      locked = dirname(dirname(tokenFile));
      chmodSync(locked, 0o500);
      setTimeout(() => {
        answered = true;
        child.stdout.emit('data', Buffer.from(reply));
        child.emit('close', 0);
      }, 50);
      return child;
    };
    try {
      await expect(goose.spawn('hello', {
        ...ctx,
        environment: { ...ctx.environment, sandbox: undefined },
        _spawnImpl: impl,
      })).rejects.toMatchObject({ code: 'EACCES' });
      expect(answered).toBe(true);
    } finally {
      if (locked) { chmodSync(locked, 0o700); rmSync(locked, { recursive: true, force: true }); }
    }
  });
});

test('a warm build from before ready files is refused before Goose runs', async () => {
  await withSeat(async (ctx) => {
    const fake = fakeGoose();
    await expect(goose.spawn('hello', { ...ctx, _spawnImpl: fake.impl })).rejects.toThrow(/update @commonlyai\/mcp/);
    expect(fake.seen.tokenFile).toBeUndefined();
  }, { readyFile: false });
});
