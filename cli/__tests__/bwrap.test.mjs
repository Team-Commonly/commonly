/**
 * bwrap.test.mjs — ADR-008 Phase 1
 *
 * Covers the bwrap sandbox helper: detection, argv wrapping, macOS refusal.
 * Linux-only assertions guard with `process.platform !== 'linux'` so the
 * suite passes on a macOS dev box without false negatives.
 */

import {
  detectBwrap,
  readApparmorRestriction,
  readUbuntuRelease,
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
    expect(detectBwrap({ spawn, platform: 'linux' })).toEqual({ available: true, path: 'bwrap', bindFd: false });
    expect(calls[1]).toEqual(['bwrap', '--unshare-all', '--ro-bind', '/', '/', 'true']);
  });

  test('installed but refused a namespace: not available, with the reason and the AppArmor note', () => {
    const { spawn } = linux([ok, { status: 1, stdout: '', stderr: 'bwrap: setting up uid map: Permission denied\n' }]);
    const res = detectBwrap({ spawn, platform: 'linux' });
    expect(res.available).toBe(false);
    expect(res.error).toMatch(/^bubblewrap is installed but cannot start a sandbox on this machine \(bwrap: setting up uid map: Permission denied\)\./);
    expect(res.error).toMatch(/AppArmor restricts the unprivileged user namespaces/);
    expect(res).toMatchObject({ namespaceRefused: true, reason: 'bwrap: setting up uid map: Permission denied' });
  });

  test('a refused namespace says whether the AppArmor restriction is on', () => {
    const refused = () => linux([ok, { status: 1, stdout: '', stderr: 'bwrap: nope\n' }]).spawn;
    expect(detectBwrap({ spawn: refused(), platform: 'linux', readRestriction: () => true }).apparmorRestricted).toBe(true);
    expect(detectBwrap({ spawn: refused(), platform: 'linux', readRestriction: () => false }).apparmorRestricted).toBe(false);
    expect(detectBwrap({ spawn: refused(), platform: 'linux', readRelease: () => '24.04' }).ubuntuRelease).toBe('24.04');
  });

  // The real readers, against a fake filesystem: a reader stuck at false or
  // null would pass the injected tests above and drop the profile lines.
  describe('the readers behind the profile lines', () => {
    const SYSCTL = '/proc/sys/kernel/apparmor_restrict_unprivileged_userns';
    const fs = (files) => ({
      read: (path) => {
        if (!(path in files)) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
        return files[path];
      },
      exists: (path) => path in files,
    });

    test('the AppArmor restriction: on, off, missing, and inside a container', () => {
      expect(readApparmorRestriction(fs({ [SYSCTL]: '1\n' }))).toBe(true);
      expect(readApparmorRestriction(fs({ [SYSCTL]: '0\n' }))).toBe(false);
      expect(readApparmorRestriction(fs({}))).toBe(false);
      expect(readApparmorRestriction(fs({ [SYSCTL]: '1\n', '/.dockerenv': '' }))).toBe(false);
      expect(readApparmorRestriction(fs({ [SYSCTL]: '1\n', '/run/.containerenv': '' }))).toBe(false);
      expect(readApparmorRestriction(fs({ [SYSCTL]: '1\n', '/run/systemd/container': 'lxc\n' }))).toBe(false);
    });

    test('the Ubuntu release: plain and quoted values, another distro, no file', () => {
      expect(readUbuntuRelease(fs({ '/etc/os-release': 'NAME="Ubuntu"\nID=ubuntu\nVERSION_ID="24.04"\n' }))).toBe('24.04');
      expect(readUbuntuRelease(fs({ '/etc/os-release': 'ID="ubuntu"\nVERSION_ID="24.04"\n' }))).toBe('24.04');
      expect(readUbuntuRelease(fs({ '/etc/os-release': "ID='ubuntu'\nVERSION_ID=24.04\n" }))).toBe('24.04');
      expect(readUbuntuRelease(fs({ '/etc/os-release': 'ID=debian\nID_LIKE=ubuntu\nVERSION_ID="12"\n' }))).toBeNull();
      expect(readUbuntuRelease(fs({ '/etc/os-release': 'ID="ubuntu\nVERSION_ID="24.04"\n' }))).toBeNull();
      expect(readUbuntuRelease(fs({}))).toBeNull();
      expect(readUbuntuRelease(fs({ '/etc/os-release': 'ID=ubuntu\nVERSION_ID=22.04\nVERSION_ID="24.04"\n' }))).toBe('24.04');
      expect(readUbuntuRelease(fs({ '/usr/lib/os-release': 'ID=ubuntu\nVERSION_ID="24.04"\n' }))).toBe('24.04');
      expect(readUbuntuRelease(fs({
        '/etc/os-release': 'ID=debian\nVERSION_ID="12"\n',
        '/usr/lib/os-release': 'ID=ubuntu\nVERSION_ID="24.04"\n',
      }))).toBeNull();
    });
  });

  test('a probe that timed out reads as unavailable, not as a refused namespace', () => {
    const { spawn } = linux([ok, { status: null, error: Object.assign(new Error('spawnSync bwrap ETIMEDOUT'), { code: 'ETIMEDOUT' }) }]);
    const res = detectBwrap({ spawn, platform: 'linux' });
    expect(res.available).toBe(false);
    expect(res.namespaceRefused).toBe(false);
  });

  test('not installed: the install line, and no probe', () => {
    const { spawn, calls } = linux([{ status: null, error: Object.assign(new Error('spawn bwrap ENOENT'), { code: 'ENOENT' }) }]);
    const res = detectBwrap({ spawn, platform: 'linux' });
    expect(res.error).toMatch(/^bwrap not found on PATH\. Install bubblewrap/);
    expect(res.namespaceRefused).toBeUndefined();
    expect(calls).toHaveLength(1);
  });
});

