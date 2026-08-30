// Reply staging (#1344): make "model turn → post" idempotent across kernel
// redeliveries. The reply is written to DO storage under the event id
// BEFORE the post; a redelivery of the same event reuses it and never
// re-runs the model. `commit` clears it once the post succeeded. Pure
// over an injected storage so the contract is unit-testable without workerd.
export interface StagingStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean | void>;
}

export const stagedKey = (eventId: string): string => `staged:${eventId}`;

export const resolveStagedReply = async (
  storage: StagingStorage,
  eventId: string,
  run: () => Promise<string>,
): Promise<{ reply: string; fromStage: boolean }> => {
  const existing = await storage.get<string>(stagedKey(eventId));
  if (existing !== undefined) return { reply: existing, fromStage: true };
  const reply = await run();
  await storage.put(stagedKey(eventId), reply);
  return { reply, fromStage: false };
};

export const commitStagedReply = async (storage: StagingStorage, eventId: string): Promise<void> => {
  await storage.delete(stagedKey(eventId));
};
