// Reply staging (#1344): make "model turn → post" idempotent across kernel
// redeliveries. The reply is written to DO storage under the event id
// BEFORE the post; a redelivery of the same event reuses it and never
// re-runs the model. `commit` clears it once the post succeeded. Pure
// over an injected storage so the contract is unit-testable without workerd.
export interface StagingStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean | void>;
  list<T = unknown>(options: { prefix: string }): Promise<Map<string, T>>;
}

export const STAGE_PREFIX = 'staged:';
export const stagedKey = (eventId: string): string => `${STAGE_PREFIX}${eventId}`;
// A stuck post leaves its staged entry behind (no commit). The kernel retires
// an event after 3 redeliveries, so an orphan is never reused — prune anything
// older than this on each stage so orphans cannot accumulate (Otto, #1346).
export const STAGE_TTL_MS = 24 * 60 * 60 * 1000;

interface StagedEntry { reply: string; at: number }

export const resolveStagedReply = async (
  storage: StagingStorage,
  eventId: string,
  run: () => Promise<string>,
  now: number = Date.now(),
): Promise<{ reply: string; fromStage: boolean }> => {
  const existing = await storage.get<StagedEntry>(stagedKey(eventId));
  if (existing !== undefined) return { reply: existing.reply, fromStage: true };
  const reply = await run();
  await pruneStaged(storage, now);
  await storage.put(stagedKey(eventId), { reply, at: now } satisfies StagedEntry);
  return { reply, fromStage: false };
};

export const pruneStaged = async (storage: StagingStorage, now: number = Date.now()): Promise<number> => {
  const all = await storage.list<StagedEntry>({ prefix: STAGE_PREFIX });
  let pruned = 0;
  for (const [key, entry] of all) {
    if (!entry || typeof entry.at !== 'number' || now - entry.at > STAGE_TTL_MS) {
      await storage.delete(key);
      pruned += 1;
    }
  }
  return pruned;
};

export const commitStagedReply = async (storage: StagingStorage, eventId: string): Promise<void> => {
  await storage.delete(stagedKey(eventId));
};
