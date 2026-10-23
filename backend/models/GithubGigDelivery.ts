import mongoose, { Document, Model, Schema } from 'mongoose';

/** Permanent replay receipt: manual GitHub redelivery has no 24-hour limit. */
export interface IGithubGigDelivery extends Document {
  deliveryId: string;
  bodyHash: string;
  createdAt: Date;
}

const GithubGigDeliverySchema = new Schema<IGithubGigDelivery>({
  deliveryId: { type: String, required: true, unique: true },
  bodyHash: { type: String, required: true },
}, { timestamps: { createdAt: true, updatedAt: false } });

// Older receipts may predate body hashing. Index only new receipts so an
// upgrade does not collide on their missing bodyHash field.
GithubGigDeliverySchema.index({ bodyHash: 1 }, {
  unique: true, partialFilterExpression: { bodyHash: { $type: 'string' } },
});

export const GithubGigDelivery: Model<IGithubGigDelivery> = mongoose.model<IGithubGigDelivery>('GithubGigDelivery', GithubGigDeliverySchema);
export default GithubGigDelivery;
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports["default"]; Object.assign(module.exports, exports);
