/**
 * MediaObject — byte blob + the small byte-level metadata (`mime`, `size`)
 * any driver needs to serve it back. Owned by the Mongo ObjectStore driver
 * (ADR-002 Phase 1). Display/ownership metadata (uploadedBy, originalName)
 * stays on `File` in Phase 1 and moves to `Attachment` in Phase 2.
 *
 * Why a new collection instead of reusing `File`: the ObjectStore interface
 * is driver-agnostic. Coupling the Mongo driver to a schema that also carries
 * display metadata would leak those concerns across every driver (gcs, s3,
 * etc.), contradicting "bytes live in the driver, metadata on the parent
 * entity" from REVIEW.md §Attachments.
 */

import mongoose, { Document, Model, Schema } from 'mongoose';

export interface IMediaObject extends Document {
  key: string;
  data: Buffer;
  mime: string;
  size: number;
  createdAt: Date;
}

export interface IMediaObjectModel extends Model<IMediaObject> {
  findByKey(key: string): mongoose.Query<IMediaObject | null, IMediaObject>;
}

const mediaObjectSchema = new Schema<IMediaObject>({
  key: { type: String, required: true, unique: true },
  data: { type: Buffer, required: true },
  mime: { type: String, required: true },
  size: { type: Number, required: true },
  createdAt: { type: Date, default: Date.now },
});

mediaObjectSchema.statics.findByKey = function (key: string) {
  return this.findOne({ key });
};

export default mongoose.model<IMediaObject, IMediaObjectModel>('MediaObject', mediaObjectSchema);
// CJS compat: let require() return the default export directly
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports['default'];
Object.assign(module.exports, exports);
