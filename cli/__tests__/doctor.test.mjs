import {
  checkAdapters,
  checkDaemon,
  checkInstall,
  checkLogin,
  checkMacClaude,
  checkNode,
  doctorExitCode,
  enginesFloor,
  findOnPath,
  formatDoctorLine,
  runDoctor,
  FAIL,
  PASS,
  SKIP,
} from '../src/lib/doctor.js';

// TASK-660 item 2: every check passes and fails here against a faked
// environment. Nothing in this file reads the real PATH, keychain, network,
// daemon record or adapter CLIs.

const NOW = Date.parse('2026-10-31T12:00:00Z');

describe('(a) node', () => {
  test('passes at or above the engines floor', () => {
    expect(checkNode({ nodeVersion: '22.3.0', enginesRange: '>=20.0.0' })).toMatchObject({ status: PASS });
    expect(checkNode({ nodeVersion: '20.0.0', enginesRange: '>=20' })).toMatchObject({ status: PASS });
  });

  test('fails below it, naming the floor', () => {
    const r = checkNode({ nodeVersion: '18.19.1', enginesRange: '>=20.0.0' });
    expect(r).toMatchObject({ status: FAIL, fix: 'install Node 20 or newer' });
    expect(r.detail).toContain('18.19.1');
  });

  test('skips a range it cannot read as a floor', () => {
    expect(checkNode({ nodeVersion: '22.0.0', enginesRange: '^20 || ^22' })).toMatchObject({ status: SKIP });
    expect(enginesFloor('>= 20.1')).toEqual([20, 1, 0]);
  });
});

describe('(b) install', () => {
  const fakeFs = (paths) => (p) => paths.includes(p);

  test('passes with the first commonly on PATH and its version', () => {
    const r = checkInstall({
      pathValue: '/nope:/opt/homebrew/bin:/usr/local/bin',
      platform: 'darwin',
      isExecutable: fakeFs(['/opt/homebrew/bin/commonly', '/usr/local/bin/commonly']),
      runVersion: (bin) => (bin === '/opt/homebrew/bin/commonly' ? '0.1.210' : '0.1.100'),
      runningVersion: '0.1.210',
    });
    expect(r.status).toBe(PASS);
    expect(r.detail).toBe('commonly 0.1.210 at /opt/homebrew/bin/commonly (1 more on PATH)');
  });

  test('says when the doctor running is not the commonly on PATH', () => {
    const r = checkInstall({
      pathValue: '/bin', platform: 'linux', isExecutable: fakeFs(['/bin/commonly']), runVersion: () => '0.1.161', runningVersion: '0.1.210',
    });
    expect(r.detail).toContain('this doctor is 0.1.210');
  });

  test('fails when nothing is on PATH', () => {
    expect(checkInstall({
      pathValue: '/a:/b', platform: 'darwin', isExecutable: () => false, runVersion: () => '1.0.0',
    })).toMatchObject({ status: FAIL, fix: 'npm install -g @commonlyai/cli' });
  });

  test('fails when the binary does not answer --version', () => {
    expect(checkInstall({
      pathValue: '/a', platform: 'darwin', isExecutable: fakeFs(['/a/commonly']), runVersion: () => null,
    })).toMatchObject({ status: FAIL });
  });

  test('looks for the .cmd shim on Windows', () => {
    expect(findOnPath({
      command: 'commonly', pathValue: 'C:\\npm;C:\\other', platform: 'win32', isExecutable: (p) => p.endsWith('commonly.cmd'),
    })).toHaveLength(2);
  });
});

describe('(c) login', () => {
  const instance = { key: 'default', url: 'https://api.commonly.me', hasToken: true };

  test('passes with the token\'s user, and never prints the token', async () => {
    const r = await checkLogin({ instance, fetchUser: async () => ({ username: 'lily-shen', token: 'cm_secret' }) });
    expect(r).toMatchObject({ status: PASS, detail: '@lily-shen on default (https://api.commonly.me)' });
    expect(JSON.stringify(r)).not.toContain('cm_secret');
  });

  test('fails when not logged in', async () => {
    expect(await checkLogin({ instance: null, fetchUser: async () => ({}) })).toMatchObject({ status: FAIL, fix: 'commonly login' });
  });

  test('fails when the saved instance has no token, without calling the server', async () => {
    let called = false;
    const r = await checkLogin({ instance: { ...instance, hasToken: false }, fetchUser: async () => { called = true; } });
    expect(r).toMatchObject({ status: FAIL, fix: 'commonly login --instance default' });
    expect(called).toBe(false);
  });

  test('fails when the server rejects the token', async () => {
    const r = await checkLogin({ instance, fetchUser: async () => { throw Object.assign(new Error('Session expired'), { status: 401 }); } });
    expect(r).toMatchObject({ status: FAIL, detail: 'default (https://api.commonly.me) rejected the saved token' });
  });

  test('fails when the server cannot be reached', async () => {
    const r = await checkLogin({ instance, fetchUser: async () => { throw new TypeError('fetch failed'); } });
    expect(r.status).toBe(FAIL);
    expect(r.detail).toContain('could not reach https://api.commonly.me');
  });
});

