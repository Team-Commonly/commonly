/**
 * D343 spike: OpenShell as the run-code sandbox, behind OPENSHELL_SANDBOX_ENABLED.
 * Same contract as the E2B TurnSandbox: one sandbox per turn, no egress, no
 * environment, deleted when the turn ends. The CLI is injected, so these tests
 * check the calls the driver makes; docs/plans/openshell-spike.md has the live run.
 */
const {
  OpenShellTurnSandbox, MAX_RUNS_PER_TURN, SANDBOX_BUSY_MESSAGE, REFUSED_FRONT_PORTS,
  isOpenShellSandboxEnabled, buildSandboxPolicy, cliEnv,
} = require('../../../services/openshellTurnSandbox');

const ok = (stdout = '', stderr = '') => ({
  code: 0, stdout, stderr, timedOut: false,
});

// A fake CLI: create succeeds, get answers Ready, exec echoes, delete succeeds.
const fakeCli = (overrides = {}) => jest.fn(async (args) => {
  const [, verb] = args;
  if (overrides[verb]) return overrides[verb](args);
  if (verb === 'get') return ok('{"phase": "Ready"}');
  if (verb === 'exec') return ok('45\n');
  return ok();
});
const verbs = (cli) => cli.mock.calls.map(([args]) => args[1]);

