/**
 * sandbox.microsandbox.test.mjs: the native Windows microVM sandbox (opt-in).
 *
 * The fence, the WHP probe, the pinned msb download and the turn wrapper are
 * pure enough to test anywhere. The windows-latest workflow
 * (cli-microsandbox-windows.yml) runs them for real.
 */
import { jest } from '@jest/globals';
import { createHash } from 'crypto';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  GUEST_HOME,
  GUEST_IMAGE,
  GUEST_TURN_DIR,
  GUEST_VOLUME_SPEC,
  GUEST_VOLUME_TURN_SPEC,
  GUEST_WORKSPACE,
  MICROVM_FLAG_ENV,
  MSB_PIN,
  buildMicrovmFence,
  buildMicrovmRunArgs,
  checkMicrovmAttach,
  GUEST_CLAUDE_VERSION,
  GUEST_CODEX_VERSION,
  ensureGuestAgent,
  ensureMsb,
  ensureNoSeatVm,
  withSeatLock,
  microvmFlagOn,
  microvmSeatHome,
  microvmSeatLabel,
  msbAsset,
  parseWhpProbe,
  probeWhp,
  withInstallLock,
  writeMicrovmTurn,
} from '../src/lib/sandbox/microsandbox.js';

describe('the flag', () => {
  test('is on only for the exact value 1', () => {
    expect(microvmFlagOn({ [MICROVM_FLAG_ENV]: '1' })).toBe(true);
    for (const value of [undefined, '', '0', 'true', 'yes', ' 1']) {
      expect(microvmFlagOn({ [MICROVM_FLAG_ENV]: value })).toBe(false);
    }
  });
});

describe('buildMicrovmFence', () => {
  test('closes the network and opens exactly the named host ports, plus DNS', () => {
    expect(buildMicrovmFence([4100, 4200])).toEqual([
      '--no-net', '--net-rule', 'allow@dns,allow@host:tcp:4100,allow@host:tcp:4200',
    ]);
  });

  test('never emits an allow@host rule without a port, nor any port it was not given', () => {
    const fence = buildMicrovmFence([4100, 4200]);
    expect(fence[0]).toBe('--no-net');
    const rules = fence.filter((_, i) => fence[i - 1] === '--net-rule').flatMap((r) => r.split(','));
    const hostRules = rules.filter((rule) => rule.startsWith('allow@host'));
    expect(hostRules).toEqual(['allow@host:tcp:4100', 'allow@host:tcp:4200']);
    expect(rules.filter((rule) => rule !== 'allow@dns' && !hostRules.includes(rule))).toEqual([]);
  });

  test.each([
    [[]], [[0]], [[65536]], [[80.5]], [['4100']], [[4100, 4100]], [null], [undefined],
  ])('refuses %p', (ports) => {
    expect(() => buildMicrovmFence(ports)).toThrow(/microVM fence/);
  });
});

describe('parseWhpProbe', () => {
  test('a present hypervisor is available', () => {
    expect(parseWhpProbe('hr=0 present=1\r\n')).toEqual({ available: true });
  });
  test('a missing WinHvPlatform.dll names the feature to turn on', () => {
    const verdict = parseWhpProbe('nodll\n');
    expect(verdict.available).toBe(false);
    expect(verdict.error).toMatch(/HypervisorPlatform/);
  });
  test('an installed WHP with no active hypervisor says to reboot', () => {
    const verdict = parseWhpProbe('hr=0 present=0');
    expect(verdict.available).toBe(false);
    expect(verdict.error).toMatch(/reboot/i);
  });
  test('a failed query reports the HRESULT', () => {
    expect(parseWhpProbe('hr=-2147024891 present=0').error).toMatch(/0x80070005/);
  });
  test('unreadable output is unavailable, never available', () => {
    expect(parseWhpProbe('').available).toBe(false);
    expect(parseWhpProbe('present=1').available).toBe(false);
  });
});