describe('(d) daemon', () => {
  const record = { machineName: 'Lab Mac', machineDbId: 'm1', machineId: 'mid' };
  const deps = (overrides = {}) => ({
    loadRecord: () => record,
    serviceFile: '/home/x/Library/LaunchAgents/me.commonly.daemon.plist',
    fileExists: () => true,
    fetchMachine: async () => ({ name: 'Lab Mac', status: 'online', lastSeenAt: new Date(NOW - 15_000).toISOString() }),
    describeError: (e) => `Daemon status failed: ${e.message}`,
    now: NOW,
    ...overrides,
  });

  test('passes when registered, installed and online', async () => {
    expect(await checkDaemon(deps())).toMatchObject({
      status: PASS, detail: 'Lab Mac online, service installed, last heartbeat 15s ago',
    });
  });

  test('skips when no daemon is registered', async () => {
    expect(await checkDaemon(deps({ loadRecord: () => null }))).toMatchObject({ status: SKIP });
  });

  test('fails when the record is unreadable or insecure', async () => {
    const r = await checkDaemon(deps({ loadRecord: () => { throw new Error('Daemon credential file permissions are insecure'); } }));
    expect(r).toMatchObject({ status: FAIL });
    expect(r.detail).toContain('insecure');
  });

  test('fails when the login service is not installed', async () => {
    expect(await checkDaemon(deps({ fileExists: () => false }))).toMatchObject({ status: FAIL, fix: 'commonly daemon install' });
  });

  test('fails when the server sees it offline, with the heartbeat age', async () => {
    const r = await checkDaemon(deps({
      fetchMachine: async () => ({ name: 'Lab Mac', status: 'offline', lastSeenAt: new Date(NOW - 3 * 3600_000).toISOString() }),
    }));
    expect(r).toMatchObject({ status: FAIL, detail: 'Lab Mac is offline, last heartbeat 3h ago' });
  });

  test('fails with the daemon status wording when the key is revoked', async () => {
    const r = await checkDaemon(deps({
      fetchMachine: async () => { throw new Error('revoked'); },
      describeError: () => "This computer's old key was revoked. Run: commonly daemon register",
    }));
    expect(r).toMatchObject({ status: FAIL, detail: "This computer's old key was revoked. Run: commonly daemon register" });
  });
});

describe('(e) adapters', () => {
  const registry = {
    claude: { detect: async () => ({ path: '/opt/homebrew/bin/claude', version: '2.5.1' }) },
    codex: { detect: async () => null },
    stub: {},
  };
  const getAdapter = (name) => registry[name] || null;

  test('one pass line per adapter in use, naming its agents', async () => {
    const results = await checkAdapters({ agents: [{ name: 'otto', adapter: 'claude' }, { name: 'anvil', adapter: 'claude' }], getAdapter });
    expect(results).toEqual([{
      id: 'adapter:claude', status: PASS, detail: 'claude 2.5.1 at /opt/homebrew/bin/claude, used by anvil, otto',
    }]);
  });

  test('fails an adapter whose CLI is missing or does not answer --version', async () => {
    const [r] = await checkAdapters({ agents: [{ name: 'vera', adapter: 'codex' }], getAdapter });
    expect(r).toMatchObject({ id: 'adapter:codex', status: FAIL });
  });

  test('fails an adapter whose detect throws', async () => {
    const [r] = await checkAdapters({
      agents: [{ name: 'a', adapter: 'claude' }],
      getAdapter: () => ({ detect: async () => { throw new Error('ENOENT'); } }),
    });
    expect(r.status).toBe(FAIL);
  });

  test('fails an adapter name this CLI does not know', async () => {
    const [r] = await checkAdapters({ agents: [{ name: 'x', adapter: 'gemini' }], getAdapter });
    expect(r).toMatchObject({ status: FAIL });
    expect(r.detail).toContain("unknown adapter 'gemini'");
  });

  test('fails a token file that records no adapter', async () => {
    const [r] = await checkAdapters({ agents: [{ name: 'old', adapter: '?' }], getAdapter });
    expect(r).toMatchObject({ id: 'adapter:?', status: FAIL });
    expect(r.detail).toContain('no adapter recorded');
  });

  test('names at most five agents, then counts the rest', async () => {
    const agents = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((name) => ({ name, adapter: 'claude' }));
    const [r] = await checkAdapters({ agents, getAdapter });
    expect(r.detail).toMatch(/used by a, b, c, d, e and 2 more$/);
  });

  test('skips an adapter with no local CLI, and skips when no agents are attached', async () => {
    expect((await checkAdapters({ agents: [{ name: 's', adapter: 'stub' }], getAdapter }))[0].status).toBe(SKIP);
    expect(await checkAdapters({ agents: [], getAdapter })).toEqual([expect.objectContaining({ status: SKIP })]);
  });
});

