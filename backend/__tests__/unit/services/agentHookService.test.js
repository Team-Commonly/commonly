const {
  evaluatePreToolUse,
  processHookEvent,
  resetHookReplay,
  setHookLedgerStore,
  resolvePathWithinRoot,
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
      provider: async () => [{ agentId: 'seat-2', agentName: 'aria', paths: ['backend'], expiresAt: new Date(Date.now() + 10000) }],
    });
    expect(result.statusCode).toBe(200);
    expect(result.decision).toMatchObject({ permissionDecision: 'deny', holder: 'aria' });
  });

  test('uses the seat id, not the shared runtime name, for claim ownership', async () => {
    const provider = async () => [{ agentId: 'seat-2', agentName: 'openclaw', paths: ['src'] }];
    const foreign = await evaluatePreToolUse({
      podId: 'p1', agentId: 'seat-1', agentName: 'openclaw', event: 'PreToolUse', eventId: 'e-id-1',
      payload: { paths: ['src/file.ts'] }, provider,
    });
    const own = await evaluatePreToolUse({
      podId: 'p1', agentId: 'seat-2', agentName: 'openclaw', event: 'PreToolUse', eventId: 'e-id-2',
      payload: { paths: ['src/file.ts'] }, provider,
    });
    expect(foreign.decision).toMatchObject({ permissionDecision: 'deny', holder: 'openclaw' });
    expect(own.decision.permissionDecision).toBe('allow');
  });

  test('an unattributed claim never denies its holder', async () => {
    const result = await evaluatePreToolUse({
      podId: 'p1', agentId: 'seat-1', agentName: 'nova', event: 'PreToolUse', eventId: 'e-unattributed',
      payload: { paths: ['src/file.ts'] },
      provider: async () => [{ agentName: 'nova', paths: ['src'] }],
    });
    expect(result.decision.permissionDecision).toBe('allow');
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

  test('rejects absolute and parent-traversal paths without filesystem access', () => {
    expect(resolvePathWithinRoot('/tmp/outside')).toBeNull();
    expect(resolvePathWithinRoot('../outside')).toBeNull();
    expect(resolvePathWithinRoot('src/../outside')).toBeNull();
  });

  test('replays PreToolUse per pod, seat, and eventId without consulting the provider', async () => {
    let calls = 0;
    const provider = async () => { calls += 1; return []; };
    const options = {
      podId: 'p1', agentId: 'seat-1', agentName: 'openclaw', event: 'PreToolUse', eventId: 'same',
      payload: { paths: ['src/file.ts'] }, provider,
    };
    const first = await processHookEvent(options);
    const second = await processHookEvent(options);
    const otherSeat = await processHookEvent({ ...options, agentId: 'seat-2' });
    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(otherSeat.replayed).toBe(false);
    expect(calls).toBe(2);
  });
});