describe('probeWhp', () => {
  test('off Windows it is unavailable without running anything', () => {
    const run = jest.fn();
    expect(probeWhp({ platform: 'linux', run }).available).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });
  test('on Windows it asks PowerShell, non-interactively, and parses the answer', () => {
    const run = jest.fn(() => ({ status: 0, stdout: 'hr=0 present=1\n', stderr: '' }));
    expect(probeWhp({ platform: 'win32', run })).toEqual({ available: true });
    const [cmd, args, opts] = run.mock.calls[0];
    expect(cmd).toMatch(/powershell/i);
    expect(args).toEqual(expect.arrayContaining(['-NoProfile', '-NonInteractive']));
    expect(args.join(' ')).toContain('WHvGetCapability');
    expect(opts.timeout).toBeGreaterThan(0);
  });
  test('a PowerShell that cannot start is unavailable', () => {
    const run = jest.fn(() => ({ error: new Error('spawn powershell.exe ENOENT') }));
    const verdict = probeWhp({ platform: 'win32', run });
    expect(verdict.available).toBe(false);
    expect(verdict.error).toMatch(/ENOENT/);
  });
});

describe('checkMicrovmAttach', () => {
  const ok = () => ({ available: true });
  const env = { [MICROVM_FLAG_ENV]: '1' };

  test('passes on Windows with the flag and WHP, for the claude adapter', () => {
    expect(() => checkMicrovmAttach({
      adapterName: 'claude', platform: 'win32', env, probe: ok,
    })).not.toThrow();
  });
  test('refuses off Windows', () => {
    expect(() => checkMicrovmAttach({
      adapterName: 'claude', platform: 'darwin', env, probe: ok,
    })).toThrow(/native Windows/);
  });
  test('refuses without the flag', () => {
    expect(() => checkMicrovmAttach({
      adapterName: 'claude', platform: 'win32', env: {}, probe: ok,
    })).toThrow(new RegExp(MICROVM_FLAG_ENV));
  });
  test('passes for the codex adapter too', () => {
    expect(() => checkMicrovmAttach({
      adapterName: 'codex', platform: 'win32', env, probe: ok,
    })).not.toThrow();
  });
  test.each(['opencode', 'qwen', 'goose', 'pi', 'dsh'])('refuses the %s adapter', (adapterName) => {
    expect(() => checkMicrovmAttach({
      adapterName, platform: 'win32', env, probe: ok,
    })).toThrow(/only the claude adapter/);
  });
  test('refuses without WHP, naming the PowerShell command and the reboot', () => {
    const error = (() => {
      try {
        checkMicrovmAttach({
          adapterName: 'claude', platform: 'win32', env, probe: () => ({ available: false, error: 'WinHvPlatform.dll is missing' }),
        });
      } catch (err) { return err; }
      return null;
    })();
    expect(error.message).toContain('WinHvPlatform.dll is missing');
    expect(error.message).toContain('Enable-WindowsOptionalFeature -Online -FeatureName HypervisorPlatform');
    expect(error.message).toMatch(/Administrator/);
    expect(error.message).toMatch(/reboot/i);
  });
});

