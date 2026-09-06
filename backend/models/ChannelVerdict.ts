import mongoose, { Document, Model, Schema, Types } from 'mongoose';

/**
 * One bridge verdict for one connector binding. This is deliberately neither
 * an AttentionItem (which is a recipient queue) nor an AuditLog (which is an
 * administrator action): it records what a particular channel did with a
 * workspace event.
 */
export const CHANNEL_VERDICT_PROVIDERS = ['telegram', 'slack'] as const;
export type ChannelVerdictProvider = typeof CHANNEL_VERDICT_PROVIDERS[number];

export const CHANNEL_VERDICTS = ['interrupt', 'digest', 'hold'] as const;
export type ChannelVerdictKind = typeof CHANNEL_VERDICTS[number];

export const CHANNEL_VERDICT_EVENT_KINDS = ['decision_request', 'chat.message'] as const;
export type ChannelVerdictEventKind = typeof CHANNEL_VERDICT_EVENT_KINDS[number];

export const CHANNEL_VERDICT_RULED_VIA = ['telegram', 'slack', 'workspace'] as const;
export type ChannelVerdictRuledVia = typeof CHANNEL_VERDICT_RULED_VIA[number];

export interface IChannelVerdict extends Document {
  integrationId: Types.ObjectId;
  installationId?: Types.ObjectId;
  podId: Types.ObjectId;
  provider: ChannelVerdictProvider;
  event: {
    kind: ChannelVerdictEventKind;
    podMessageId: string;
    decisionId?: Types.ObjectId;
  };
  verdict: ChannelVerdictKind;
  reason: string;
  at: Date;
  reachedHumanAt?: Date;
  ruledVia?: ChannelVerdictRuledVia;
  expiresAt?: Date;
}

const channelVerdictEventSchema = new Schema(
  {
    kind: { type: String, required: true, enum: CHANNEL_VERDICT_EVENT_KINDS },
    podMessageId: { type: String, required: true, trim: true, maxlength: 128 },
    decisionId: { type: Schema.Types.ObjectId, ref: 'DecisionRequest' },
  },
  { _id: false },
);

const channelVerdictSchema = new Schema<IChannelVerdict>(
  {
    integrationId: { type: Schema.Types.ObjectId, ref: 'Integration', required: true },
    installationId: { type: Schema.Types.ObjectId, ref: 'InstallableInstallation' },
    podId: { type: Schema.Types.ObjectId, ref: 'Pod', required: true },
    provider: { type: String, required: true, enum: CHANNEL_VERDICT_PROVIDERS },
    event: { type: channelVerdictEventSchema, required: true },
    verdict: { type: String, required: true, enum: CHANNEL_VERDICTS },
    // Reasons are deliberately extensible: ADR-029's later writers use the
    // same collection rather than adding one model per relay policy.
    reason: { type: String, required: true, trim: true, maxlength: 80 },
    at: { type: Date, required: true, default: Date.now },
    reachedHumanAt: { type: Date },
    ruledVia: { type: String, enum: CHANNEL_VERDICT_RULED_VIA },
    // Open decision cards stay addressable until the card itself is settled.
    // All other rows set this at record time; the two settlement paths set it
    // for every copy of a decision card.
    expiresAt: { type: Date },
  },
  { collection: 'channel_verdicts' },
);

channelVerdictSchema.index({ integrationId: 1, at: -1 });
channelVerdictSchema.index({ podId: 1, at: -1 });
channelVerdictSchema.index({ 'event.podMessageId': 1 });
// Finished facts remain visible for one quarter. An open decision card has no
// expiry until its ruling path sets one, so the ledger cannot forget the
// channel receipt before the decision itself can finish.
channelVerdictSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
// A connector can retry a relay after a transient failure. Its ledger fact is
// still one fact per channel and workspace message, even if competing workers
// race the retry; the service upserts on this same key.
channelVerdictSchema.index({ integrationId: 1, 'event.podMessageId': 1 }, { unique: true });

const ChannelVerdict: Model<IChannelVerdict> = (mongoose.models.ChannelVerdict as Model<IChannelVerdict>)
  || mongoose.model<IChannelVerdict>('ChannelVerdict', channelVerdictSchema);

export default ChannelVerdict;
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = ChannelVerdict;
