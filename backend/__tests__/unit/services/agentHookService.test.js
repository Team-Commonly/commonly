const {
  evaluatePreToolUse,
  processHookEvent,
  resetHookReplay,
  setHookLedgerStore,
} = require('../../../services/agentHookService');

describe('agent hook claim policy', () => {
  const rootDir = process.cwd();
  const ledger = new Map();

  beforeEach(async () => {
    ledger.clear();
    setHookLedgerStore({
      find: async (key) => ledger.get(JSON.stringify(key)) || null,
      insertOrGet: async (key, value) => {
        const serialized = JSON.stringify(key);
        if (!ledger.has(serialized)) ledger.set(serialized, value);
        return ledger.get(serialized);
      },
      clear: async () => ledger.clear(),
    });
    await resetHookReplay();
  });

  afterAll(() => setHookLedgerStore(null));

  test('denies only a foreign active claim covering a resolved path', async () => {
    const result = await evaluatePreToolUse({
      podId: 'p1', agentName: 'nova', event: 'PreToolUse', eventId: 'e1', rootDir,
      payload: { paths: ['backend/server.ts'] },
      provider: async () => [{ agentName: 'aria', paths: ['backend'], expiresAt: new Date(Date.now() + 10_000) }],
    });
    expect(result.statusCode).toBe(200);
    expect(result.decision).toMatchObject({ permissionDecision: 'deny', holder: 'aria' });
  });

  test('allows own coverage and unknown paths', async () => {
    const own = await evaluatePreToolUse({
      podId: 'p1', agentName: 'nova', event: 'PreToolUse', eventId: 'e1', rootDir,
      payload: { paths: ['backend/server.ts'] },
      provider: async () => [{ agentName: 'nova', paths: ['backend'] }],
    });
    expect(own.decision.permissionDecision).toBe('allow');

    const unknown = await evaluatePreToolUse({
      podId: 'p1', agentName: 'nova', event: 'PreToolUse', eventId: 'e2', rootDir,
      payload: { paths: ['../../outside'] },
      provider: async () => { throw new Error('ledger unavailable'); },
    });
    expect(unknown.decision.permissionDecision).toBe('allow');
  });

  test('replays per pod, agent, and eventId without consulting the provider', async () => {
    let calls = 0;
    const provider = async () => { calls += 1; return []; };
    const options = {
      podId: 'p1', agentName: 'nova', event: 'PostToolUse', eventId: 'same', payload: {}, provider,
    };
    const first = await processHookEvent(options);
    const second = await processHookEvent(options);
    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(calls).toBe(0);
  });
});