// F211: --bind-fd arrived in 0.10.0 and was backported to 0.6.3, so it is read
// from the usage text, not the version.
describe('detectBwrap descriptor-bind probe', () => {
  const ok = { status: 0, stdout: 'bubblewrap 0.11.0', stderr: '' };
  const probe = (help) => {
    const calls = [];
    const results = [ok, ok, help];
    const spawn = (cmd, args) => { calls.push([cmd, ...args]); return results.shift(); };
    return { spawn, calls };
  };

  test('a bwrap whose usage lists --bind-fd binds descriptors', () => {
    const { spawn, calls } = probe({ status: 0, stdout: '    --bind-fd FD DEST            Bind open directory or path fd on DEST\n' });
    expect(detectBwrap({ spawn, platform: 'linux' })).toEqual({ available: true, path: 'bwrap', bindFd: true });
    expect(calls[2]).toEqual(['bwrap', '--help']);
  });

  test('an older bwrap, or a usage read that fails, keeps the path binds', () => {
    expect(detectBwrap({ spawn: probe({ status: 0, stdout: '    --bind SRC DEST  Bind mount the host path SRC on DEST\n' }).spawn, platform: 'linux' }).bindFd).toBe(false);
    expect(detectBwrap({ spawn: probe({ status: 1, stdout: '--bind-fd' }).spawn, platform: 'linux' }).bindFd).toBe(false);
    expect(detectBwrap({ spawn: probe({ error: new Error('ETIMEDOUT') }).spawn, platform: 'linux' }).bindFd).toBe(false);
  });
});

