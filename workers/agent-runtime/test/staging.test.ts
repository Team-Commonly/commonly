import { describe, it, expect } from 'vitest';
import { resolveStagedReply, commitStagedReply, stagedKey, pruneStaged, STAGE_TTL_MS } from '../src/staging';

const mem = () => {
  const m = new Map<string, unknown>();
  return {
    get: async <T,>(k: string) => m.get(k) as T | undefined,
    put: async (k: string, v: unknown) => { m.set(k, v); },
    delete: async (k: string) => m.delete(k),
    list: async <T,>({ prefix }: { prefix: string }) => new Map([...m].filter(([k]) => k.startsWith(prefix))) as Map<string, T>,
    raw: m,
  };
};

describe('reply staging (#1344 — no model re-run on redelivery)', () => {
  it('first delivery runs the model and stages the reply before the post', async () => {
    const s = mem();
    let runs = 0;
    const r = await resolveStagedReply(s, 'e1', async () => { runs += 1; return 'hello'; });
    expect(r).toEqual({ reply: 'hello', fromStage: false });
    expect(runs).toBe(1);
    expect((s.raw.get(stagedKey('e1')) as { reply: string }).reply).toBe('hello');
  });

  it('a redelivery after a failed post reuses the staged reply — the model is NOT called again', async () => {
    const s = mem();
    let runs = 0;
    const run = async () => { runs += 1; return 'hello'; };
    await resolveStagedReply(s, 'e1', run);          // post then fails → no commit
    const again = await resolveStagedReply(s, 'e1', run);
    expect(again).toEqual({ reply: 'hello', fromStage: true });
    expect(runs).toBe(1);
  });

  it('commit clears the stage so a later, different event with the same id cannot replay it', async () => {
    const s = mem();
    await resolveStagedReply(s, 'e1', async () => 'hello');
    await commitStagedReply(s, 'e1');
    expect(s.raw.has(stagedKey('e1'))).toBe(false);
  });

  it('orphaned stages older than the TTL are pruned on the next stage — storage cannot grow (Otto)', async () => {
    const s = mem();
    const t0 = 1_000_000;
    await resolveStagedReply(s, 'old', async () => 'stuck', t0);              // post never commits
    await resolveStagedReply(s, 'fresh', async () => 'ok', t0 + 1000);
    expect(s.raw.has(stagedKey('old'))).toBe(true);                             // within TTL: kept
    const later = t0 + STAGE_TTL_MS + 5000;
    await resolveStagedReply(s, 'newer', async () => 'ok2', later);
    expect(s.raw.has(stagedKey('old'))).toBe(false);                            // past TTL: pruned
    expect(s.raw.has(stagedKey('fresh'))).toBe(false);                          // also past TTL by then
    expect(s.raw.has(stagedKey('newer'))).toBe(true);
    expect(await pruneStaged(s, later + STAGE_TTL_MS + 1)).toBe(1);             // only 'newer' left to prune
  });

  it('a model failure stages nothing, so the redelivery retries the model (not silence)', async () => {
    const s = mem();
    await expect(resolveStagedReply(s, 'e2', async () => { throw new Error('529'); })).rejects.toThrow('529');
    expect(s.raw.has(stagedKey('e2'))).toBe(false);
  });
});
