import mongoose, { Schema } from 'mongoose';
const schema = new Schema({
  agentUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  ownerUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  providerId: { type: String, required: true },
  baseURL: { type: String, required: true },
  generation: { type: Number, default: 0 },
  secretRef: { type: String, default: null },
  setAt: { type: Date, default: null },
  setBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  lastUsedAt: { type: Date, default: null },
}, { timestamps: true });
export default mongoose.model('AgentProviderKey', schema);
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports.default; Object.assign(module.exports, exports);
