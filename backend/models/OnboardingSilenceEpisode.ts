import mongoose, { Document, Model, Schema, Types } from 'mongoose';

/**
 * A newcomer typed into a room that could have answered, and nothing did.
 *
 * This is the record behind the "signed up, typed, got no reply" alert (W4
 * item 2). It exists as its own collection for the same reason
 * PodMemberFirstMessage does: the fact being recorded is a one-time lifecycle
 * event, and anything stored on a row that join/leave or the dual-DB sync
 * rewrites would replay the alert at someone already alerted about.
 *
 * EPISODE, not message. A user typing four times into a dead room is one
 * failure, not four. An episode opens on the first unanswered message in a
 * (user, pod) pair and stays open — absorbing further silent messages into
 * `messageCount` — until something answers. Only then can a new one open. The
 * partial unique index below IS that guarantee; it is not advisory.
 *
 * WHY THE EVENT SNAPSHOT IS NOT OPTIONAL. The original reason was a race: at
 * the time this was written, AgentEvent pending rows were deleted 30 minutes
 * after creation while the alert fired at 15, so the evidence existed for
 * fifteen minutes and never again. That deletion window is gone — pending rows
 * now age out on the same 168h clock as everything else (#993) — and the
 * snapshot is still not optional, for two reasons the deletion was never the
 * only one:
 *
 * 1. STATUS MOVES. `pending` becomes `delivered` becomes `acked`, so a query
 *    run later reports the queue as it ended, not as it was when the alert
 *    fired. The discriminator below is a statement about a moment.
 * 2. THE WINDOW CANNOT BE REBUILT. The field is a count of events in this pod
 *    BETWEEN the message and the alert. Later traffic lands in the same pod, so
 *    `noneEnqueued` in particular degrades from a fact into an inference the
 *    moment anything else is enqueued there.
 *
 * And the rows themselves are not permanent — they age out at 168h. "Outlives
 * the deletion" is the claim, not "outlives retention".
 *
 * So: capture at fire time, because the queue can distinguish two failures that
 * look identical afterwards and need opposite fixes:
 *
 *   - nothing was ever enqueued  → a producer bug (the write path skipped
 *     enqueueMentions — see pgMessageController, which does exactly this)
 *   - enqueued and never acked   → a runtime bug (the agent never ran, or ran
 *     and died)
 *
 * Capture it at fire time or the alert is a report that something is wrong
 * with no way left to say what. Calibration: pod-architect, 2026-08-15;
 * rationale corrected 2026-08-18 when the 30-minute deletion it rested on was
 * removed.
 */
export interface IAgentEventSnapshot {
  /** AgentEvents in this pod between the message and the alert. */
  total: number;
  /** Per-status counts, e.g. { pending: 1, delivered: 2 }. */
  byStatus: Record<string, number>;
  /** Seats the queue tried to reach, as `agentName/instanceId`. */
  targets: string[];
  /** True when nothing was enqueued at all — the producer-bug fingerprint. */
  noneEnqueued: boolean;
  /**
   * AgentRuns started in this pod during the same window.
   *
   * Without it, "acked and no reply" is one label over at least three
   * different faults: the runtime declined at its daily cap (which returns
   * `status:'succeeded'` at nativeRuntimeService:634, BEFORE AgentRun.create
   * at :695, so there is no run row), another agent won the claim and this
   * seat stood down, or it genuinely ran and produced nothing. The first two
   * are "we never ran"; the third is "we ran and stayed silent". Opposite
   * investigations, and a run count separates them.
   *
   * It does NOT separate at-cap from claim-lost — both have zero runs.
   * `message_claims.claimed_by` is the discriminator for that, and is
   * deliberately not read here: claim-lost is routine in a multi-agent pod
   * and the alert would want to re-attribute the failure to the claim holder,
   * which is a bigger change than a label.
   */
  runsStarted: number;
}

