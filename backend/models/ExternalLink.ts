import mongoose, { Document, Schema, Types } from 'mongoose';

export type ExternalLinkType = 'discord' | 'telegram' | 'wechat' | 'groupme' | 'other';

export interface IExternalLink extends Document {
  podId: Types.ObjectId;
  name: string;
  type: ExternalLinkType;
  url?: string;
  qrCodePath?: string;
  createdBy: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const ExternalLinkSchema = new Schema<IExternalLink>(
  {
    podId: { type: Schema.Types.ObjectId, ref: 'Pod', required: true },
    name: { type: String, required: true, trim: true },
    type: {
      type: String,
      required: true,
      enum: ['discord', 'telegram', 'wechat', 'groupme', 'other'],
      default: 'other',
    },
    url: { type: String, trim: true },
    qrCodePath: { type: String },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true },
);

ExternalLinkSchema.pre<IExternalLink>('save', function (next) {
  if (this.type === 'wechat' && !this.qrCodePath && !this.url) {
    return next(new Error('WeChat links require either a QR code or URL'));
  }
  if (this.type !== 'wechat' && !this.url) {
    return next(new Error('URL is required for non-WeChat links'));
  }
  next();
});

export default mongoose.model<IExternalLink>('ExternalLink', ExternalLinkSchema);
// CJS compat: let require() return the default export directly
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports["default"]; Object.assign(module.exports, exports);
