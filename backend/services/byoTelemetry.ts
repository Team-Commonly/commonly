import mongoose from 'mongoose';

// Server-side BYO funnel rows. The browser posts its steps through
// POST /api/stats/byo-step; events only the backend can see (an agent's first
// authenticated call) are written here directly, so they never depend on the
// user keeping the page open. Fixed step names only: never a command, key or name.
export type ServerByoStep = 'seat-registered';

export async function recordByoEvent(
  userId: unknown,
  step: ServerByoStep,
  extra: Record<string, unknown> = {},
): Promise<void> {
  try {
    await mongoose.connection.db.collection('byo_telemetry').insertOne({
      userId,
      step,
      ...extra,
      at: new Date(),
    });
  } catch (err: any) {
    // Telemetry must never fail the caller's flow.
    console.warn('[byo-telemetry] write failed:', err?.message);
  }
}
