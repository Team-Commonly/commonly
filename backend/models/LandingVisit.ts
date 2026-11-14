import mongoose, { Document, Model, Schema } from 'mongoose';

// Every landing on a public page, counted per UTC day by where it came from
// (routes/attribution.ts, POST /api/attribution/landing): the referrer's site
// and the ?ref code, either of which may be NONE. attribution_visits only counts
// arrivals that carry a ref; this one also counts the ones that don't, so a read
// can say whether X, a listing or Product Hunt sent anyone (D315, F528).
// Only the count: no person, no IP, no user agent, no path, no full URL. Bounded
// both ways: at most LANDING_ROWS_PER_DAY new (ref, referrer) pairs a day (the
// rest count under OTHER), and a day's row is dropped LANDING_RETENTION_DAYS
// after it was first written.
export const LANDING_ROWS_PER_DAY = 200;
export const LANDING_RETENTION_DAYS = 180;
// '~' can't appear in a ref (utils/signupRef.ts) or a hostname, so neither
// marker collides with a real value.
export const NONE = '~none';
export const OTHER = '~other';

export interface ILandingVisit extends Document {
  day: string;
  ref: string;
  referrer: string;
  count: number;
  createdAt: Date;
  updatedAt: Date;
}

const LandingVisitSchema = new Schema<ILandingVisit>(
  {
    day: { type: String, required: true },
    ref: { type: String, required: true },
    referrer: { type: String, required: true },
    count: { type: Number, default: 0 },
  },
  { timestamps: true, collection: 'landing_visits' },
);
LandingVisitSchema.index({ day: 1, ref: 1, referrer: 1 }, { unique: true });
LandingVisitSchema.index({ createdAt: 1 }, { expireAfterSeconds: LANDING_RETENTION_DAYS * 24 * 60 * 60 });

const LandingVisit: Model<ILandingVisit> = mongoose.model<ILandingVisit>(
  'LandingVisit',
  LandingVisitSchema,
);

export default LandingVisit;
// CJS compat: let require() return the default export directly
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports["default"]; Object.assign(module.exports, exports);
