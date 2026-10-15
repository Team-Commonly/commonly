/**
 * TASK-266: one E2B sandbox per native turn, no internet, no environment,
 * closed when the turn ends, with E2B's lifetime as the backstop.
 */
const mockRunCode = jest.fn();
const mockKill = jest.fn();
const mockCreate = jest.fn();
jest.mock('@e2b/code-interpreter', () => ({
  Sandbox: { create: (...args) => mockCreate(...args) },
}));

const { TurnSandbox, MAX_RUNS_PER_TURN, isSandboxConfigured } = require('../../../services/turnSandboxService');

describe('TurnSandbox', () => {
  const previousKey = process.env.E2B_API_KEY;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.E2B_API_KEY = 'e2b_test_key';
    mockKill.mockResolvedValue(true);
    mockRunCode.mockResolvedValue({ logs: { stdout: ['4\n'], stderr: [] }, text: '4' });
    mockCreate.mockResolvedValue({ runCode: mockRunCode, kill: mockKill });
  });

  afterAll(() => {
    if (previousKey === undefined) delete process.env.E2B_API_KEY;
    else process.env.E2B_API_KEY = previousKey;
  });

  test('opens one sandbox for the whole turn, with no internet and no environment', async () => {
    const sandbox = new TurnSandbox({ podId: 'pod-1', agent: 'maya-agent:default' });
    const first = await sandbox.run('python', 'print(2 + 2)');
    await sandbox.run('javascript', 'console.log(1)');

    expect(first).toEqual({ ok: true, stdout: '4\n', stderr: '', result: '4' });
    expect(mockCreate).toHaveBeenCalledTimes(1);
    const [options] = mockCreate.mock.calls[0];
    expect(options).toMatchObject({
      apiKey: 'e2b_test_key',
      allowInternetAccess: false,
      network: { allowPublicTraffic: false },
      envs: {},
      metadata: { podId: 'pod-1' },
    });
    // Exact, not a subset: toMatchObject treats {} as matching any object, so
    // only these pin that nothing from the process env reaches the sandbox
    // (sprint-review on #2232).
    expect(options.envs).toEqual({});
    expect(mockRunCode.mock.calls.every(([, opts]) => Object.keys(opts.envs).length === 0)).toBe(true);
    expect(options.timeoutMs).toBeGreaterThan(0);
    expect(options.timeoutMs).toBeLessThanOrEqual(5 * 60 * 1000);
    expect(mockRunCode).toHaveBeenLastCalledWith('console.log(1)', expect.objectContaining({ language: 'javascript', envs: {} }));
  });

  test('close kills the sandbox and reports at least one second; a turn that ran no code opens nothing', async () => {
    const idle = new TurnSandbox({});
    expect(await idle.close()).toBe(0);
    expect(mockCreate).not.toHaveBeenCalled();

    const used = new TurnSandbox({});
    await used.run('python', 'print(1)');
    expect(await used.close()).toBeGreaterThanOrEqual(1);
    expect(mockKill).toHaveBeenCalledTimes(1);
  });

  test('a failed kill or a failed create never throws from close', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockKill.mockRejectedValueOnce(new Error('network'));
    const a = new TurnSandbox({});
    await a.run('python', 'print(1)');
    await expect(a.close()).resolves.toBeGreaterThanOrEqual(1);

    mockCreate.mockRejectedValueOnce(new Error('quota'));
    const b = new TurnSandbox({});
    await expect(b.run('python', 'print(1)')).rejects.toThrow('quota');
    await expect(b.close()).resolves.toBeGreaterThanOrEqual(1);
    warn.mockRestore();
  });

  test('reports a program error and clips long output', async () => {
    mockRunCode.mockResolvedValueOnce({
      logs: { stdout: ['x'.repeat(10_000)], stderr: [] },
      error: { name: 'ZeroDivisionError', value: 'division by zero', traceback: 'line 1' },
    });
    const result = await new TurnSandbox({}).run('python', '1/0');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/^ZeroDivisionError: division by zero/);
    expect(result.stdout.length).toBeLessThan(4200);
    expect(result.stdout).toMatch(/more characters\]$/);
  });

  test('refuses an unknown language, empty code, and runs past the per-turn limit, without opening a sandbox for them', async () => {
    const sandbox = new TurnSandbox({});
    expect(await sandbox.run('ruby', 'puts 1')).toMatchObject({ ok: false, error: expect.stringMatching(/language/) });
    expect(await sandbox.run('python', '   ')).toMatchObject({ ok: false, error: 'code is empty' });
    expect(mockCreate).not.toHaveBeenCalled();

    for (let i = 0; i < MAX_RUNS_PER_TURN; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      expect((await sandbox.run('python', 'print(1)')).ok).toBe(true);
    }
    expect(await sandbox.run('python', 'print(1)')).toMatchObject({ ok: false, error: expect.stringMatching(/code runs/) });
    expect(mockRunCode).toHaveBeenCalledTimes(MAX_RUNS_PER_TURN);
  });

  test('is configured only when the instance has an E2B key', () => {
    expect(isSandboxConfigured()).toBe(true);
    delete process.env.E2B_API_KEY;
    expect(isSandboxConfigured()).toBe(false);
  });
});
