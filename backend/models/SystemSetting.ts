import mongoose, { Document, Model, Schema, Types } from 'mongoose';

export interface ISystemSetting extends Document {
  key: string;
  value: unknown;
  updatedBy?: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const SystemSettingSchema = new Schema<ISystemSetting>(
  {
    key: { type: String, required: true, unique: true, index: true },
    value: { type: Schema.Types.Mixed, default: {} },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true, collection: 'system_settings' },
);

const SystemSetting: Model<ISystemSetting> = mongoose.model<ISystemSetting>(
  'SystemSetting',
  SystemSettingSchema,
);

export default SystemSetting;
// CJS compat: let require() return the default export directly
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports["default"]; Object.assign(module.exports, exports);
