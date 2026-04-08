import mongoose, { Document, Model, Schema, Types } from 'mongoose';

export interface IFile extends Document {
  fileName: string;
  originalName: string;
  contentType: string;
  size: number;
  data: Buffer;
  uploadedBy: Types.ObjectId;
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
  data: { type: Buffer, required: true },
  uploadedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  createdAt: { type: Date, default: Date.now },
});

fileSchema.index({ fileName: 1 });

fileSchema.statics.findByFileName = function (fileName: string) {
  return this.findOne({ fileName });
};

export default mongoose.model<IFile, IFileModel>('File', fileSchema);
// CJS compat: let require() return the default export directly
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports["default"]; Object.assign(module.exports, exports);
