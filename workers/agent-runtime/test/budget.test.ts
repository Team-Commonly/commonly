import { describe, it, expect } from 'vitest';
import { makeToolBudget, runTurn } from '../src/turn';
import { renderPodContext, RENDER_CHAR_CAP } from '../src/tools';

describe('per-turn tool budget (the #1340 blocker)', () => {
  it('past the budget it BLOCKS but keeps the turn alive so the model can answer; only a runaway terminates', async () => {
    const b = makeToolBudget(2, 1);
    expect(await b.beforeToolCall()).toBeUndefined();
    expect(await b.beforeToolCall()).toBeUndefined();
    const third = await b.beforeToolCall();
    expect(third).toMatchObject({ block: true });
    expect((third as { terminate?: boolean }).terminate).toBeUndefined();
    expect((third as { reason: string }).reason).toMatch(/Answer now/);
    const fourth = await b.beforeToolCall();
    expect(fourth).toMatchObject({ block: true, terminate: true });
    expect(b.runaway()).toBe(true);
  });

  it('an empty assistant answer is an error, never a substituted NO_REPLY', async () => {
    const loop = (async () => [{ role: 'assistant', content: [] }]) as never;
    const storage = { get: async () => undefined, put: async () => {} } as unknown as DurableObjectStorage;
    await expect(runTurn({ storage, apiKey: 'k', systemPrompt: 's', loop }, 'hi')).rejects.toThrow(/without assistant text/);
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
    expect(cfgSeen.shouldStopAfterTurn).toBeUndefined();
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
