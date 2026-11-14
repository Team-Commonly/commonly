/**
 * AgentConnectCode — a short-lived code the connect page puts in its one
 * pasted line instead of the agent's lasting runtime key (F525). The CLI
 * trades it for the key on POST /api/agents/runtime/connect-code.
 *
 * Neither the code nor the key is stored in the clear: the row holds the
 * code's sha256 and the key sealed with AES-256-GCM under a key derived from
 * the code. A database read alone can't recover the key. Rows expire through
 * the TTL index; redeem also checks `expiresAt` because the TTL sweep runs
 * about once a minute.
 */

import mongoose, { Document, Schema, Types } from 'mongoose';

export interface IAgentConnectCode extends Document {
  codeHash: string;
  agentUserId: Types.ObjectId;
  // The sealed key's own hash, so redeem can check it is still live without
  // opening it.
  tokenHash: string;
  sealed: string;
  iv: string;
  tag: string;
  redeems: number;
  expiresAt: Date;
  createdAt: Date;
}

const agentConnectCodeSchema = new Schema<IAgentConnectCode>({
  codeHash: { type: String, required: true, unique: true },
  agentUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  tokenHash: { type: String, required: true },
  sealed: { type: String, required: true },
  iv: { type: String, required: true },
  tag: { type: String, required: true },
  redeems: { type: Number, default: 0 },
  expiresAt: { type: Date, required: true },
  createdAt: { type: Date, default: Date.now },
});
agentConnectCodeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.model<IAgentConnectCode>('AgentConnectCode', agentConnectCodeSchema);
// CJS compat: let require() return the default export directly
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports["default"]; Object.assign(module.exports, exports);
