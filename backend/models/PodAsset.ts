import mongoose, { Document, Schema, Types } from 'mongoose';

export type PodAssetType =
  | 'summary'
  | 'integration-summary'
  | 'skill'
  | 'memory'
  | 'daily-log'
  | 'message'
  | 'thread'
  | 'file'
  | 'doc'
  | 'link';

export type PodAssetCreatedByType = 'system' | 'user' | 'agent';
export type PodAssetStatus = 'active' | 'archived';

export interface IPodAsset extends Document {
  podId: Types.ObjectId;
  type: PodAssetType;
  title: string;
  content: string;
  tags: string[];
  sourceType?: string | null;
  sourceRef: {
    summaryId?: Types.ObjectId | null;
    integrationId?: Types.ObjectId | null;
    messageId?: string | null;
  };
  metadata: Record<string, unknown>;
  createdBy?: Types.ObjectId | null;
  createdByType: PodAssetCreatedByType;
  status: PodAssetStatus;
  createdAt: Date;
  updatedAt: Date;
}

const PodAssetSchema = new Schema<IPodAsset>(
  {
    podId: { type: Schema.Types.ObjectId, ref: 'Pod', required: true, index: true },
    type: {
      type: String,
      enum: ['summary', 'integration-summary', 'skill', 'memory', 'daily-log', 'message', 'thread', 'file', 'doc', 'link'],
      required: true,
      index: true,
    },
    title: { type: String, required: true, trim: true },
    content: { type: String, default: '' },
    tags: { type: [String], default: [], index: true },
    sourceType: { type: String, default: null },
    sourceRef: {
      summaryId: { type: Schema.Types.ObjectId, ref: 'Summary', default: null },
      integrationId: { type: Schema.Types.ObjectId, ref: 'Integration', default: null },
      messageId: { type: String, default: null },
    },
    metadata: { type: Schema.Types.Mixed, default: {} },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    createdByType: {
      type: String,
      enum: ['system', 'user', 'agent'],
      default: 'system',
      index: true,
    },
    status: { type: String, enum: ['active', 'archived'], default: 'active', index: true },
  },
  { timestamps: true },
);

PodAssetSchema.index({ podId: 1, createdAt: -1 });
PodAssetSchema.index({ podId: 1, tags: 1, createdAt: -1 });
PodAssetSchema.index(
  { title: 'text', content: 'text', tags: 'text' },
  { weights: { title: 5, tags: 4, content: 1 } },
);

export default mongoose.model<IPodAsset>('PodAsset', PodAssetSchema);
// CJS compat: let require() return the default export directly
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports["default"]; Object.assign(module.exports, exports);
