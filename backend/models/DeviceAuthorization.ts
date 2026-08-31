import mongoose, { Document, Schema, Types } from 'mongoose';

export type DeviceAuthorizationStatus = 'pending' | 'authorized' | 'denied' | 'consumed';

export interface IDeviceAuthorization extends Document {
  deviceCodeHash: string;
  userCodeHash: string;
  clientName: string;
  clientVersion?: string;
  hostname: string;
  status: DeviceAuthorizationStatus;
  userId?: Types.ObjectId | null;
  createdAt: Date;
  lastPolledAt?: Date;
  authorizedAt?: Date;
  deniedAt?: Date;
  consumedAt?: Date;
  expiresAt: Date;
}

const DeviceAuthorizationSchema = new Schema<IDeviceAuthorization>(
  {
    deviceCodeHash: { type: String, required: true, unique: true, index: true },
    userCodeHash: { type: String, required: true, unique: true, index: true },
    clientName: { type: String, required: true, trim: true, maxlength: 120 },
    clientVersion: { type: String, trim: true, maxlength: 80 },
    hostname: { type: String, required: true, trim: true, maxlength: 253 },
    status: { type: String, enum: ['pending', 'authorized', 'denied', 'consumed'], default: 'pending' },
    userId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    createdAt: { type: Date, default: Date.now },
    lastPolledAt: { type: Date },
    authorizedAt: { type: Date },
    deniedAt: { type: Date },
    consumedAt: { type: Date },
    // The TTL reaper is a cleanup backstop; every endpoint still checks this
    // timestamp so expiry behaves correctly before Mongo's next TTL sweep.
    expiresAt: { type: Date, required: true, expires: 0 },
  },
  { collection: 'device_authorizations' },
);

export default mongoose.model<IDeviceAuthorization>('DeviceAuthorization', DeviceAuthorizationSchema);
// CJS compat: let require() return the default export directly
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports.default; Object.assign(module.exports, exports);
