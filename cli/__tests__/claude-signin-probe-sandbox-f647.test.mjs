/**
 * F647: the Claude sign-in probe `agent run` makes before it waits runs the
 * way the seat's turn runs. A confined seat on macOS gets the same Seatbelt
 * wrap, HOME and stripped environment as its turn, so a login the jail can't
 * read is reported at setup, not by the first mention. An unconfined seat
 * keeps the plain probe. The spawn is a fake and the seat's state a temp
 * folder; nothing real is read.
 */
import { EventEmitter } from 'events';
import {
  chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { runHarnessLoginStatus } from '../src/lib/run-preflight.js';

const onMac = process.platform === 'darwin' ? test : test.skip;
const ARGS = ['auth', 'status', '--json'];

const recordingSpawn = (code = 0) => {
  const calls = [];
  const spawnFn = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.kill = () => {};
    setImmediate(() => child.emit('exit', code));
    return child;
  };
  return { calls, spawnFn };
};

describe('the Claude sign-in probe runs inside the seat\'s sandbox (F647)', () => {
  let root;
  let bin;
  let state;
  let env;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'commonly-f647-probe-'));
    bin = join(root, 'bin');
    state = join(root, 'state');
    mkdirSync(bin);
    mkdirSync(join(state, 'tmp'), { recursive: true });
    writeFileSync(join(bin, 'claude'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(bin, 'claude'), 0o755);
    env = { PATH: `${bin}:/usr/bin:/bin`, SECRET_THING: 'stays out' };
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const prepareState = async () => ({ statePath: state, tmpPath: join(state, 'tmp') });

  onMac('a confined seat\'s probe is spawned through sandbox-exec with the seat\'s HOME', async () => {
    const { calls, spawnFn } = recordingSpawn(1);
    const code = await runHarnessLoginStatus('claude', ARGS, {
      env,
      environment: { sandbox: { trust: 'public' } },
      agentName: 'f647-seat',
      spawnFn,
      _prepareClaudeState: prepareState,
    });

    expect(code).toBe(1);
    expect(calls).toHaveLength(1);
    const [{ command, args, options }] = calls;
    expect(command).toBe('/usr/bin/sandbox-exec');
    expect(args[0]).toBe('-p');
    expect(args[1]).toContain('(deny default)');
    expect(args.slice(2)).toEqual([realpathSync(join(bin, 'claude')), ...ARGS]);
    expect(options.env.HOME).toBe(state);
    expect(options.env.SECRET_THING).toBeUndefined();
  });

  onMac('a workspace-trust seat is confined the same way', async () => {
    const { calls, spawnFn } = recordingSpawn(0);
    await runHarnessLoginStatus('claude', ARGS, {
      env,
      environment: { sandbox: { trust: 'workspace', mode: 'workspace' } },
      agentName: 'f647-seat',
      spawnFn,
      _prepareClaudeState: prepareState,
    });
    expect(calls[0].command).toBe('/usr/bin/sandbox-exec');
  });

  onMac('a saved legacy `internal` seat is confined, as its turn is', async () => {
    const { calls, spawnFn } = recordingSpawn(0);
    await runHarnessLoginStatus('claude', ARGS, {
      env,
      environment: { sandbox: { trust: 'internal' } },
      agentName: 'f647-seat',
      spawnFn,
      _prepareClaudeState: prepareState,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe('/usr/bin/sandbox-exec');
    expect(calls[0].options.env.HOME).toBe(state);
  });

  test('an unconfined seat keeps the plain probe', async () => {
    const { calls, spawnFn } = recordingSpawn(0);
    const code = await runHarnessLoginStatus('claude', ARGS, {
      env,
      environment: {},
      agentName: 'f647-seat',
      platform: 'darwin',
      resolve: () => ({ command: join(bin, 'claude'), args: [] }),
      spawnFn,
      _prepareClaudeState: prepareState,
    });
    expect(code).toBe(0);
    expect(calls[0].command).toBe(join(bin, 'claude'));
    expect(calls[0].args).toEqual(ARGS);
  });
});
