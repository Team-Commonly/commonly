import { createHash } from 'crypto';
import mongoose from 'mongoose';

// Server-side BYO funnel rows. The browser posts its steps through
// POST /api/stats/byo-step; events only the backend can see (an agent's first
// authenticated call) are written here directly, so they never depend on the
// user keeping the page open. Fixed step names only: never a command, key or name.
export type ServerByoStep = 'seat-registered' | 'daemon-registered';

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