export interface IOnboardingSilenceEpisode extends Document {
  userId: Types.ObjectId;
  username?: string;
  podId: string;
  podName?: string;
  /** PG `messages.id` of the first unanswered message (integer, held as text). */
  firstMessageId: string;
  firstTypedAt: Date;
  /** How far into this account's life the silence happened. */
  accountAgeMinutes: number;
  messageCount: number;
  /**
   * Watermark for absorbing repeat messages into an open episode. Passes
   * overlap by design, so `messageCount` must only ever move forward: an
   * absorb is guarded on `lastAbsorbedAt < thisMessage`, which makes
   * re-scanning covered ground a no-op instead of an inflating counter.
   */
  lastAbsorbedAt?: Date;
  lastAbsorbedMessageId?: string;
  status: 'open' | 'resolved';
  /** Only meaningful once resolved; `human-rescued` is a distinct outcome. */
  outcome?: 'answered' | 'human-rescued';
  detectedAt: Date;
  alertSentAt?: Date;
  /** Set when the hourly collapse rule suppressed the individual delivery. */
  collapsedIntoRollup: boolean;
  eventSnapshot?: IAgentEventSnapshot;
  resolvedAt?: Date;
  resolutionLagSeconds?: number;
}

const OnboardingSilenceEpisodeSchema = new Schema<IOnboardingSilenceEpisode>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    username: { type: String },
    // Held as a string because pods are addressed as strings across the
    // dual-DB boundary: PG `messages.pod_id` is varchar, Mongo `_id` is an
    // ObjectId, and this collection is joined against both.
    podId: { type: String, required: true },
    podName: { type: String },
    firstMessageId: { type: String, required: true },
    firstTypedAt: { type: Date, required: true },
    accountAgeMinutes: { type: Number, required: true },
    messageCount: { type: Number, default: 1 },
    lastAbsorbedAt: { type: Date },
    lastAbsorbedMessageId: { type: String },
    status: { type: String, enum: ['open', 'resolved'], default: 'open' },
    outcome: { type: String, enum: ['answered', 'human-rescued'] },
    detectedAt: { type: Date, required: true },
    alertSentAt: { type: Date },
    collapsedIntoRollup: { type: Boolean, default: false },
    eventSnapshot: {
      type: new Schema<IAgentEventSnapshot>({
        total: { type: Number, default: 0 },
        byStatus: { type: Object, default: {} },
        targets: { type: [String], default: [] },
        noneEnqueued: { type: Boolean, default: true },
        runsStarted: { type: Number, default: 0 },
      }, { _id: false }),
    },
    resolvedAt: { type: Date },
    resolutionLagSeconds: { type: Number },
  },
  { timestamps: true, versionKey: false },
);

// One OPEN episode per (user, pod) — the no-duplicate-alert guarantee, held in
// the database rather than in scan logic, because two overlapping scan passes
// (a slow pass plus the next cron tick) would both miss the read and both
// insert. The loser takes a duplicate-key error, which the service treats as
// "already open" rather than as a failure.
OnboardingSilenceEpisodeSchema.index(
  { userId: 1, podId: 1 },
  { unique: true, partialFilterExpression: { status: 'open' } },
);
// The admin read path: "what happened since <date>", newest first.
OnboardingSilenceEpisodeSchema.index({ status: 1, detectedAt: -1 });
// The resolution sweep, which runs every 5 minutes and is bounded by
// RESOLUTION_WINDOW_DAYS. Keyed on firstTypedAt rather than detectedAt because
// the window it asks about is "how long since the person spoke", not "how long
// since we noticed".
OnboardingSilenceEpisodeSchema.index({ status: 1, firstTypedAt: 1 });

const OnboardingSilenceEpisode: Model<IOnboardingSilenceEpisode> =
  (mongoose.models.OnboardingSilenceEpisode as Model<IOnboardingSilenceEpisode>)
  || mongoose.model<IOnboardingSilenceEpisode>(
    'OnboardingSilenceEpisode',
    OnboardingSilenceEpisodeSchema,
  );

export default OnboardingSilenceEpisode;
// CJS compat: let require() return the default export directly
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports["default"]; Object.assign(module.exports, exports);
