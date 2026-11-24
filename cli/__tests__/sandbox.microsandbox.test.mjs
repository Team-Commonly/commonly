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
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  GUEST_HOME,
  GUEST_IMAGE,
  GUEST_TURN_DIR,
  GUEST_VOLUME_SPEC,
  GUEST_WORKSPACE,
  MICROVM_FLAG_ENV,
  MSB_PIN,
  buildMicrovmFence,
  buildMicrovmRunArgs,
  checkMicrovmAttach,
  ensureMsb,
  microvmFlagOn,
  msbAsset,
  parseWhpProbe,
  probeWhp,
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
  test.each(['codex', 'opencode', 'qwen', 'goose', 'pi', 'dsh'])('refuses the %s adapter', (adapterName) => {
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
    expect(readFileSync(join(root, '.verified'), 'utf8').trim()).toBe(sha);
    expect(fetchOk.mock.calls[0][0]).toBe(`https://github.com/superradcompany/microsandbox/releases/download/v${MSB_PIN.version}/${asset.name}`);
    await ensureMsb({ root, asset, fetchImpl: fetchOk, extract: extractSpy });
    expect(extractSpy).toHaveBeenCalledTimes(1);
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
    expect(args).toEqual(expect.arrayContaining(['--mount-named', GUEST_VOLUME_SPEC]));
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

  test('a writable workspace drops :ro on that mount only', () => {
    const args = buildMicrovmRunArgs({ ...base, workspaceWritable: true });
    expect(args).toEqual(expect.arrayContaining(['--mount-dir', `${base.workspace}:${GUEST_WORKSPACE}`]));
    expect(args).toEqual(expect.arrayContaining(['--mount-dir', `${base.turnDir}:${GUEST_TURN_DIR}:ro`]));
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
