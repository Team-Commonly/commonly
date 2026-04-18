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

describe('wrapArgvWithBwrap', () => {
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
