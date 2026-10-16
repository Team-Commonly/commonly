import mongoose, { Document, Model, Schema } from 'mongoose';

// First-touch arrivals with a ref code, counted per UTC day (routes/attribution.ts).
// Only the count: no person, no address, no user agent. Bounded both ways: at
// most VISIT_REFS_PER_DAY NEW refs a day (the rest count under OTHER_REF), and
// a day's row is dropped VISIT_RETENTION_DAYS after it was first written.
export const VISIT_REFS_PER_DAY = 50;
export const VISIT_RETENTION_DAYS = 180;
// The overflow row. '~' cannot appear in a ref (utils/signupRef.ts), so no real
// code, not even one named "other", ever shares it.
export const OTHER_REF = '~other';
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
AttributionVisitSchema.index({ createdAt: 1 }, { expireAfterSeconds: VISIT_RETENTION_DAYS * 24 * 60 * 60 });

const AttributionVisit: Model<IAttributionVisit> = mongoose.model<IAttributionVisit>(
  'AttributionVisit',
  AttributionVisitSchema,
);

export default AttributionVisit;
// CJS compat: let require() return the default export directly
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports["default"]; Object.assign(module.exports, exports);
