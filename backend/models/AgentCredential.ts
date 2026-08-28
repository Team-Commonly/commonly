// ADR-026 Phase 0: the credential substrate. Per-token records with issuer
// lineage and cascade revocation — the thing the embedded
// User.agentRuntimeTokens hash-list cannot express (review on #1310: on the
// embedded model, revoking an issuer leaves its minted children live, and a
// removed machine keeps operating its agents).
//
// Additive by design: agentRuntimeAuth consults this collection FIRST and
// falls back to the embedded records, so every existing token keeps working
// untouched. New mints dual-write here; nothing migrates destructively.
import mongoose, { Document, Schema, Types } from 'mongoose';

export type AgentCredentialKind = 'runtime' | 'daemon';
export type AgentCredentialStatus = 'active' | 'revoked';

export interface IAgentCredential extends Document {
  tokenHash: string;
  kind: AgentCredentialKind;
  // The human who authorized this credential's existence.
  ownerUserId: Types.ObjectId;
  // runtime: the bot User this token authenticates as. daemon: null.
  agentUserId?: Types.ObjectId | null;
  // ADR-026 D3: set for daemon credentials and for runtime tokens minted by
  // a daemon. Server-assigned, never trusted from a caller.
  machineId?: string | null;
  // Issuer lineage (D4.5): a runtime token minted by a daemon carries that
  // daemon credential's id. Auth rejects a child whose parent is revoked.
  parentId?: Types.ObjectId | null;
  label?: string;
  scopes: string[];
  status: AgentCredentialStatus;
  createdAt: Date;
  lastUsedAt?: Date | null;
  expiresAt?: Date | null;
  revokedAt?: Date | null;
}

const AgentCredentialSchema = new Schema<IAgentCredential>(
  {
    tokenHash: { type: String, required: true, unique: true },
    kind: { type: String, required: true, enum: ['runtime', 'daemon'] },
    ownerUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    agentUserId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    machineId: { type: String, default: null },
    parentId: { type: Schema.Types.ObjectId, ref: 'AgentCredential', default: null },
    label: { type: String },
    scopes: { type: [String], default: [] },
    status: { type: String, enum: ['active', 'revoked'], default: 'active' },
    lastUsedAt: { type: Date, default: null },
    expiresAt: { type: Date, default: null },
    revokedAt: { type: Date, default: null },
  },
  { timestamps: true, collection: 'agentcredentials' },
);

AgentCredentialSchema.index({ ownerUserId: 1, status: 1 });
AgentCredentialSchema.index({ parentId: 1 });
AgentCredentialSchema.index({ agentUserId: 1 });

// Revoke a credential AND every descendant, breadth-first. One level deep
// today (daemon → runtime), but written as a walk so a deeper chain can
// never orphan a live child.
AgentCredentialSchema.statics.revokeCascade = async function revokeCascade(
  credentialId: Types.ObjectId | string,
): Promise<number> {
  const now = new Date();
  let frontier: (Types.ObjectId | string)[] = [credentialId];
  let revoked = 0;
  while (frontier.length) {
    const res = await this.updateMany(
      { _id: { $in: frontier }, status: 'active' },
      { $set: { status: 'revoked', revokedAt: now } },
    );
    revoked += res.modifiedCount || 0;
    const children = await this.find({ parentId: { $in: frontier } }).select('_id').lean();
    frontier = children.map((c: { _id: Types.ObjectId }) => c._id);
  }
  return revoked;
};

export interface AgentCredentialModel extends mongoose.Model<IAgentCredential> {
  revokeCascade(credentialId: Types.ObjectId | string): Promise<number>;
}

export default mongoose.model<IAgentCredential, AgentCredentialModel>('AgentCredential', AgentCredentialSchema);
// CJS compat: let require() return the default export directly
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports["default"]; Object.assign(module.exports, exports);