describe('msbAsset', () => {
  test('picks the pinned Windows asset for the architecture', () => {
    expect(msbAsset('x64').name).toBe('microsandbox-windows-x86_64.zip');
    expect(msbAsset('arm64').name).toBe('microsandbox-windows-aarch64.zip');
    expect(() => msbAsset('ia32')).toThrow(/no microsandbox build/);
  });
  test('every pinned hash is a full SHA-256', () => {
    for (const asset of Object.values(MSB_PIN.assets)) expect(asset.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('ensureMsb', () => {
  let root;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'msb-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  const zip = Buffer.from('pretend zip bytes');
  const sha = createHash('sha256').update(zip).digest('hex');
  const asset = { name: 'microsandbox-windows-x86_64.zip', sha256: sha };
  const fetchOk = jest.fn(async () => ({ ok: true, status: 200, arrayBuffer: async () => zip }));
  const extract = (archive, dir) => {
    writeFileSync(join(dir, 'msb.exe'), 'exe');
    writeFileSync(join(dir, 'libkrunfw.dll'), 'dll');
    return { status: 0 };
  };

  test('downloads, checks the hash, extracts, and reuses the install after', async () => {
    const extractSpy = jest.fn(extract);
    const path = await ensureMsb({ root, asset, fetchImpl: fetchOk, extract: extractSpy });
    expect(path).toBe(join(root, 'msb.exe'));
    expect(existsSync(join(root, 'libkrunfw.dll'))).toBe(true);
    expect(readFileSync(join(root, '.verified'), 'utf8').trim().split(' ')[0]).toBe(sha);
    expect(fetchOk.mock.calls[0][0]).toBe(`https://github.com/superradcompany/microsandbox/releases/download/v${MSB_PIN.version}/${asset.name}`);
    await ensureMsb({ root, asset, fetchImpl: fetchOk, extract: extractSpy });
    expect(extractSpy).toHaveBeenCalledTimes(1);
  });

  test('a download that stalls is abandoned at its deadline, leaving nothing behind', async () => {
    const stalled = jest.fn((url, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason));
    }));
    await expect(ensureMsb({ root, asset, fetchImpl: stalled, extract, timeoutMs: 30 }))
      .rejects.toThrow(/took longer than/);
    expect(stalled.mock.calls[0][1].signal).toBeDefined();
    expect(existsSync(join(root, 'msb.exe'))).toBe(false);
  });

  test('an installed msb.exe that changed since it was unpacked is replaced, not run', async () => {
    const extractSpy = jest.fn(extract);
    await ensureMsb({ root, asset, fetchImpl: fetchOk, extract: extractSpy });
    writeFileSync(join(root, 'msb.exe'), 'planted');
    await ensureMsb({ root, asset, fetchImpl: fetchOk, extract: extractSpy });
    expect(extractSpy).toHaveBeenCalledTimes(2);
    expect(readFileSync(join(root, 'msb.exe'), 'utf8')).toBe('exe');
  });

  test('a hash mismatch refuses and leaves nothing to run', async () => {
    const bad = { ...asset, sha256: 'f'.repeat(64) };
    await expect(ensureMsb({ root, asset: bad, fetchImpl: fetchOk, extract })).rejects.toThrow(/SHA-256/);
    expect(existsSync(join(root, 'msb.exe'))).toBe(false);
    expect(existsSync(join(root, '.verified'))).toBe(false);
  });

  test('a failed download refuses', async () => {
    const fetchBad = async () => ({ ok: false, status: 404, arrayBuffer: async () => Buffer.alloc(0) });
    await expect(ensureMsb({ root, asset, fetchImpl: fetchBad, extract })).rejects.toThrow(/404/);
  });

  test('an archive that keeps msb.exe one folder down installs from that folder', async () => {
    const nested = (archive, dir) => {
      mkdirSync(join(dir, 'microsandbox-windows-x86_64'));
      writeFileSync(join(dir, 'microsandbox-windows-x86_64', 'msb.exe'), 'exe');
      writeFileSync(join(dir, 'microsandbox-windows-x86_64', 'libkrunfw.dll'), 'dll');
      return { status: 0 };
    };
    const path = await ensureMsb({ root, asset, fetchImpl: fetchOk, extract: nested });
    expect(path).toBe(join(root, 'msb.exe'));
    expect(existsSync(join(root, 'libkrunfw.dll'))).toBe(true);
  });

  test('an archive without msb.exe refuses', async () => {
    await expect(ensureMsb({
      root, asset, fetchImpl: fetchOk, extract: () => ({ status: 0 }),
    })).rejects.toThrow(/msb\.exe/);
    expect(existsSync(join(root, '.verified'))).toBe(false);
  });
});

describe('buildMicrovmRunArgs', () => {
  const base = {
    ports: [4100, 4200],
    turnDir: 'C:\\Users\\a\\AppData\\Local\\commonly\\turn-1',
    workspace: 'C:\\Users\\a\\proj',
    home: 'C:\\Users\\a\\AppData\\Local\\commonly\\seat-home',
  };

  test('runs the pinned image behind the fence, with the turn, the workspace and HOME mounted', () => {
    const args = buildMicrovmRunArgs(base);
    expect(args[0]).toBe('run');
    expect(args).toEqual(expect.arrayContaining(buildMicrovmFence([4100, 4200])));
    expect(args).toEqual(expect.arrayContaining(['--mount-named', GUEST_VOLUME_TURN_SPEC]));
    expect(args).toEqual(expect.arrayContaining(['--mount-dir', `${base.turnDir}:${GUEST_TURN_DIR}:ro`]));
    expect(args).toEqual(expect.arrayContaining(['--mount-dir', `${base.workspace}:${GUEST_WORKSPACE}:ro`]));
    expect(args).toEqual(expect.arrayContaining(['--mount-dir', `${base.home}:${GUEST_HOME}`]));
    expect(args).toEqual(expect.arrayContaining(['--workdir', GUEST_WORKSPACE]));
    const sep = args.indexOf('--');
    expect(args[sep - 1]).toBe(GUEST_IMAGE);
    expect(args.slice(sep + 1)).toEqual(['node', `${GUEST_TURN_DIR}/entry.js`]);
  });

  test('the image is pinned by digest', () => {
    expect(GUEST_IMAGE).toMatch(/@sha256:[0-9a-f]{64}$/);
  });

  test('no label unless one is passed (the Claude turn passes none), each before the image', () => {
    expect(buildMicrovmRunArgs(base)).not.toContain('--label');
    const args = buildMicrovmRunArgs({ ...base, labels: ['commonly-seat=abc-public'] });
    expect(args.slice(args.indexOf('--label'), args.indexOf('--label') + 2)).toEqual(['--label', 'commonly-seat=abc-public']);
    expect(args.indexOf('--label')).toBeLessThan(args.indexOf(GUEST_IMAGE));
  });

  test('a turn mounts the agents volume read-only; only the install mounts it writable', () => {
    expect(GUEST_VOLUME_TURN_SPEC).toBe(`${GUEST_VOLUME_SPEC},ro`);
    const args = buildMicrovmRunArgs(base);
    expect(args).not.toContain(GUEST_VOLUME_SPEC);
  });

  test('the workspace is read-only whatever is asked, so its .git is never the guest\'s', () => {
    const args = buildMicrovmRunArgs({ ...base, workspaceWritable: true });
    expect(args).toEqual(expect.arrayContaining(['--mount-dir', `${base.workspace}:${GUEST_WORKSPACE}:ro`]));
    const rw = args.filter((arg, i) => args[i - 1] === '--mount-dir' && !arg.endsWith(':ro'));
    expect(rw).toEqual([`${base.home}:${GUEST_HOME}`]);
  });

  test('a mount source holding a comma or a colon after the drive is refused', () => {
    expect(() => buildMicrovmRunArgs({ ...base, workspace: 'C:\\a,b' })).toThrow(/mount/);
    expect(() => buildMicrovmRunArgs({ ...base, workspace: 'C:\\a:b' })).toThrow(/mount/);
  });

  test('carries no environment on the command line', () => {
    const args = buildMicrovmRunArgs(base);
    expect(args).not.toContain('-e');
    expect(args).not.toContain('--env');
  });
});

describe('microvmSeatHome', () => {
  test('keeps a public seat apart from the same agent\'s workspace turns', () => {
    const env = { LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' };
    const pub = microvmSeatHome('agent-1', 'public', env);
    const ws = microvmSeatHome('agent-1', 'workspace', env);
    expect(pub).not.toBe(ws);
    expect(pub).toMatch(/-public$/);
    expect(ws).toMatch(/-workspace$/);
    expect(microvmSeatHome('agent-1', 'internal', env)).toBe(pub);
  });
});

describe('withInstallLock', () => {
  let root;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'mvlock-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  test('runs one holder at a time and releases after', async () => {
    const order = [];
    let release;
    const first = withInstallLock(root, () => new Promise((resolve) => {
      order.push('first in');
      release = () => { order.push('first out'); resolve(); };
    }));
    await new Promise((resolve) => { setTimeout(resolve, 30); });
    const second = withInstallLock(root, async () => { order.push('second in'); }, { pollMs: 10 });
    await new Promise((resolve) => { setTimeout(resolve, 60); });
    expect(order).toEqual(['first in']);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(['first in', 'first out', 'second in']);
    expect(existsSync(join(root, '.install.lock'))).toBe(false);
  });

  test('releases the lock when the holder throws', async () => {
    await expect(withInstallLock(root, async () => { throw new Error('install failed'); })).rejects.toThrow('install failed');
    expect(existsSync(join(root, '.install.lock'))).toBe(false);
  });

  test('gives up waiting on a live lock past its deadline', async () => {
    // This process is certainly alive, on every platform.
    writeFileSync(join(root, '.install.lock'), `${process.pid} live\n`);
    await expect(withInstallLock(root, async () => {}, { waitMs: 50, pollMs: 10 })).rejects.toThrow(/still installing/);
  });

  const lock = () => join(root, '.install.lock');
  const anHourAgo = () => { const t = new Date(Date.now() - 60 * 60 * 1000); utimesSync(lock(), t, t); };

  test('a slow install is not taken over while its process runs, past the old 15-minute age', async () => {
    writeFileSync(lock(), '4242 slow\n');
    const t = new Date(Date.now() - 30 * 60 * 1000);
    utimesSync(lock(), t, t);
    const fn = jest.fn(async () => {});
    await expect(withInstallLock(root, fn, { waitMs: 50, pollMs: 10, pidAlive: () => true }))
      .rejects.toThrow(/still installing/);
    expect(fn).not.toHaveBeenCalled();
    expect(readFileSync(lock(), 'utf8')).toBe('4242 slow\n');
  });

  test('a lock whose process has exited is taken over at once', async () => {
    writeFileSync(lock(), '4242 crashed\n');
    const fn = jest.fn(async () => 'ran');
    await expect(withInstallLock(root, fn, { pollMs: 10, pidAlive: (pid) => pid !== 4242 })).resolves.toBe('ran');
    expect(existsSync(lock())).toBe(false);
  });

  test('a lock naming no process is judged by its age', async () => {
    writeFileSync(lock(), 'not a pid\n');
    await expect(withInstallLock(root, async () => {}, { waitMs: 50, pollMs: 10 })).rejects.toThrow(/still installing/);
    anHourAgo();
    await expect(withInstallLock(root, async () => 'ran', { pollMs: 10 })).resolves.toBe('ran');
  });

  test('three waiters taking over one abandoned lock run their installs one at a time', async () => {
    writeFileSync(lock(), '4242 crashed\n');
    let inside = 0;
    let most = 0;
    let ran = 0;
    const install = async () => {
      inside += 1;
      ran += 1;
      most = Math.max(most, inside);
      await new Promise((resolve) => { setTimeout(resolve, 25); });
      inside -= 1;
    };
    const opts = { pollMs: 5, pidAlive: (pid) => pid !== 4242 };
    await Promise.all([
      withInstallLock(root, install, opts), withInstallLock(root, install, opts), withInstallLock(root, install, opts),
    ]);
    expect(ran).toBe(3);
    expect(most).toBe(1);
    expect(existsSync(lock())).toBe(false);
  });

  test('a takeover never deletes a lock taken after it judged the old one abandoned', async () => {
    writeFileSync(lock(), '4242 crashed\n');
    // Between this waiter judging 4242's lock abandoned and renaming it,
    // another waiter takes it over and writes its own.
    const pidAlive = jest.fn((pid) => {
      if (pid === 4242) {
        writeFileSync(lock(), '5151 other\n');
        return false;
      }
      return true;
    });
    const fn = jest.fn(async () => {});
    await expect(withInstallLock(root, fn, { waitMs: 50, pollMs: 10, pidAlive })).rejects.toThrow(/still installing/);
    expect(fn).not.toHaveBeenCalled();
    expect(readFileSync(lock(), 'utf8')).toBe('5151 other\n');
  });

  test('past the hard cap a lock is taken over even though its pid is alive (leaked, or a reused pid)', async () => {
    writeFileSync(lock(), '4242 leaked\n');
    const t = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(lock(), t, t);
    await expect(withInstallLock(root, async () => 'ran', { pollMs: 10, pidAlive: () => true })).resolves.toBe('ran');
  });

  test('a holder that cannot read its lock back removes it rather than leave it', async () => {
    await withInstallLock(root, async () => {
      rmSync(lock());
      mkdirSync(lock());
    });
    expect(existsSync(lock())).toBe(false);
  });

  test('a holder whose lock was taken over leaves the new holder\'s lock in place', async () => {
    await withInstallLock(root, async () => { writeFileSync(lock(), '5151 other\n'); });
    expect(readFileSync(lock(), 'utf8')).toBe('5151 other\n');
  });
});

describe('ensureGuestAgent', () => {
  let root;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'mvguest-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  // A pretend msb: the probe finds nothing, the install prints the version.
  const fakeRun = (version) => {
    const calls = [];
    const run = (cmd, args) => {
      calls.push(args);
      const command = args[args.length - 1];
      return { status: 0, stdout: command.startsWith('npm ') ? `${version}\n` : '' };
    };
    return { calls, run };
  };

  test('installs Claude Code exactly as before: same package, command and marker', () => {
    const { calls, run } = fakeRun(GUEST_CLAUDE_VERSION);
    expect(ensureGuestAgent({ msb: 'msb.exe', root, run })).toEqual({ installed: true });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual(['run', '--mount-named', GUEST_VOLUME_SPEC, GUEST_IMAGE, '--', 'sh', '-c',
      '/opt/agents/bin/claude --version 2>/dev/null || true']);
    expect(calls[1][calls[1].length - 1]).toBe(
      `npm --prefix /opt/agents i -g --no-fund --no-audit @anthropic-ai/claude-code@${GUEST_CLAUDE_VERSION} >/tmp/npm.log 2>&1`
        + ' && /opt/agents/bin/claude --version || (tail -20 /tmp/npm.log; exit 1)',
    );
    expect(existsSync(join(root, `.guest-claude-${GUEST_CLAUDE_VERSION}`))).toBe(true);
    // The marker skips every later probe.
    expect(ensureGuestAgent({ msb: 'msb.exe', root, run })).toEqual({ installed: false });
    expect(calls).toHaveLength(2);
  });

  test('installs the pinned Codex onto the same volume, under its own marker', () => {
    const { calls, run } = fakeRun(GUEST_CODEX_VERSION);
    expect(ensureGuestAgent({
      agent: 'codex', msb: 'msb.exe', root, run,
    })).toEqual({ installed: true });
    expect(calls[1]).toContain(GUEST_VOLUME_SPEC);
    expect(calls[1][calls[1].length - 1]).toContain(`@openai/codex@${GUEST_CODEX_VERSION} `);
    expect(calls[1][calls[1].length - 1]).toContain('/opt/agents/bin/codex --version');
    expect(existsSync(join(root, `.guest-codex-${GUEST_CODEX_VERSION}`))).toBe(true);
    expect(existsSync(join(root, `.guest-claude-${GUEST_CLAUDE_VERSION}`))).toBe(false);
  });

  test('a failed install refuses, naming the agent, and leaves no marker', () => {
    const run = () => ({ status: 1, stdout: 'npm ERR! network' });
    expect(() => ensureGuestAgent({
      agent: 'codex', msb: 'msb.exe', root, run,
    })).toThrow(/installing Codex into the microVM volume failed: npm ERR! network/);
    expect(existsSync(join(root, `.guest-codex-${GUEST_CODEX_VERSION}`))).toBe(false);
  });

  test('an unknown agent is refused', () => {
    expect(() => ensureGuestAgent({ agent: 'opencode', msb: 'msb.exe', root })).toThrow(/no guest install for opencode/);
  });
});

describe('writeMicrovmTurn', () => {
  let dir;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'mvturn-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test('writes the argv and env as a private file and an entry that runs it', async () => {
    await writeMicrovmTurn(dir, {
      argv: ['/opt/agents/bin/claude', '-p', 'hi'],
      env: { ANTHROPIC_API_KEY: 'proxy-token', HOME: GUEST_HOME },
      mcpConfig: { mcpServers: {} },
    });
    const turn = JSON.parse(readFileSync(join(dir, 'turn.json'), 'utf8'));
    expect(turn.argv).toEqual(['/opt/agents/bin/claude', '-p', 'hi']);
    expect(turn.env.ANTHROPIC_API_KEY).toBe('proxy-token');
    expect(turn.cwd).toBe(GUEST_WORKSPACE);
    if (process.platform !== 'win32') expect(statSync(join(dir, 'turn.json')).mode & 0o077).toBe(0);
    const entry = readFileSync(join(dir, 'entry.js'), 'utf8');
    expect(entry).toContain(`${GUEST_TURN_DIR}/turn.json`);
    expect(JSON.parse(readFileSync(join(dir, 'mcp.json'), 'utf8'))).toEqual({ mcpServers: {} });
    expect(existsSync(join(dir, 'mcp-shim.js'))).toBe(true);
  });
});

