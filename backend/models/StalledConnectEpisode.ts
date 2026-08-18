import mongoose, { Document, Model, Schema, Types } from 'mongoose';

/**
 * Someone installed a seat and never started it.
 *
 * This is the record behind the stalled-connect nudge (W4 item 3; spec by
 * ux-lead, 2026-08-14). It is the recovery path's memory: what we have already
 * explained, to whom, about which token.
 *
 * WHY AN EPISODE IS A TOKEN, NOT AN INSTALL. The spec's no-spam rule is
 * "exactly one nudge per token-episode", where an episode is the life of the
 * current newest token and a reissue resets it. That is deliberate: reissuing
 * a token is a person trying again, which renews the expectation and earns one
 * more explanation. Keying on the installation instead would explain once and
 * then stay silent through every subsequent attempt; keying on time would
 * repeat at someone who already heard it. So the key is
 * (installationId, tokenIssuedAt).
 *
 * WHY IT IS SHARED. Two producers can explain the same silence: this timer,
 * and the reactive responder that answers when a human @mentions a seat with
 * no live wrapper (sprint-impl, scoped and not yet built). The spec requires
 * ONE explanation per episode total, whichever fires first — so both write
 * THIS record and `producer` says which won. A second collection would let a
 * user be told the same thing twice by two systems that each believed they
 * were the only one.
 *
 * NOT the same thing as OnboardingSilenceEpisode. That one fires on
 * conversational outcome (someone spoke, nothing answered) and reports to US.
 * This one fires on install state (a token was never used) and speaks to the
 * USER. They catch different failures: a user who never types is invisible to
 * that one and is exactly this one's subject — which is `user-fbd3`, who
 * signed up on 2026-08-15, installed a seat 77 seconds later, never ran it,
 * never spoke, and left.
 */
export interface IStalledConnectEpisode extends Document {
  installationId: Types.ObjectId;
  podId: string;
  /** The human who installed it — the nudge is addressed to them by name. */
  installedBy: Types.ObjectId;
  installerUsername?: string;
  agentName: string;
  instanceId: string;
  displayName?: string;
  /**
   * Issue time of the newest runtime token when the episode opened. THIS is
   * the episode identity; a reissue produces a later value and so a new
   * episode.
   */
  tokenIssuedAt: Date;
  /**
   * Which token store minted the episode-defining token.
   *
   * Recorded because the two stores are NOT symmetric: `User.agentRuntimeTokens`
   * carries an `expiresAt` and `AgentInstallation.runtimeTokens` does not, so
   * "the life of the current newest token" ends differently depending on which
   * one it came from — expiry on one path, supersession-only on the other
   * (pod-architect, 53309). Nothing reads this yet; it is here so the reactive
   * responder does not have to infer it.
   */
  tokenSource?: 'installation' | 'user' | null;
  /** Which producer explained it. See the class comment. */
  producer: 'timer' | 'reactive';
  nudgedAt: Date;
  nudgeMessageId?: string;
  /**
   * The forward commitment the nudge makes ("I'll post here the moment it
   * connects") has to be kept, or it is one more false promise — the exact
   * defect #943 existed to remove. These two record that it was.
   */
  resolvedAt?: Date;
  resolutionMessageId?: string;
  /** Still unconnected at +7d goes to the digest, never a second room post. */
  digestedAt?: Date;
  status: 'open' | 'resolved';
}

const StalledConnectEpisodeSchema = new Schema<IStalledConnectEpisode>(
  {
    installationId: { type: Schema.Types.ObjectId, ref: 'AgentInstallation', required: true },
    podId: { type: String, required: true },
    installedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    installerUsername: { type: String },
    agentName: { type: String, required: true },
    instanceId: { type: String, default: 'default' },
    displayName: { type: String },
    tokenIssuedAt: { type: Date, required: true },
    tokenSource: { type: String, enum: ['installation', 'user', null], default: null },
    producer: { type: String, enum: ['timer', 'reactive'], default: 'timer' },
    nudgedAt: { type: Date, required: true },
    nudgeMessageId: { type: String },
    resolvedAt: { type: Date },
    resolutionMessageId: { type: String },
    digestedAt: { type: Date },
    status: { type: String, enum: ['open', 'resolved'], default: 'open' },
  },
  { timestamps: true, versionKey: false },
);

// The no-spam rule, held in the database rather than in scan logic. A
// minute-cron overlapping itself, or the timer racing the reactive responder,
// both lose here — and losing means "already explained", not an error.
StalledConnectEpisodeSchema.index(
  { installationId: 1, tokenIssuedAt: 1 },
  { unique: true },
);
// The resolution sweep: which open episodes might have connected by now.
StalledConnectEpisodeSchema.index({ status: 1, nudgedAt: 1 });

const StalledConnectEpisode: Model<IStalledConnectEpisode> =
  (mongoose.models.StalledConnectEpisode as Model<IStalledConnectEpisode>)
  || mongoose.model<IStalledConnectEpisode>('StalledConnectEpisode', StalledConnectEpisodeSchema);

export default StalledConnectEpisode;
// CJS compat: let require() return the default export directly
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports["default"]; Object.assign(module.exports, exports);
