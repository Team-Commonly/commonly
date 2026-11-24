import { createHash } from 'crypto';
import mongoose from 'mongoose';

// Server-side BYO funnel rows. The browser posts its steps through
// POST /api/stats/byo-step; events only the backend can see (an agent's first
// authenticated call) are written here directly, so they never depend on the
// user keeping the page open. Fixed step names only: never a command, key or name.
type ServerByoStep = 'seat-registered' | 'daemon-registered' | 'run-stopped';

// Why a run stopped before its first authenticated call, sent without a key
// (POST /api/stats/run-stopped). `no-token`: the run had no key (F551).
// `token-refused`: the instance answered 401 to the first-run key (F571).
export const RUN_STOP_REASONS: ReadonlySet<string> = new Set(['no-token', 'token-refused']);

// A once-per-seat event is keyed by a hash of the token record's hash, so the
// unique _id index makes concurrent first calls write one row. The hash is one-way
// and is never the credential itself.
export function seatRegisteredKey(tokenHash: string): string {
  return `seat-registered:${createHash('sha256').update(tokenHash).digest('hex')}`;
}

// A person registers a daemon once per setup, however many machines they add,
// so the row is keyed by the user alone.
export function daemonRegisteredKey(userId: unknown): string {
  return `daemon-registered:${String(userId)}`;
}

// Account deletion removes a person's rows. userId is stored as the caller
// passed it, a string or an ObjectId, so both forms are matched.
export async function deleteByoEventsFor(userId: string): Promise<void> {
  const ids: unknown[] = [userId];
  if (mongoose.Types.ObjectId.isValid(userId)) ids.push(new mongoose.Types.ObjectId(userId));
  await mongoose.connection.db.collection('byo_telemetry').deleteMany({ userId: { $in: ids } });
}

export async function recordByoEvent(
  userId: unknown,
  step: ServerByoStep,
  extra: Record<string, unknown> = {},
  dedupeKey?: string,
): Promise<void> {
  try {
    // The collection is untyped here; a string _id is only set for the keyed seat row.
    const doc: Record<string, unknown> = {
      ...(dedupeKey ? { _id: dedupeKey } : {}),
      userId,
      step,
      ...extra,
      at: new Date(),
    };
    await mongoose.connection.db.collection('byo_telemetry').insertOne(doc as any);
  } catch (err: any) {
    // A duplicate key means this seat's row already exists: the expected outcome of a race.
    if (err?.code === 11000) return;
    // Telemetry must never fail the caller's flow.
    console.warn('[byo-telemetry] write failed:', err?.message);
  }
}

// One run-stopped row per installation and reason. A repeat moves its `at` to
// now (F571 review): the page shows only a stop made after its latest issue,
// so a key issued anew and refused again must read as a new stop. The unique
// _id keeps it one row; a concurrent first upsert that loses the race retries
// as an update.
export async function recordRunStopped(
  userId: unknown,
  installationId: unknown,
  reason: string,
  extra: { platform?: string; nodeMajor?: number } = {},
): Promise<void> {
  const collection = mongoose.connection.db.collection('byo_telemetry');
  const filter = { _id: `run-stopped:${String(installationId)}:${reason}` } as any;
  const set = {
    at: new Date(),
    ...(extra.platform ? { platform: extra.platform } : {}),
    ...(extra.nodeMajor ? { nodeMajor: extra.nodeMajor } : {}),
  };
  const update = {
    $set: set,
    $setOnInsert: {
      userId, step: 'run-stopped', reason, installationId,
    },
  };
  try {
    await collection.updateOne(filter, update, { upsert: true });
  } catch (err: any) {
    if (err?.code === 11000) {
      try { await collection.updateOne(filter, { $set: set }); } catch { /* telemetry */ }
      return;
    }
    console.warn('[byo-telemetry] run-stopped write failed:', err?.message);
  }
}

// F571: the run-stopped rows for these installations, owned by this person,
// newest first. The connect page reads them through GET
// /api/users/me/agent-connection. Fields are the fixed ones the route wrote.
export async function runStopsFor(
  userId: unknown,
  installationIds: unknown[],
): Promise<Array<{ installationId: unknown; reason: string; at: Date }>> {
  if (!installationIds.length) return [];
  const ids: unknown[] = [userId];
  if (typeof userId === 'string' && mongoose.Types.ObjectId.isValid(userId)) {
    ids.push(new mongoose.Types.ObjectId(userId));
  }
  const rows = await mongoose.connection.db.collection('byo_telemetry')
    .find(
      { userId: { $in: ids }, step: 'run-stopped', installationId: { $in: installationIds } } as any,
      { projection: { _id: 0, installationId: 1, reason: 1, at: 1 } },
    )
    .sort({ at: -1 })
    .limit(20)
    .toArray();
  return rows as any;
}