describe('withSeatLock', () => {
  let seats;
  let home;
  let lock;
  beforeEach(() => {
    seats = mkdtempSync(join(tmpdir(), 'cli-seat-lock-'));
    home = join(seats, 'abc123-public');
    mkdirSync(home);
    lock = join(seats, '.abc123-public.lock');
  });
  afterEach(() => { rmSync(seats, { recursive: true, force: true }); });

  test('the lock sits beside the HOME, never inside it, and goes when the turn ends', async () => {
    let during = null;
    const result = await withSeatLock(home, async () => {
      during = readFileSync(lock, 'utf8');
      return 'ran';
    });
    expect(result).toBe('ran');
    expect(during).toMatch(new RegExp(`^${process.pid} [0-9a-f]{16}\\n$`));
    expect(existsSync(lock)).toBe(false);
    expect(existsSync(join(home, '.abc123-public.lock'))).toBe(false);
  });

  test('a second turn waits for the first, and runs only once it is released', async () => {
    const order = [];
    let release;
    const first = withSeatLock(home, async () => {
      order.push('first in');
      await new Promise((resolve) => { release = resolve; });
      order.push('first out');
    });
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    const second = withSeatLock(home, async () => { order.push('second in'); }, { pollMs: 10, waitMs: 5000 });
    await new Promise((resolve) => { setTimeout(resolve, 60); });
    expect(order).toEqual(['first in']);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(['first in', 'first out', 'second in']);
  });

  test('a second turn past its wait refuses with microvm_seat_busy and never runs', async () => {
    let release;
    const first = withSeatLock(home, () => new Promise((resolve) => { release = resolve; }));
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    const ran = jest.fn();
    await expect(withSeatLock(home, ran, { pollMs: 10, waitMs: 50 }))
      .rejects.toMatchObject({ code: 'microvm_seat_busy' });
    expect(ran).not.toHaveBeenCalled();
    release();
    await first;
  });

  test('a lock whose holder is gone is reclaimed', async () => {
    writeFileSync(lock, '999999 deadbeefdeadbeef\n');
    const ran = jest.fn(async () => readFileSync(lock, 'utf8'));
    const held = await withSeatLock(home, ran, { pidAlive: () => false, pollMs: 10, waitMs: 1000 });
    expect(held).toMatch(new RegExp(`^${process.pid} `));
    expect(existsSync(lock)).toBe(false);
  });

  test('a live holder\'s lock is not reclaimed, and is left exactly as it was', async () => {
    writeFileSync(lock, '4242 cafecafecafecafe\n');
    const ran = jest.fn();
    await expect(withSeatLock(home, ran, { pidAlive: () => true, pollMs: 10, waitMs: 50 }))
      .rejects.toMatchObject({ code: 'microvm_seat_busy' });
    expect(ran).not.toHaveBeenCalled();
    expect(readFileSync(lock, 'utf8')).toBe('4242 cafecafecafecafe\n');
  });

  test('a live pid\'s lock older than maxMs counts as leaked (a reused pid)', async () => {
    writeFileSync(lock, '4242 cafecafecafecafe\n');
    const old = new Date(Date.now() - 10 * 60 * 1000);
    utimesSync(lock, old, old);
    const ran = jest.fn();
    await withSeatLock(home, ran, { pidAlive: () => true, maxMs: 60 * 1000, pollMs: 10, waitMs: 1000 });
    expect(ran).toHaveBeenCalledTimes(1);
  });
});

