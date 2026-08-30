import { describe, it, expect } from 'vitest';
import { runTurn, TRANSCRIPT_BYTE_BUDGET, byteBound } from '../src/turn';

// A Map-backed DurableObjectStorage double: only get/put are exercised.
const fakeStorage = () => {
  const m = new Map<string, unknown>();
  return {
    get: async (k: string) => m.get(k),
    put: async (k: string, v: unknown) => { m.set(k, v); },
    raw: m,
  } as unknown as DurableObjectStorage & { raw: Map<string, unknown> };
};

// A fake loop runner shaped like runAgentLoop: returns ONLY this turn's
// messages (prompt + one assistant reply), exactly as pi 0.84.2 does.
const fakeLoop = (reply: string) => (async (prompts: unknown[]) => [
  ...prompts,
  { role: 'assistant', content: [{ type: 'text', text: reply }], timestamp: Date.now() },
]) as never;

describe('runTurn storage round-trip (the #1339 blocker)', () => {
  it('APPENDS each turn to the persisted transcript instead of overwriting it', async () => {
    const storage = fakeStorage();
    const deps = { storage, apiKey: 'k', systemPrompt: 's' };
    expect(await runTurn({ ...deps, loop: fakeLoop('one') }, 'first')).toBe('one');
    expect(await runTurn({ ...deps, loop: fakeLoop('two') }, 'second')).toBe('two');
    const transcript = storage.raw.get('transcript') as { role: string }[];
    expect(transcript).toHaveLength(4);
    expect(transcript.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
  });

  it('throws on a missing API key so the event stays unacked and lastError records it', async () => {
    await expect(runTurn({ storage: fakeStorage(), apiKey: '', systemPrompt: 's', loop: fakeLoop('x') }, 'hi'))
      .rejects.toThrow(/ANTHROPIC_API_KEY unset/);
  });

  it('byteBound keeps the persisted transcript under the DO value ceiling', () => {
    const big = Array.from({ length: 60 }, (_, i) => ({
      role: i % 2 ? 'assistant' : 'user', content: [{ type: 'text', text: 'x'.repeat(50_000) }],
    })) as never[];
    const out = byteBound(big, TRANSCRIPT_BYTE_BUDGET);
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(TRANSCRIPT_BYTE_BUDGET);
    expect(out.length).toBeGreaterThanOrEqual(2);
    expect((out[0] as { role: string }).role).toBe('user');
  });
});
