import mongoose, { Document, Model, Schema } from 'mongoose';

/**
 * A grant of one user's connection to a pod or seat.
 *
 * The credential itself never lives here. `connectionId` points at the
 * connection that owns it and `brokerId` names the proxy that is allowed to
 * use it. Agents receive only the grant's capabilities; the broker is the
 * only component that can resolve the connection material.
 */
export type RoomGrantTargetKind = 'pod' | 'seat';
export type RoomGrantWriteMode = 'read' | 'write' | 'write-with-confirm';

export interface IRoomGrantBudget {
  calls?: number;
  windowMs?: number;
}

export interface IRoomGrantTarget {
  kind: RoomGrantTargetKind;
  id: string;
}

export interface IRoomGrant extends Document {
  grantId: string;
  connectionId: string;
  installationId: string;
  target: IRoomGrantTarget;
  tools: string[];
  writeMode: RoomGrantWriteMode;
  budget?: IRoomGrantBudget;
  /** Snapshot at mint time. Effective audience is this list ∩ current members. */
  audience: string[];
  expiresAt: Date;
  revokedAt?: Date | null;
  /** User who revoked this grant (and its descendants), when known. */
  revokedBy?: string | null;
  parentGrantId?: string | null;
  /** Denormalized root used to close revoke/mint races and check lineage. */
  rootGrantId?: string | null;
  /** Required proxy identifier; an agent must never receive connection material. */
  brokerId: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface RoomGrantModel extends Model<IRoomGrant> {
  /** Revoke a grant and all descendants with one updateMany write. */
  revokeCascade(grantId: string, revokedBy: string): Promise<number>;
}

const GrantBudgetSchema = new Schema<IRoomGrantBudget>(
  {
    calls: { type: Number, min: 0 },
    windowMs: { type: Number, min: 1 },
  },
  { _id: false },
);

const GrantTargetSchema = new Schema<IRoomGrantTarget>(
  {
    kind: { type: String, enum: ['pod', 'seat'], required: true },
    id: { type: String, required: true, trim: true },
  },
  { _id: false },
);

const RoomGrantSchema = new Schema<IRoomGrant>(
  {
    // `grantId` is the public, opaque identifier used by the MCP endpoint;
    // Mongo's _id remains an implementation detail.
    grantId: { type: String, required: true, unique: true, trim: true },
    connectionId: { type: String, required: true, trim: true },
    installationId: { type: String, required: true, trim: true },
    target: { type: GrantTargetSchema, required: true },
    tools: { type: [String], required: true, default: [] },
    writeMode: {
      type: String,
      enum: ['read', 'write', 'write-with-confirm'],
      required: true,
    },
    budget: { type: GrantBudgetSchema },
    audience: { type: [String], required: true, default: [] },
    // No TTL index: expiry is a capability check and an audit fact, not a
    // reason to delete the grant or its call trail.
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date, default: null },
    revokedBy: { type: String, default: null, trim: true },
    parentGrantId: { type: String, default: null, trim: true },
    rootGrantId: { type: String, default: null, trim: true },
    brokerId: { type: String, required: true, trim: true },
  },
  { timestamps: true, collection: 'room_grants' },
);

RoomGrantSchema.index({ target: 1, revokedAt: 1, expiresAt: 1 });
RoomGrantSchema.index({ parentGrantId: 1 });
RoomGrantSchema.index({ rootGrantId: 1 });
RoomGrantSchema.index({ connectionId: 1, installationId: 1 });

/**
 * Gather the grant lineage first, then perform exactly one write. This is
 * deliberately different from the credential substrate's per-level updates:
 * a room revoke must make the whole chain dead at one database boundary.
 */
RoomGrantSchema.statics.revokeCascade = async function revokeCascade(
  grantId: string,
  revokedBy: string,
): Promise<number> {
  const ids: string[] = [grantId];
  const seen = new Set(ids);
  let frontier: string[] = [grantId];

  while (frontier.length > 0) {
    const children = await this.find({ parentGrantId: { $in: frontier } })
      .select('grantId')
      .lean();
    const childIds = (children as Array<{ grantId?: string }>).map((child) => child.grantId)
      .filter((id): id is string => Boolean(id))
      .filter((id) => !seen.has(id));
    if (childIds.length === 0) break;
    ids.push(...childIds);
    childIds.forEach((id) => seen.add(id));
    frontier = childIds;
  }

  const revokedAt = new Date();
  const result = await this.updateMany(
    {
      grantId: { $in: ids },
      $or: [{ revokedAt: { $exists: false } }, { revokedAt: null }],
    },
    { $set: { revokedAt, revokedBy } },
  );
  return result.modifiedCount || 0;
};

const RoomGrant: RoomGrantModel =
  (mongoose.models.RoomGrant as RoomGrantModel)
  || mongoose.model<IRoomGrant, RoomGrantModel>('RoomGrant', RoomGrantSchema);

export { RoomGrant, RoomGrantSchema };
export default RoomGrant;

// CJS compat: let require() return the default export directly
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports["default"];
Object.assign(module.exports, exports);