describe('(f) macOS claude prerequisites', () => {
  const keychain = '/Users/x/Library/Keychains/login.keychain-db';
  const deps = (overrides = {}) => ({
    platform: 'darwin',
    agents: [{ name: 'otto', adapter: 'claude' }],
    detectSeatbelt: () => ({ available: true, path: '/usr/bin/sandbox-exec' }),
    isFile: (p) => [keychain, '/usr/bin/security'].includes(p),
    loginKeychainPath: keychain,
    ...overrides,
  });

  test('passes when Seatbelt runs and both files exist', () => {
    expect(checkMacClaude(deps())).toMatchObject({ status: PASS });
  });

  test('fails naming every missing prerequisite', () => {
    const r = checkMacClaude(deps({
      detectSeatbelt: () => ({ available: false, error: 'sandbox-exec preflight failed: exit 71' }),
      isFile: () => false,
    }));
    expect(r.status).toBe(FAIL);
    expect(r.detail).toContain('Seatbelt (sandbox-exec preflight failed: exit 71)');
    expect(r.detail).toContain(`login keychain (${keychain})`);
    expect(r.detail).toContain('/usr/bin/security');
  });

  test('fails when the Seatbelt probe throws', () => {
    expect(checkMacClaude(deps({ detectSeatbelt: () => { throw new Error('spawn EPERM'); } })).status).toBe(FAIL);
  });

  test('skips off macOS and when no agent uses claude', () => {
    expect(checkMacClaude(deps({ platform: 'linux' }))).toMatchObject({ status: SKIP, detail: 'not macOS' });
    expect(checkMacClaude(deps({ agents: [{ name: 'v', adapter: 'codex' }] }))).toMatchObject({ status: SKIP });
  });

  test('only stats files: it is handed no way to run security', () => {
    const touched = [];
    checkMacClaude(deps({ isFile: (p) => { touched.push(p); return true; } }));
    expect(touched).toEqual([keychain, '/usr/bin/security']);
  });
});

describe('runDoctor', () => {
  const healthy = () => ({
    listAgents: () => [{ name: 'otto', adapter: 'claude' }],
    getAdapter: () => ({ detect: async () => ({ path: '/bin/claude', version: '2.5.1' }) }),
    node: { nodeVersion: '22.0.0', enginesRange: '>=20.0.0' },
    install: { pathValue: '/bin', platform: 'darwin', isExecutable: () => true, runVersion: () => '0.1.210', runningVersion: '0.1.210' },
    login: { instance: { key: 'default', url: 'https://api.commonly.me', hasToken: true }, fetchUser: async () => ({ username: 'otto' }) },
    daemon: {
      loadRecord: () => ({ machineName: 'Mac' }),
      serviceFile: '/s',
      fileExists: () => true,
      fetchMachine: async () => ({ name: 'Mac', status: 'online', lastSeenAt: new Date(NOW).toISOString() }),
      describeError: (e) => e.message,
      now: NOW,
    },
    macos: { platform: 'darwin', detectSeatbelt: () => ({ available: true }), isFile: () => true, loginKeychainPath: '/k' },
  });

  test('all checks pass: one line each, in order, exit 0', async () => {
    const results = await runDoctor(healthy());
    expect(results.map((r) => r.id)).toEqual(['node', 'install', 'login', 'daemon', 'adapter:claude', 'macos-claude']);
    expect(results.every((r) => r.status === PASS)).toBe(true);
    expect(doctorExitCode(results)).toBe(0);
  });

  test('any fail gives exit 1; skips alone do not', async () => {
    const deps = healthy();
    deps.daemon.loadRecord = () => null;
    expect(doctorExitCode(await runDoctor(deps))).toBe(0);
    deps.login.instance = null;
    expect(doctorExitCode(await runDoctor(deps))).toBe(1);
  });
});

test('formatDoctorLine shows the fix only on a fail', () => {
  expect(formatDoctorLine({ id: 'login', status: FAIL, detail: 'not logged in', fix: 'commonly login' }))
    .toBe('fail  login            not logged in — fix: commonly login');
  expect(formatDoctorLine({ id: 'node', status: PASS, detail: 'Node 22.0.0', fix: 'x' }))
    .toBe('pass  node             Node 22.0.0');
});
