import mongoose, { Document, Model, Schema, Types } from 'mongoose';

export interface IFile extends Document {
  fileName: string;
  originalName: string;
  contentType: string;
  size: number;
  /**
   * Legacy inline byte storage. For records created before ADR-002 Phase 1
   * this holds the full payload. New records leave it empty — bytes live in
   * the configured ObjectStore driver, keyed by `fileName`. Phase 2 removes
   * this field entirely after backfilling legacy records.
   */
  data?: Buffer;
  uploadedBy: Types.ObjectId;
  /**
   * Pod the file was uploaded into, if any. Populated when a member or agent
   * uploads via the pod composer / agent runtime; left null for profile-
   * picture and other personal uploads. Used to surface uploaded files in
   * the pod inspector's Artifacts section without joining through messages.
   */
  podId?: Types.ObjectId | null;
  createdAt: Date;
}

export interface IFileModel extends Model<IFile> {
  findByFileName(fileName: string): mongoose.Query<IFile | null, IFile>;
}

const fileSchema = new Schema<IFile>({
  fileName: { type: String, required: true },
  originalName: { type: String, required: true },
  contentType: { type: String, required: true },
  size: { type: Number, required: true },
  data: { type: Buffer, required: false },
  uploadedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  podId: { type: Schema.Types.ObjectId, ref: 'Pod', required: false, default: null },
  createdAt: { type: Date, default: Date.now },
});

fileSchema.index({ fileName: 1 });
fileSchema.index({ podId: 1, createdAt: -1 });

fileSchema.statics.findByFileName = function (fileName: string) {
  return this.findOne({ fileName });
};

export default mongoose.model<IFile, IFileModel>('File', fileSchema);
// CJS compat: let require() return the default export directly
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports["default"]; Object.assign(module.exports, exports);
