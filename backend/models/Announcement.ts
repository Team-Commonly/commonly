import mongoose, { Document, Model, Schema, Types } from 'mongoose';

export interface IAnnouncement extends Document {
  podId: Types.ObjectId;
  title: string;
  content: string;
  createdBy: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const AnnouncementSchema = new Schema<IAnnouncement>(
  {
    podId: { type: Schema.Types.ObjectId, ref: 'Pod', required: true },
    title: { type: String, required: true, trim: true },
    content: { type: String, required: true, trim: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true },
);

export default mongoose.model<IAnnouncement>('Announcement', AnnouncementSchema);
// CJS compat: let require() return the default export directly
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports["default"]; Object.assign(module.exports, exports);
