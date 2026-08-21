import mongoose, { Document, Model, Schema } from 'mongoose';

/**
 * A short-lived, cluster-wide lease for one agent-heartbeat dispatch. The
 * fixed _id is the natural key: MongoDB's primary-key uniqueness makes the
 * acquire compare-and-set atomic without depending on index build timing.
 */
export interface ISchedulerHeartbeatLease extends Document {
  _id: string;
  ownerId: string;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const SchedulerHeartbeatLeaseSchema = new Schema<ISchedulerHeartbeatLease>(
  {
    _id: { type: String, required: true },
    ownerId: { type: String, required: true },
    // Cleanup only; correctness comes from the conditional acquisition query.
    expiresAt: { type: Date, required: true, index: { expires: 0 } },
  },
  { timestamps: true, collection: 'scheduler_heartbeat_leases' },
);

export const SchedulerHeartbeatLease: Model<ISchedulerHeartbeatLease> = mongoose.model<ISchedulerHeartbeatLease>(
  'SchedulerHeartbeatLease',
  SchedulerHeartbeatLeaseSchema,
);

export default SchedulerHeartbeatLease;
// CJS compat: let require() return the default export directly
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports["default"]; Object.assign(module.exports, exports);
