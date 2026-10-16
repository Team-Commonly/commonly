import mongoose, { Document, Model, Schema } from 'mongoose';

// First-touch arrivals with a ref code, counted per UTC day (routes/attribution.ts).
// Only the count: no person, no address, no user agent.
export interface IAttributionVisit extends Document {
  day: string;
  ref: string;
  count: number;
  createdAt: Date;
  updatedAt: Date;
}

const AttributionVisitSchema = new Schema<IAttributionVisit>(
  {
    day: { type: String, required: true },
    ref: { type: String, required: true },
    count: { type: Number, default: 0 },
  },
  { timestamps: true, collection: 'attribution_visits' },
);
AttributionVisitSchema.index({ day: 1, ref: 1 }, { unique: true });

const AttributionVisit: Model<IAttributionVisit> = mongoose.model<IAttributionVisit>(
  'AttributionVisit',
  AttributionVisitSchema,
);

export default AttributionVisit;
// CJS compat: let require() return the default export directly
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports["default"]; Object.assign(module.exports, exports);
