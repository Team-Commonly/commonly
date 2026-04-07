import mongoose, { Document, Model, Schema, Types } from 'mongoose';

export type AppInstallationStatus = 'active' | 'revoked';
export type AppInstallationTargetType = 'pod' | 'user';

export interface IAppInstallation extends Document {
  appId: Types.ObjectId;
  targetType: AppInstallationTargetType;
  targetId: Types.ObjectId;
  scopes: string[];
  events: string[];
  tokenHash: string;
  tokenExpiresAt?: Date | null;
  createdBy: Types.ObjectId;
  status: AppInstallationStatus;
  createdAt: Date;
  updatedAt: Date;
}

const AppInstallationSchema = new Schema<IAppInstallation>(
  {
    appId: { type: Schema.Types.ObjectId, ref: 'App', required: true },
    targetType: { type: String, enum: ['pod', 'user'], required: true },
    targetId: { type: Schema.Types.ObjectId, required: true },
    scopes: [{ type: String }],
    events: [{ type: String }],
    tokenHash: { type: String, required: true },
    tokenExpiresAt: { type: Date, default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    status: { type: String, enum: ['active', 'revoked'], default: 'active' },
  },
  { timestamps: true, collection: 'app_installations' },
);

export default mongoose.model<IAppInstallation>('AppInstallation', AppInstallationSchema);
