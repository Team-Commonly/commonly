import mongoose, { Document, Model, Schema } from 'mongoose';

/**
 * Cross-replica event claim for Slack's at-least-once Events API delivery.
 *
 * A receipt is deliberately not synonymous with completion: a stale
 * `processing` claim can be CAS-taken over after a worker dies, while `done`
 * is retained for 24h so normal Slack retries never double-author a message.
 */
export interface ISlackEventReceipt extends Document {
  eventId: string;
  teamId: string;
  state: 'processing' | 'done';
  claimedAt: Date;
  receivedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const SlackEventReceiptSchema = new Schema<ISlackEventReceipt>(
  {
    eventId: { type: String, required: true, unique: true },
    teamId: { type: String, required: true },
    state: { type: String, enum: ['processing', 'done'], required: true },
    claimedAt: { type: Date, required: true },
    receivedAt: { type: Date, required: true, index: { expires: 24 * 60 * 60 } },
  },
  { timestamps: true, collection: 'slack_event_receipts' },
);

SlackEventReceiptSchema.index({ eventId: 1 }, { unique: true });

const SlackEventReceipt: Model<ISlackEventReceipt> =
  (mongoose.models.SlackEventReceipt as Model<ISlackEventReceipt>)
  || mongoose.model<ISlackEventReceipt>('SlackEventReceipt', SlackEventReceiptSchema);

export default SlackEventReceipt;
// CJS compatibility for the route's current require style.
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports.default; Object.assign(module.exports, exports);