describe('wrapArgvWithBwrap with descriptor binds (F211)', () => {
  const originalPlatform = process.platform;
  beforeEach(() => { Object.defineProperty(process, 'platform', { value: 'linux' }); });
  afterEach(() => { Object.defineProperty(process, 'platform', { value: originalPlatform }); });
  const triples = (argv) => argv.flatMap((arg, i) => (
    /^--(ro-)?bind(-fd|-try)?$/.test(arg) ? [[arg, argv[i + 1], argv[i + 2]]] : []));

  test('mounts the workspace and a held entry from their child descriptors', () => {
    const argv = wrapArgvWithBwrap(['claude'], {}, {
      workspacePath: '/work/given', workspaceSource: '/real/project',
      readOnlyWorkspaceEntries: ['.git'], bindFds: { workspace: 3, entries: { '.git': 4 } },
    });
    expect(triples(argv)).toContainEqual(['--bind-fd', '3', '/work/given']);
    expect(triples(argv)).toContainEqual(['--ro-bind-fd', '4', '/work/given/.git']);
    expect(triples(argv).filter(([, src]) => src.startsWith('/real/project'))).toEqual([]);
  });

  test('a read-only workspace mounts read-only from its descriptor', () => {
    const argv = wrapArgvWithBwrap(['claude'], {}, {
      workspacePath: '/work/given', workspaceReadOnly: true, bindFds: { workspace: 3 },
    });
    expect(triples(argv)).toContainEqual(['--ro-bind-fd', '3', '/work/given']);
  });

  test('an entry without a descriptor keeps its path bind', () => {
    const argv = wrapArgvWithBwrap(['claude'], {}, {
      workspacePath: '/work/given', workspaceSource: '/real/project', workspaceReadOnly: true,
      readOnlyWorkspaceEntries: ['.git'], bindFds: { workspace: 3, entries: {} },
    });
    expect(triples(argv)).toContainEqual(['--ro-bind-try', '/real/project/.git', '/work/given/.git']);
  });

  test.each([[0], [2], [-1], ['3'], [3.5]])('refuses %p as a child descriptor', (fd) => {
    expect(() => wrapArgvWithBwrap(['claude'], {}, { workspacePath: '/w', bindFds: { workspace: fd } }))
      .toThrow(/child descriptors of 3 or more/);
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

// F493: a workspace seat's binds pass the allowlist Seatbelt applies (F122), so
// a server-written spec can't bind ~/.ssh or another seat's per-turn token
// folder into a Linux jail. Platform is faked so this runs on any host.
describe('a workspace seat\'s read-outside and write-outside under bwrap', () => {
  const realPlatform = process.platform;
  let home;
  beforeEach(async () => {
    const fs = await import('fs');
    const os = await import('os');
    const path = await import('path');
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bwrap-host-read-home-')));
    fs.mkdirSync(path.join(home, 'project'));
    Object.defineProperty(process, 'platform', { value: 'linux' });
  });
  afterEach(async () => {
    Object.defineProperty(process, 'platform', { value: realPlatform });
    const fs = await import('fs');
    fs.rmSync(home, { recursive: true, force: true });
  });
  const wrap = (filesystem, trust = 'workspace') => wrapArgvWithBwrap(
    ['claude'],
    { sandbox: { trust, filesystem } },
    { workspacePath: '/tmp/ws', hostReadHome: home },
  );

  test.each([
    ['.ssh'], ['.commonly/admin-token'], ['.commonly'], ['project/.env'], ['.SSH'], [''],
  ])('refuses read-outside <home>/%s', (sub) => {
    expect(() => wrap({ 'read-outside': [`${home}/${sub}`.replace(/\/$/, '')] }))
      .toThrow(/refusing sandbox\.filesystem\.read-outside/);
  });

  test.each([['/tmp'], ['/var/folders'], ['/']])('refuses read-outside %s', (entry) => {
    expect(() => wrap({ 'read-outside': [entry] })).toThrow(/refusing sandbox\.filesystem\.read-outside/);
  });

  // The F493 review: bwrap cannot hide the .env files beneath a wider bind, so
  // a project folder is refused here, and a writable folder outside the
  // project lets a seat plant a git hook the host later runs.
  test('refuses a project folder, which macOS admits with denies beneath it', () => {
    expect(() => wrap({ 'read-outside': [`${home}/project`] }))
      .toThrow(/only ~\/\.commonly\/logs can be named/);
  });

  test('refuses any write-outside', () => {
    expect(() => wrap({ 'write-outside': [`${home}/project`] }))
      .toThrow(/refusing sandbox\.filesystem\.write-outside/);
  });

  test('binds the CLI logs folder read-only, at its resolved path', () => {
    const argv = wrap({ 'read-outside': [`${home}/.commonly/logs`] });
    const idx = argv.indexOf(`${home}/.commonly/logs`);
    expect(argv[idx - 1]).toBe('--ro-bind-try');
  });

  // F494: bwrap resolves a path bind when the jail starts, after the check, so
  // a held read-outside folder is mounted from the descriptor the caller opened.
  describe('with the read-outside folders held as descriptors', () => {
    const logs = () => `${home}/.commonly/logs`;
    const triples = (argv) => argv.flatMap((arg, i) => (
      /^--(ro-)?bind(-fd|-try)?$/.test(arg) ? [[arg, argv[i + 1], argv[i + 2]]] : []));
    const wrapHeld = (readOutside) => wrapArgvWithBwrap(
      ['claude'],
      { sandbox: { trust: 'workspace', filesystem: { 'read-outside': [logs()] } } },
      { workspacePath: '/tmp/ws', hostReadHome: home, bindFds: { workspace: 3, readOutside } },
    );

    test('mounts a held folder from its descriptor, with no path bind for it', () => {
      const argv = wrapHeld({ [logs()]: 5 });
      expect(triples(argv)).toContainEqual(['--ro-bind-fd', '5', logs()]);
      expect(argv.filter((arg, i) => arg === logs() && argv[i - 1] === '--ro-bind-try')).toEqual([]);
    });

    test('binds nothing for a folder that was missing when it was opened', () => {
      const argv = wrapHeld({ [logs()]: null });
      expect(argv).not.toContain(logs());
    });

    test('refuses a folder that resolves to a path the caller did not hold', () => {
      expect(() => wrapHeld({ [`${home}/.commonly/other`]: 5 }))
        .toThrow(/resolved differently from the folder that was opened/);
    });

    // F494 review: a folder swapped for a link to another held one resolves to
    // one path, and the other descriptor would reach the jail with no bind.
    test('refuses a held folder that no longer resolves to any bind', () => {
      const argv = () => wrapArgvWithBwrap(
        ['claude'],
        { sandbox: { trust: 'workspace', filesystem: { 'read-outside': [logs()] } } },
        {
          workspacePath: '/tmp/ws',
          hostReadHome: home,
          bindFds: { workspace: 3, readOutside: { [logs()]: 5, [`${logs()}/b`]: 6 } },
        },
      );
      expect(argv).toThrow(/held for read-outside but no longer resolves/);
    });

    test('a held folder that was missing at open needs no bind', () => {
      const argv = wrapArgvWithBwrap(
        ['claude'],
        { sandbox: { trust: 'workspace', filesystem: { 'read-outside': [logs()] } } },
        {
          workspacePath: '/tmp/ws',
          hostReadHome: home,
          bindFds: { workspace: 3, readOutside: { [logs()]: 5, [`${logs()}/gone`]: null } },
        },
      );
      expect(argv).toContain('--ro-bind-fd');
    });

    test('refuses a descriptor below 3', () => {
      expect(() => wrapHeld({ [logs()]: 2 })).toThrow(/child descriptors of 3 or more/);
    });
  });

  test('compares case as it is: /VAR/LOG is not the system log folder on Linux', () => {
    expect(() => wrap({ 'read-outside': [`${home}/.Commonly/Logs`] })).toThrow(/refusing/);
  });

  test.each([['read-outside'], ['write-outside']])('a public seat refuses any %s', (key) => {
    expect(() => wrap({ [key]: [`${home}/.commonly/logs`] }, 'public'))
      .toThrow(new RegExp(`refusing sandbox\\.filesystem\\.${key}: a public seat`));
  });

  test('a public seat binds its own home through opts, before the read-only inputs inside it', () => {
    const input = `${home}/project/recipe`;
    const argv = wrapArgvWithBwrap(['opencode'], { sandbox: { trust: 'public' } }, {
      workspacePath: '/tmp/ws', homeWritablePaths: [`${home}/project`], readOnlyPaths: [input],
    });
    const homeAt = argv.indexOf(`${home}/project`);
    expect(argv[homeAt - 1]).toBe('--bind-try');
    expect(argv.indexOf(input)).toBeGreaterThan(homeAt);
  });

  test('a seat of your own (no trust) keeps its declared binds, ~/.local/bin included', () => {
    const argv = wrap({ 'read-outside': [`${home}/.local/bin`] }, null);
    expect(argv).toContain(`${home}/.local/bin`);
  });
});