describe('OpenShellTurnSandbox', () => {
  const previous = { ...process.env };

  beforeEach(() => {
    process.env.OPENSHELL_SANDBOX_ENABLED = 'true';
    process.env.OPENSHELL_SANDBOX_IMAGE = 'commonly/runcode@sha256:abc';
    delete process.env.OPENSHELL_SANDBOX_POLICY_FILE;
  });

  afterAll(() => {
    process.env = previous;
  });

  test('the first run creates one sandbox from the configured image, with a policy, a lifetime and limits', async () => {
    const cli = fakeCli();
    const sandbox = new OpenShellTurnSandbox({ podId: 'p1', agent: 'a:default' }, { cli, pollMs: 0 });
    const result = await sandbox.run('python', 'print(sum(range(10)))');

    expect(result).toEqual({ ok: true, stdout: '45\n', stderr: '' });
    const create = cli.mock.calls[0][0];
    expect(create.slice(0, 2)).toEqual(['sandbox', 'create']);
    expect(create[create.indexOf('--from') + 1]).toBe('commonly/runcode@sha256:abc');
    expect(create).toContain('--policy');
    expect(create).toContain('--no-keep');
    // The live CLI (0.1.9) refuses --no-keep together with --output.
    expect(create).not.toContain('--output');
    expect(create[create.indexOf('--memory') + 1]).toBe('512Mi');
    expect(create.slice(create.indexOf('--'))).toEqual(['--', 'sleep', '180']);
    // No --env, ever: nothing secret goes into the sandbox.
    expect(create).not.toContain('--env');
  });

  test('code goes in on stdin to the language interpreter, with a timeout', async () => {
    const cli = fakeCli();
    const sandbox = new OpenShellTurnSandbox({}, { cli, pollMs: 0 });
    await sandbox.run('javascript', 'console.log(1)');
    const [execArgs, execOpts] = cli.mock.calls.find(([args]) => args[1] === 'exec');
    expect(execArgs.slice(execArgs.indexOf('--'))).toEqual(['--', 'node', '-']);
    expect(execArgs[execArgs.indexOf('--timeout') + 1]).toBe('30');
    expect(execArgs).not.toContain('--env');
    expect(execOpts.input).toBe('console.log(1)');
  });

  test('later runs reuse the sandbox, and close deletes it and returns 0', async () => {
    const cli = fakeCli();
    const sandbox = new OpenShellTurnSandbox({}, { cli, pollMs: 0 });
    await sandbox.run('python', 'print(1)');
    await sandbox.run('python', 'print(2)');
    expect(await sandbox.close()).toBe(0);
    expect(verbs(cli).filter((v) => v === 'create')).toHaveLength(1);
    expect(verbs(cli).filter((v) => v === 'exec')).toHaveLength(2);
    expect(cli.mock.calls.at(-1)[0].slice(0, 2)).toEqual(['sandbox', 'delete']);
  });

  test('close without a run touches nothing', async () => {
    const cli = fakeCli();
    expect(await new OpenShellTurnSandbox({}, { cli }).close()).toBe(0);
    expect(cli).not.toHaveBeenCalled();
  });

  test('a failed delete is logged, never thrown', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const cli = fakeCli({
      delete: async () => ({
        code: 1, stdout: '', stderr: 'gone', timedOut: false, 
      }), 
    });
    const sandbox = new OpenShellTurnSandbox({}, { cli, pollMs: 0 });
    await sandbox.run('python', 'print(1)');
    await expect(sandbox.close()).resolves.toBe(0);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  test('a sandbox that ends in Error is the busy line, deleted, and a later run tries again', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    let phase = 'Error';
    const cli = fakeCli({ get: async () => ok(`{"phase": "${phase}"}`) });
    const sandbox = new OpenShellTurnSandbox({}, { cli, pollMs: 0 });
    expect(await sandbox.run('python', 'print(1)')).toEqual({
      ok: false, stdout: '', stderr: '', error: SANDBOX_BUSY_MESSAGE,
    });
    expect(verbs(cli)).toContain('delete');
    phase = 'Ready';
    expect((await sandbox.run('python', 'print(1)')).ok).toBe(true);
    expect(verbs(cli).filter((v) => v === 'create')).toHaveLength(2);
    warn.mockRestore();
  });

  test('a refused create is the busy line', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const cli = fakeCli({
      create: async () => ({
        code: 1, stdout: '', stderr: 'quota', timedOut: false, 
      }), 
    });
    const result = await new OpenShellTurnSandbox({}, { cli, pollMs: 0 }).run('python', 'print(1)');
    expect(result.error).toBe(SANDBOX_BUSY_MESSAGE);
    expect(verbs(cli)).not.toContain('exec');
    warn.mockRestore();
  });

  test('the CLI refusing its own arguments is a fault, not the busy line', async () => {
    const cli = fakeCli({
      create: async () => ({
        code: 2, stdout: '', stderr: 'error: unexpected argument', timedOut: false, 
      }), 
    });
    await expect(new OpenShellTurnSandbox({}, { cli, pollMs: 0 }).run('python', 'print(1)'))
      .rejects.toThrow(/refused the create arguments/);
    const gateway = fakeCli({
      create: async () => ({
        code: 1, stdout: '', stderr: "code: 'Client specified an invalid argument'", timedOut: false, 
      }), 
    });
    await expect(new OpenShellTurnSandbox({}, { cli: gateway, pollMs: 0 }).run('python', 'print(1)'))
      .rejects.toThrow(/refused the create arguments/);
  });

  test('the sandbox name fits the gateway cap of 19 characters', async () => {
    const cli = fakeCli();
    await new OpenShellTurnSandbox({}, { cli, pollMs: 0 }).run('python', 'print(1)');
    const create = cli.mock.calls[0][0];
    const name = create[create.indexOf('--name') + 1];
    expect(name).toMatch(/^cm-turn-[0-9a-f]{10}$/);
    expect(name.length).toBeLessThanOrEqual(19);
  });

  test('a non-zero exit is not ok, and a run past the timeout says so', async () => {
    let next = {
      code: 1, stdout: '', stderr: 'Traceback: boom', timedOut: false, 
    };
    const cli = fakeCli({ exec: async () => next });
    const sandbox = new OpenShellTurnSandbox({}, { cli, pollMs: 0 });
    expect(await sandbox.run('python', 'raise SystemExit(1)')).toEqual({
      ok: false, stdout: '', stderr: 'Traceback: boom', error: 'exited with code 1',
    });
    next = {
      code: null, stdout: 'partial', stderr: '', timedOut: true, 
    };
    expect(await sandbox.run('python', 'while True: pass')).toEqual({
      ok: false, stdout: 'partial', stderr: '', error: 'code ran past 30s',
    });
    // OpenShell's own --timeout ends the command with exit 124.
    next = {
      code: 124, stdout: 'start\n', stderr: '', timedOut: false, 
    };
    expect(await sandbox.run('python', 'while True: pass')).toEqual({
      ok: false, stdout: 'start\n', stderr: '', error: 'code ran past 30s',
    });
  });

  test('output is clipped to the E2B limits', async () => {
    const cli = fakeCli({ exec: async () => ok('x'.repeat(5000), 'y'.repeat(3000)) });
    const result = await new OpenShellTurnSandbox({}, { cli, pollMs: 0 }).run('python', 'print(1)');
    expect(result.stdout).toMatch(/^x{4000}\n… \[1000 more characters\]$/);
    expect(result.stderr).toMatch(/^y{2000}\n… \[1000 more characters\]$/);
  });

  test('bad input is refused before any sandbox exists, and runs are capped per turn', async () => {
    const cli = fakeCli();
    const sandbox = new OpenShellTurnSandbox({}, { cli, pollMs: 0 });
    expect((await sandbox.run('ruby', 'puts 1')).error).toMatch(/language must be one of/);
    expect((await sandbox.run('python', '   ')).error).toBe('code is empty');
    expect((await sandbox.run('python', 'x'.repeat(20001))).error).toMatch(/longer than/);
    expect(cli).not.toHaveBeenCalled();
    await Array.from({ length: MAX_RUNS_PER_TURN }).reduce(
      (prev) => prev.then(() => sandbox.run('python', 'print(1)')),
      Promise.resolve(),
    );
    expect((await sandbox.run('python', 'print(1)')).error).toMatch(/code runs/);
  });
});

