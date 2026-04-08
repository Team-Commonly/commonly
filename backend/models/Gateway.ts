import mongoose, { Document, Model, Schema, Types } from 'mongoose';

export interface IGateway extends Document {
  name: string;
  slug: string;
  type: 'openclaw';
  mode: 'local' | 'remote' | 'k8s';
  baseUrl: string;
  configPath: string;
  status: 'active' | 'paused' | 'disabled';
  metadata?: Record<string, unknown>;
  createdBy?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const GatewaySchema = new Schema<IGateway>(
  {
    name: { type: String, required: true },
    slug: { type: String, required: true, unique: true },
    type: { type: String, enum: ['openclaw'], default: 'openclaw' },
    mode: { type: String, enum: ['local', 'remote', 'k8s'], default: 'local' },
    baseUrl: { type: String, default: '' },
    configPath: { type: String, default: '' },
    status: { type: String, enum: ['active', 'paused', 'disabled'], default: 'active' },
    metadata: { type: Schema.Types.Mixed },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

GatewaySchema.index({ slug: 1 }, { unique: true });

export default mongoose.model<IGateway>('Gateway', GatewaySchema);
// CJS compat: let require() return the default export directly
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports["default"]; Object.assign(module.exports, exports);
