import mongoose, { Document, Model, Schema } from 'mongoose';

/**
 * Every Stripe webhook event we have already processed.
 *
 * Stripe retries a webhook until it gets a 2xx — for up to three days — and
 * explicitly does not guarantee once-only delivery or ordering. So a handler
 * that is merely *correct* is not enough; it has to be *idempotent*, and the
 * cheapest honest way to get that is to refuse an event id we have seen.
 *
 * The unique index IS the lock: two concurrent deliveries of the same event
 * both attempt the insert, one wins, the loser takes E11000 and returns
 * early. That is the same shape as PodMemberFirstMessage (#834) and
 * AgentFirstContact — a durable marker whose uniqueness constraint does the
 * mutual exclusion, rather than an in-process guard that a second pod would
 * not see.
 *
 * Kept as its own collection rather than a field on User because an event can
 * arrive that we cannot map to a user (unknown customer, deleted account) and
 * we still must not process it twice.
 */
export interface IBillingEvent extends Document {
  eventId: string;
  type: string;
  customerId?: string;
  userId?: mongoose.Types.ObjectId;
  outcome: 'applied' | 'ignored' | 'unmapped' | 'error';
  detail?: string;
  createdAt: Date;
}

const BillingEventSchema = new Schema<IBillingEvent>(
  {
    eventId: { type: String, required: true },
    type: { type: String, required: true },
    customerId: { type: String },
    userId: { type: Schema.Types.ObjectId, ref: 'User' },
    // Recorded rather than inferred: "why does this customer not have Pro"
    // is the first support question, and `unmapped` vs `ignored` is the
    // difference between a bug and a no-op.
    outcome: {
      type: String,
      enum: ['applied', 'ignored', 'unmapped', 'error'],
      required: true,
    },
    detail: { type: String },
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false },
);

BillingEventSchema.index({ eventId: 1 }, { unique: true });

const BillingEvent: Model<IBillingEvent> =
  (mongoose.models.BillingEvent as Model<IBillingEvent>)
  || mongoose.model<IBillingEvent>('BillingEvent', BillingEventSchema);

export default BillingEvent;
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports["default"]; Object.assign(module.exports, exports);