describe('buildSandboxPolicy', () => {
  test('the run-code policy has no network rule', () => {
    const policy = buildSandboxPolicy();
    expect(policy).toContain('network_policies: {}');
    expect(policy).not.toContain('host:');
  });

  test('front ports become host.openshell.internal rules, and host service ports are refused', () => {
    const policy = buildSandboxPolicy({ frontPorts: [18100, 18102] });
    expect(policy).toContain('{ host: host.openshell.internal, port: 18100 }');
    expect(policy).toContain('{ host: host.openshell.internal, port: 18102 }');
    REFUSED_FRONT_PORTS.forEach((port) => {
      expect(() => buildSandboxPolicy({ frontPorts: [port] })).toThrow(/refused/);
    });
    expect(REFUSED_FRONT_PORTS).toEqual(expect.arrayContaining([5432, 27017, 8080]));
    expect(() => buildSandboxPolicy({ frontPorts: [0] })).toThrow(/not a port/);
  });
});

describe('the flag and the CLI environment', () => {
  const previous = { ...process.env };
  afterEach(() => { process.env = { ...previous }; });

  test('the driver is on only with the exact flag and an image', () => {
    delete process.env.OPENSHELL_SANDBOX_ENABLED;
    process.env.OPENSHELL_SANDBOX_IMAGE = 'img';
    expect(isOpenShellSandboxEnabled()).toBe(false);
    process.env.OPENSHELL_SANDBOX_ENABLED = '1';
    expect(isOpenShellSandboxEnabled()).toBe(false);
    process.env.OPENSHELL_SANDBOX_ENABLED = 'true';
    expect(isOpenShellSandboxEnabled()).toBe(true);
    delete process.env.OPENSHELL_SANDBOX_IMAGE;
    expect(isOpenShellSandboxEnabled()).toBe(false);
  });

  test('the CLI never inherits the backend environment', () => {
    const env = cliEnv({
      PATH: '/usr/bin',
      HOME: '/home/app',
      OPENSHELL_GATEWAY_ENDPOINT: 'http://gw:8080',
      JWT_SECRET: 's',
      LITELLM_MASTER_KEY: 'k',
      E2B_API_KEY: 'e',
      MONGO_URI: 'mongodb://u:p@h',
    });
    expect(env).toEqual({ PATH: '/usr/bin', HOME: '/home/app', OPENSHELL_GATEWAY_ENDPOINT: 'http://gw:8080' });
  });
});
