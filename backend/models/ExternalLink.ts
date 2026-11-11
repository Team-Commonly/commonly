import mongoose, { Document, Schema, Types } from 'mongoose';

// Doc/link types added 2026-05-01: ExternalLink doubles as the pod "Artifacts"
// store in v2 — Notion docs, Google Suite, Figma, Zoom, GitHub URLs, etc.
// Original chat-bridge types (discord/telegram/wechat/groupme/other) are kept
// for backward compat with QR-code-based community joins.
export type ExternalLinkType =
  | 'discord' | 'telegram' | 'wechat' | 'groupme' | 'other'
  | 'notion'
  | 'google_doc' | 'google_sheet' | 'google_slides' | 'google_drive'
  | 'figma'
  | 'zoom'
  | 'gmail'
  | 'github_pr' | 'github_issue' | 'github_repo'
  | 'youtube' | 'loom'
  | 'other_link';

const EXTERNAL_LINK_TYPES: ExternalLinkType[] = [
  'discord', 'telegram', 'wechat', 'groupme', 'other',
  'notion',
  'google_doc', 'google_sheet', 'google_slides', 'google_drive',
  'figma', 'zoom', 'gmail',
  'github_pr', 'github_issue', 'github_repo',
  'youtube', 'loom',
  'other_link',
];

export interface IExternalLink extends Document {
  podId: Types.ObjectId;
  name: string;
  type: ExternalLinkType;
  url?: string;
  /** Legacy: a path on the serving pod's local disk (before F406). */
  qrCodePath?: string;
  /** The QR image's ObjectStore key (F406), shared by every replica. */
  qrCodeKey?: string;
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
      enum: EXTERNAL_LINK_TYPES,
      default: 'other_link',
    },
    url: { type: String, trim: true },
    qrCodePath: { type: String },
    // Server-side only: never in a response, so a leaked key cannot be tried
    // against another route (F406).
    qrCodeKey: { type: String },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  {
    timestamps: true,
    toJSON: {
      transform: (_doc: unknown, ret: Record<string, unknown>) => {
        delete ret.qrCodeKey;
        return ret;
      },
    },
  },
);

ExternalLinkSchema.pre<IExternalLink>('save', function (next) {
  if (this.type === 'wechat' && !this.qrCodePath && !this.qrCodeKey && !this.url) {
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
