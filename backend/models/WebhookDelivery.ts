import mongoose, { Document, Schema } from 'mongoose';

// Atomic claim-based webhook dedup (connector hardening, 2026-08-31 study §gap 2).
// Providers redeliver: Telegram re-sends an update until it gets a 200, Slack
// retries on slow acks. Without a claim on the provider's delivery id, every
// redelivery of an already-processed update becomes a duplicate pod message and
// a duplicate agent wake (admitted in the bridge's own comments).
//
// Contract (claim-before-run, forget-on-error):
//   1. On receipt, atomically create {provider, deliveryId}. A duplicate-key
//      error means another delivery of the same update is processing or done —
//      ack 200 and stop.
//   2. If processing THROWS after the claim, release the claim before the
//      non-2xx response, so the provider's redelivery is a retry rather than
//      a swallowed drop. (A post-write failure must NOT release — the writer
//      handles its own partial-failure semantics; see the liveRelay comment in
//      routes/webhooks/telegram.ts.)
// The TTL bounds the table: a delivery id only needs to be remembered for as
// long as the provider keeps redelivering it.
//
// Key scope: {provider, deliveryId} assumes ONE id space per provider.
// Telegram's update_id is sequential per BOT — correct while the route serves
// a single bot; a second bot on the same route would collide id spaces and
// drop legitimate updates as duplicates. Widen the key (e.g. include bot id)
// before multi-bot.
export interface IWebhookDelivery extends Document {
  provider: string;
  deliveryId: string;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const WebhookDeliverySchema = new Schema<IWebhookDelivery>(
  {
    provider: { type: String, required: true },
    deliveryId: { type: String, required: true },
    expiresAt: { type: Date, required: true, index: { expires: 0 } },
  },
  { timestamps: true, collection: 'webhook_deliveries' },
);

WebhookDeliverySchema.index({ provider: 1, deliveryId: 1 }, { unique: true });

export default mongoose.model<IWebhookDelivery>('WebhookDelivery', WebhookDeliverySchema);
// CJS compat: let require() return the default export directly
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports["default"]; Object.assign(module.exports, exports);
