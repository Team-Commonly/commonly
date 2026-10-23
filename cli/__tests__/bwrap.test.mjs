/**
 * bwrap.test.mjs — ADR-008 Phase 1
 *
 * Covers the bwrap sandbox helper: detection, argv wrapping, macOS refusal.
 * Linux-only assertions guard with `process.platform !== 'linux'` so the
 * suite passes on a macOS dev box without false negatives.
 */

import {
  detectBwrap,
  wrapArgvWithBwrap,
  BWRAP_MACOS_MESSAGE,
} from '../src/lib/sandbox/bwrap.js';

const onLinux = process.platform === 'linux';
const itLinux = onLinux ? test : test.skip;
const itMac = process.platform === 'darwin' ? test : test.skip;

describe('detectBwrap', () => {
  itLinux('returns {available:true} when bwrap is on PATH (skipped if not installed)', () => {
    const res = detectBwrap();
    if (!res.available) {
      // Don't fail CI on a Linux box without bubblewrap — the production
      // attach flow is already the loud surface for "you need to install it".
      expect(res.error).toMatch(/bwrap not found|bubblewrap/);
      return;
    }
    expect(res.available).toBe(true);
    expect(res.path).toBe('bwrap');
  });

  itMac('returns the macOS-specific error on darwin', () => {
    const res = detectBwrap();
    expect(res.available).toBe(false);
    expect(res.error).toBe(BWRAP_MACOS_MESSAGE);
  });
});

// `bwrap --version` alone passed on an Ubuntu 24.04 host whose AppArmor then
// refused every sandbox (ubuntu run 38982219348). The probe starts one.
describe('detectBwrap namespace probe', () => {
  const ok = { status: 0, stdout: 'bubblewrap 0.9.0', stderr: '' };
  const linux = (results) => {
    const calls = [];
    const spawn = (cmd, args) => { calls.push([cmd, ...args]); return results.shift(); };
    return { spawn, calls };
  };

  test('installed and able to start a namespace: available', () => {
    const { spawn, calls } = linux([ok, ok]);
    expect(detectBwrap({ spawn, platform: 'linux' })).toEqual({ available: true, path: 'bwrap' });
    expect(calls[1]).toEqual(['bwrap', '--unshare-all', '--ro-bind', '/', '/', 'true']);
  });

  test('installed but refused a namespace: not available, with the reason and the AppArmor note', () => {
    const { spawn } = linux([ok, { status: 1, stdout: '', stderr: 'bwrap: setting up uid map: Permission denied\n' }]);
    const res = detectBwrap({ spawn, platform: 'linux' });
    expect(res.available).toBe(false);
    expect(res.error).toMatch(/^bubblewrap is installed but cannot start a sandbox on this machine \(bwrap: setting up uid map: Permission denied\)\./);
    expect(res.error).toMatch(/AppArmor restricts the unprivileged user namespaces/);
  });

  test('not installed: the install line, and no probe', () => {
    const { spawn, calls } = linux([{ status: null, error: Object.assign(new Error('spawn bwrap ENOENT'), { code: 'ENOENT' }) }]);
    expect(detectBwrap({ spawn, platform: 'linux' }).error).toMatch(/^bwrap not found on PATH\. Install bubblewrap/);
    expect(calls).toHaveLength(1);
  });
});