describe('ensureNoSeatVm', () => {
  const MSB = 'C:\\msb\\msb.exe';
  const label = microvmSeatLabel(join('seats', 'abc123-public'));
  const OTHER = 'commonly-seat=def456-public';

  // A pretend msb holding `vms`; `list` filters by label as msb does.
  const msb = (vms, { stops = true, list = null } = {}) => {
    const calls = [];
    const run = (cmd, args, options) => {
      calls.push({ cmd, args, options });
      if (args[0] === 'list') {
        if (list) return list();
        const wanted = args[args.indexOf('--label') + 1];
        return {
          status: 0,
          stdout: JSON.stringify(vms.filter((vm) => vm.label === wanted).map(({ name, status }) => ({ name, status }))),
        };
      }
      if (args[0] === 'stop' && stops) {
        const vm = vms.find((entry) => entry.name === args[args.length - 1]);
        if (vm) vm.status = 'Stopped';
      }
      return { status: 0, stdout: '' };
    };
    return { calls, run };
  };

  test('the label is the seat HOME\'s folder name', () => {
    expect(label).toBe('commonly-seat=abc123-public');
  });

  test('no VM of the seat: one list, no stop', () => {
    const fake = msb([{ name: 'msb-1', status: 'Running', label: OTHER }]);
    expect(ensureNoSeatVm({ msb: MSB, label, run: fake.run })).toEqual({ stopped: [] });
    expect(fake.calls.map((call) => call.args)).toEqual([['list', '--label', label, '--format', 'json']]);
  });

  test('a stopped or crashed VM of the seat is no VM', () => {
    const fake = msb([
      { name: 'msb-1', status: 'Stopped', label },
      { name: 'msb-2', status: 'Crashed', label },
    ]);
    expect(ensureNoSeatVm({ msb: MSB, label, run: fake.run })).toEqual({ stopped: [] });
  });

  test('a live VM of the seat is force-stopped by name and confirmed gone; another seat\'s is left', () => {
    const vms = [
      { name: 'msb-1', status: 'Running', label },
      { name: 'msb-2', status: 'Draining', label },
      { name: 'msb-3', status: 'Running', label: OTHER },
    ];
    const fake = msb(vms);
    expect(ensureNoSeatVm({ msb: MSB, label, run: fake.run })).toEqual({ stopped: ['msb-1', 'msb-2'] });
    expect(fake.calls.filter((call) => call.args[0] === 'stop').map((call) => call.args)).toEqual([
      ['stop', '--force', '--quiet', '--', 'msb-1'],
      ['stop', '--force', '--quiet', '--', 'msb-2'],
    ]);
    expect(fake.calls.at(-1).args[0]).toBe('list');
    expect(vms[2].status).toBe('Running');
  });

  test('a VM still alive after the stop refuses', () => {
    const fake = msb([{ name: 'msb-1', status: 'Running', label }], { stops: false });
    expect(() => ensureNoSeatVm({ msb: MSB, label, run: fake.run }))
      .toThrow(expect.objectContaining({ code: 'microvm_seat_busy', message: expect.stringMatching(/msb-1 \(Running\)/) }));
  });

  test.each([
    ['msb fails', () => ({ status: 1, stderr: 'database is locked' }), /database is locked/],
    ['msb cannot start', () => ({ error: new Error('spawn EACCES') }), /EACCES/],
    ['an answer that is not JSON', () => ({ status: 0, stdout: 'NAME IMAGE' }), /could not be read/],
    ['an answer that is not a list', () => ({ status: 0, stdout: '{"name":"msb-1"}' }), /could not be read/],
    ['a live VM with no name', () => ({ status: 0, stdout: '[{"status":"Running"}]' }), /no name/],
  ])('it refuses when it cannot confirm: %s', (_, list, message) => {
    const fake = msb([], { list });
    expect(() => ensureNoSeatVm({ msb: MSB, label, run: fake.run }))
      .toThrow(expect.objectContaining({ code: 'microvm_seat_busy', message: expect.stringMatching(message) }));
  });

  test('no msb or no seat label refuses before asking msb anything', () => {
    const fake = msb([]);
    for (const options of [
      { msb: '', label }, { msb: MSB, label: '' }, { msb: MSB, label: 'commonly-seat=' }, { msb: MSB, label: 'other=x' },
    ]) {
      expect(() => ensureNoSeatVm({ ...options, run: fake.run })).toThrow(expect.objectContaining({ code: 'microvm_seat_busy' }));
    }
    expect(fake.calls).toHaveLength(0);
  });

  test('msb gets the env it is given and a timeout', () => {
    const fake = msb([]);
    ensureNoSeatVm({ msb: MSB, label, run: fake.run, env: { LOCALAPPDATA: 'C:\\x' } });
    expect(fake.calls[0].options).toEqual(expect.objectContaining({
      env: { LOCALAPPDATA: 'C:\\x' }, timeout: expect.any(Number), windowsHide: true,
    }));
  });
});
