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

  itLinux('allows loopback setup only inside an isolated network namespace', () => {
    const argv = wrapArgvWithBwrap(
      ['node', 'bridge.mjs'],
      { sandbox: { network: { policy: 'restricted' } } },
      { workspacePath: '/tmp/ws', enableLoopback: true },
    );
    expect(argv).toContain('--unshare-net');
    expect(argv).not.toContain('--share-net');
    expect(argv.slice(argv.indexOf('--uid'), argv.indexOf('--uid') + 4))
      .toEqual(['--uid', '0', '--gid', '0']);
    expect(argv.slice(argv.indexOf('--cap-add'), argv.indexOf('--cap-add') + 4))
      .toEqual(['--cap-add', 'CAP_NET_ADMIN', '--cap-add', 'CAP_SETPCAP']);
    expect(() => wrapArgvWithBwrap(
      ['node', 'bridge.mjs'], {}, { workspacePath: '/tmp/ws', enableLoopback: true },
    )).toThrow(/requires an isolated network namespace/);
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

  itLinux('binds an adapter-owned HOME writable, separate from a read-only workspace', () => {
    const argv = wrapArgvWithBwrap(['claude'], {}, {
      workspacePath: '/tmp/ws',
      workspaceReadOnly: true,
      homePath: '/home/u/.commonly/claude-homes/abc',
      writablePaths: ['/home/u/.commonly/claude-homes/abc'],
      readOnlyWorkspaceEntries: ['.git'],
    });
    const at = (flag, p) => argv.findIndex((arg, i) => arg === flag && argv[i + 1] === p && argv[i + 2] === p);
    expect(at('--bind', '/home/u/.commonly/claude-homes/abc')).toBeGreaterThan(-1);
    expect(at('--ro-bind', '/tmp/ws')).toBeGreaterThan(-1);
    expect(at('--bind', '/tmp/ws')).toBe(-1);
    expect(at('--ro-bind-try', '/tmp/ws/.git')).toBeGreaterThan(at('--ro-bind', '/tmp/ws'));
    const homeIndex = argv.indexOf('HOME');
    expect(argv[homeIndex + 1]).toBe('/home/u/.commonly/claude-homes/abc');
  });

  itLinux('in a writable workspace a read-only entry is bound strictly, so a missing one stops bwrap', () => {
    const argv = wrapArgvWithBwrap(['claude'], {}, {
      workspacePath: '/tmp/ws', readOnlyWorkspaceEntries: ['.git'],
    });
    const at = (flag, p) => argv.findIndex((arg, i) => arg === flag && argv[i + 1] === p && argv[i + 2] === p);
    expect(at('--ro-bind', '/tmp/ws/.git')).toBeGreaterThan(at('--bind', '/tmp/ws'));
    expect(at('--ro-bind-try', '/tmp/ws/.git')).toBe(-1);
  });

  itLinux('rejects a relative writable path and a workspace entry that leaves the workspace', () => {
    expect(() => wrapArgvWithBwrap(['claude'], {}, {
      workspacePath: '/tmp/ws', writablePaths: ['state'],
    })).toThrow(/writablePaths entries must be absolute/);
    for (const entry of ['../outside', '/etc', 'a/../../b']) {
      expect(() => wrapArgvWithBwrap(['claude'], {}, {
        workspacePath: '/tmp/ws', readOnlyWorkspaceEntries: [entry],
      })).toThrow(/relative names inside the workspace/);
    }
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
