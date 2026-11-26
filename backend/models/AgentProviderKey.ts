import mongoose, { Schema } from 'mongoose';
import { dualStorePlugin } from '../repositories/dualStore';

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
// ADR-034 step 2: the repair markers (pgVersion, pgPending, pgDeleted) and their sparse index.
dualStorePlugin(schema);
export default mongoose.model('AgentProviderKey', schema);
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports.default; Object.assign(module.exports, exports);
