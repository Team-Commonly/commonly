import { describe, it, expect } from 'vitest';
import { makeToolBudget, runTurn } from '../src/turn';
import { renderPodContext, RENDER_CHAR_CAP } from '../src/tools';

describe('per-turn tool budget (the #1340 blocker)', () => {
  it('allows N calls, then blocks with terminate', async () => {
    const b = makeToolBudget(2);
    expect(await b.beforeToolCall()).toBeUndefined();
    expect(await b.shouldStopAfterTurn()).toBe(false);
    expect(await b.beforeToolCall()).toBeUndefined();
    expect(await b.shouldStopAfterTurn()).toBe(true);
    const third = await b.beforeToolCall();
    expect(third).toMatchObject({ block: true, terminate: true });
  });

  it('runTurn wires the budget hooks and an abort signal into the loop', async () => {
    let cfgSeen: { beforeToolCall?: unknown; shouldStopAfterTurn?: unknown } = {};
    let signalSeen: AbortSignal | undefined;
    const loop = (async (_p: unknown, _c: unknown, config: typeof cfgSeen, _e: unknown, signal: AbortSignal) => {
      cfgSeen = config; signalSeen = signal;
      return [{ role: 'assistant', content: [{ type: 'text', text: 'ok' }] }];
    }) as never;
    const storage = { get: async () => undefined, put: async () => {} } as unknown as DurableObjectStorage;
    await runTurn({ storage, apiKey: 'k', systemPrompt: 's', loop, maxToolCalls: 3 }, 'hi');
    expect(typeof cfgSeen.beforeToolCall).toBe('function');
    expect(typeof cfgSeen.shouldStopAfterTurn).toBe('function');
    expect(signalSeen).toBeInstanceOf(AbortSignal);
  });

  it('runTurn aborts the loop on the wall-clock timeout', async () => {
    const loop = (async (_p: unknown, _c: unknown, _cfg: unknown, _e: unknown, signal: AbortSignal) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason));
    })) as never;
    const storage = { get: async () => undefined, put: async () => {} } as unknown as DurableObjectStorage;
    await expect(runTurn({ storage, apiKey: 'k', systemPrompt: 's', loop, timeoutMs: 20 }, 'hi')).rejects.toThrow(/exceeded 90000ms|exceeded/);
  });
});

describe('renderPodContext cap', () => {
  it('truncates a huge render at RENDER_CHAR_CAP', () => {
    const ctx = { recentMessages: Array.from({ length: 50 }, () => ({ senderName: 'x', content: 'y'.repeat(600) })) };
    const out = renderPodContext(ctx, 50);
    expect(out.length).toBeLessThanOrEqual(RENDER_CHAR_CAP + 20);
    expect(out.endsWith('…(truncated)')).toBe(true);
  });
});