describe('wrapArgvWithBwrap', () => {
  itLinux('uses an adapter-owned per-spawn HOME when supplied', () => {
    const argv = wrapArgvWithBwrap(['qwen', '-p', 'hi'], {}, {
      workspacePath: '/tmp/ws', homePath: '/tmp/commonly-qwen/home',
    });
    const homeIndex = argv.indexOf('HOME');
    expect(argv[homeIndex - 1]).toBe('--setenv');
    expect(argv[homeIndex + 1]).toBe('/tmp/commonly-qwen/home');
  });

  itLinux('does not put child environment values in bwrap argv', () => {
    const environment = {
      PATH: '/tmp/filtered-path-value',
      LANG: 'filtered-lang-value',
      COMMONLY_AGENT_SEAT_NAME: 'filtered-seat-name-value',
      COMMONLY_AGENT_TOKEN: 'secret-that-must-stay-out-of-argv',
    };
    const argv = wrapArgvWithBwrap(['claude'], {}, {
      workspacePath: '/tmp/ws',
      environment,
    });
    expect(argv).not.toContain('--clearenv');
    for (const value of Object.values(environment)) expect(argv).not.toContain(value);
    expect(argv).toEqual(expect.arrayContaining(['--setenv', 'HOME', '/tmp/ws']));
  });

  itMac('throws the documented macOS message on darwin', () => {
    expect(() => wrapArgvWithBwrap(['claude', '-p', 'hi'], {}, {
      workspacePath: '/tmp/ws',
    })).toThrow(BWRAP_MACOS_MESSAGE);
  });

  itLinux('produces the expected isolation flag set', () => {
    const argv = wrapArgvWithBwrap(
      ['claude', '-p', 'hi'],
      { sandbox: { network: { policy: 'unrestricted' } } },
      { workspacePath: '/tmp/ws' },
    );
    expect(argv[0]).toBe('bwrap');
    expect(argv).toContain('--unshare-all');
    expect(argv).toContain('--share-net');
    expect(argv).toContain('--die-with-parent');
    expect(argv).toContain('--new-session');
    expect(argv).toContain('--proc');
    expect(argv).toContain('--dev');
    expect(argv).toContain('--tmpfs');
    // workspace bind RW + chdir + HOME
    const bindIdx = argv.indexOf('--bind');
    expect(bindIdx).toBeGreaterThan(-1);
    expect(argv[bindIdx + 1]).toBe('/tmp/ws');
    expect(argv[bindIdx + 2]).toBe('/tmp/ws');
    expect(argv).toContain('--chdir');
    expect(argv).toContain('--setenv');
    // inner argv preserved at the end after `--`
    const sepIdx = argv.indexOf('--');
    expect(sepIdx).toBeGreaterThan(-1);
    expect(argv.slice(sepIdx + 1)).toEqual(['claude', '-p', 'hi']);
  });

  itLinux('switches to --unshare-net when network.policy=restricted', () => {
    const argv = wrapArgvWithBwrap(
      ['claude'],
      { sandbox: { network: { policy: 'restricted' } } },
      { workspacePath: '/tmp/ws' },
    );
    expect(argv).toContain('--unshare-net');
    expect(argv).not.toContain('--share-net');
  });

  itLinux('appends user read-outside paths as --ro-bind-try', () => {
    const argv = wrapArgvWithBwrap(
      ['claude'],
      { sandbox: { filesystem: { 'read-outside': ['/home/user/.claude'] } } },
      { workspacePath: '/tmp/ws' },
    );
    // bwrap binds emit the triple `--ro-bind-try <source> <dest>`, so the
    // path appears twice in a row. indexOf returns the FIRST occurrence
    // (the source position), so the flag is at idx-1 and the dest at idx+1.
    const idx = argv.indexOf('/home/user/.claude');
    expect(idx).toBeGreaterThan(-1);
    expect(argv[idx - 1]).toBe('--ro-bind-try');
    expect(argv[idx + 1]).toBe('/home/user/.claude');
  });

  itLinux('binds exact adapter-owned transient inputs read-only', () => {
    const argv = wrapArgvWithBwrap(
      ['claude'],
      {},
      {
        workspacePath: '/tmp/ws',
        readOnlyPaths: ['/tmp/commonly-claude-mcp-abc123'],
      },
    );
    const idx = argv.indexOf('/tmp/commonly-claude-mcp-abc123');
    expect(idx).toBeGreaterThan(-1);
    expect(argv[idx - 1]).toBe('--ro-bind');
    expect(argv[idx + 1]).toBe('/tmp/commonly-claude-mcp-abc123');
  });

  itLinux('binds a provider key file read-only without binding its containing directory', () => {
    const keyFile = '/home/operator/.config/commonly/provider-key';
    const argv = wrapArgvWithBwrap(
      ['opencode', 'run'],
      {},
      { workspacePath: '/tmp/ws', readOnlyPaths: [keyFile] },
    );
    const idx = argv.indexOf(keyFile);
    expect(idx).toBeGreaterThan(-1);
    expect(argv[idx - 1]).toBe('--ro-bind');
    expect(argv[idx + 1]).toBe(keyFile);
    expect(argv).not.toContain('/home/operator/.config/commonly');
  });

  itLinux('rejects relative adapter-owned transient paths', () => {
    expect(() => wrapArgvWithBwrap(
      ['claude'],
      {},
      { workspacePath: '/tmp/ws', readOnlyPaths: ['relative/config'] },
    )).toThrow(/readOnlyPaths entries must be absolute/);
  });

  itLinux('expands ~ in read-outside / write-outside paths', async () => {
    // Surfaced live during 2026-04-17 demo validation: `~/.local/bin` was
    // declared in read-outside but bwrap saw the literal `~` and the
    // --ro-bind-try silently no-op'd. Bind args must be host-absolute.
    const { homedir } = await import('os');
    const home = homedir();
    const argv = wrapArgvWithBwrap(
      ['claude'],
      {
        sandbox: {
          filesystem: {
            'read-outside': ['~/.claude'],
            'write-outside': ['~/work'],
          },
        },
      },
      { workspacePath: '/tmp/ws' },
    );
    expect(argv).toContain(`${home}/.claude`);
    expect(argv).toContain(`${home}/work`);
    // The literal tilde must NOT appear as a bind arg.
    expect(argv.some((a) => a === '~/.claude' || a === '~/work')).toBe(false);
  });

  itLinux('rejects empty inner argv', () => {
    expect(() => wrapArgvWithBwrap([], {}, { workspacePath: '/tmp/ws' })).toThrow(
      /non-empty innerArgv/,
    );
  });

  itLinux('rejects relative workspace paths', () => {
    expect(() => wrapArgvWithBwrap(['x'], {}, { workspacePath: 'relative/ws' })).toThrow(
      /absolute path/,
    );
  });
});
