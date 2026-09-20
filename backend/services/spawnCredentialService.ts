// ADR-026 / TASK-094: per-spawn scoped credentials.
//
// The problem this closes: every adapter hands the runtime a file containing the
// SEAT's lifetime token, so anything that can read that file — or read the
// daemon's token record — holds a credential that outlives the spawn it was
// meant for, and cannot be revoked without killing the seat.
//
// The shape here is deliberately a plain AgentCredential row with lineage: a
// child mints from the seat's row, carries `scopes: ['spawn']`, expires on its
// own clock, and is revocable both by its parent's cascade and by the boot
// sweep that runs after a restart. Nothing new is introduced — no collection, no
// token prefix, no permission model — because the substrate on main (
// `AgentCredential.parentId` + `revokeCascade` + the auth check at
// middleware/agentRuntimeAuth.ts) already expresses exactly this.
//
// Two invariants a reader should not have to re-derive from the tests:
//   1. A child cannot mint another child. Otherwise a leaked file can be
//      extended indefinitely and the TTL bounds nothing.
//   2. The TTL is the authority and revocation is the optimisation — a
//      supervisor that is SIGKILLed never runs its exit path, so a credential
//      whose only bound was "revoked in finally" would leak on precisely the
//      crash it exists to survive (Vera, 70714).
import { Types } from 'mongoose';
import AgentCredential from '../models/AgentCredential';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { hash, randomSecret } = require('../utils/secret') as {
  hash: (value: string) => string;
  randomSecret: (bytes: number) => string;
};

/** The only scope a minted child carries. Its presence is what marks a row as
 *  a spawn credential, and it is the check that makes invariant 1 above true. */
export const SPAWN_SCOPE = 'spawn';

export const SPAWN_TTL_DEFAULT_SECONDS = 12 * 60 * 60;
export const SPAWN_TTL_MAX_SECONDS = 24 * 60 * 60;
export const SPAWN_TTL_MIN_SECONDS = 60;

export const MAX_SPAWN_ID_LENGTH = 128;

export interface SeatCredentialRow {
  _id: Types.ObjectId | string;
  ownerUserId: Types.ObjectId | string;
  agentUserId?: Types.ObjectId | null;
  machineId?: string | null;
  scopes?: string[];
  label?: string;
}

export interface MintSpawnCredentialInput {
  seat: SeatCredentialRow;
  spawnId: unknown;
  ttlSeconds?: unknown;
  // Used only when the caller has no credential row yet — a seat token minted
  // before the substrate existed, or one whose row was never backfilled.
  agentUserId?: Types.ObjectId | string | null;
  installedBy?: Types.ObjectId | string | null;
}

export type MintSpawnCredentialResult =
  | {
      ok: true;
      token: string;
      credentialId: Types.ObjectId;
      expiresAt: Date;
      spawnId: string;
    }
  | { ok: false; code: 'child_cannot_mint' | 'invalid_spawn_id' | 'invalid_ttl' };

/** Clamp a requested lifetime into the accepted band. Returns null for input
 *  that is present but not a usable number, so the caller can refuse rather
 *  than silently substituting a default the caller did not ask for. */
export const clampSpawnTtlSeconds = (ttlSeconds: unknown): number | null => {
  if (ttlSeconds === undefined || ttlSeconds === null) return SPAWN_TTL_DEFAULT_SECONDS;
  const seconds = Number(ttlSeconds);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return Math.min(Math.max(Math.floor(seconds), SPAWN_TTL_MIN_SECONDS), SPAWN_TTL_MAX_SECONDS);
};

export const isSpawnCredential = (row: { scopes?: string[] } | null | undefined): boolean => (
  Array.isArray(row?.scopes) && row!.scopes!.includes(SPAWN_SCOPE)
);

/**
 * Find the credential row behind a presented seat token, backfilling one when
 * the token predates the substrate.
 *
 * The backfill is `$setOnInsert` and therefore idempotent: it never overwrites
 * a row that already has status, lineage or expiry, so it cannot resurrect a
 * revoked credential. `ownerUserId` is required by the schema and a legacy
 * embedded token carries no owner, so it is taken from the installation that
 * authorized the seat and only then from the agent user itself.
 */
export async function resolveSeatCredential({
  tokenHash,
  agentUserId,
  installedBy,
  label,
}: {
  tokenHash: string;
  agentUserId: Types.ObjectId | string;
  installedBy?: Types.ObjectId | string | null;
  label?: string;
}): Promise<SeatCredentialRow> {
  const existing = await AgentCredential.findOne({ tokenHash }).lean() as SeatCredentialRow | null;
  if (existing) return existing;

  const ownerUserId = installedBy || agentUserId;
  await AgentCredential.updateOne(
    { tokenHash },
    {
      $setOnInsert: {
        kind: 'runtime',
        ownerUserId,
        agentUserId,
        label: label || 'Runtime token',
        status: 'active',
      },
    },
    { upsert: true },
  );

  const created = await AgentCredential.findOne({ tokenHash }).lean() as SeatCredentialRow | null;
  if (!created) {
    // Unreachable unless the upsert was rejected (e.g. a concurrent insert won
    // the unique index). Surfacing it as an error beats minting a child whose
    // parent link points at nothing.
    throw new Error('Could not resolve or create a credential row for this token');
  }
  return created;
}

/**
 * Mint a child credential for one spawn.
 *
 * `spawnId` is supplied by the caller (the supervisor) so the ledger can name
 * which spawn a row belongs to; it is a label, never an authorization input —
 * the authority is the parent link and the scope, both server-assigned.
 */
export async function mintSpawnCredential(
  input: MintSpawnCredentialInput,
): Promise<MintSpawnCredentialResult> {
  const { seat } = input;

  // Invariant 1: a child cannot mint. Checked before anything is created so a
  // refused call leaves no row behind.
  if (isSpawnCredential(seat)) return { ok: false, code: 'child_cannot_mint' };

  const spawnId = typeof input.spawnId === 'string' ? input.spawnId.trim() : '';
  if (!spawnId || spawnId.length > MAX_SPAWN_ID_LENGTH) {
    return { ok: false, code: 'invalid_spawn_id' };
  }

  const ttlSeconds = clampSpawnTtlSeconds(input.ttlSeconds);
  if (ttlSeconds === null) return { ok: false, code: 'invalid_ttl' };

  const token = `cm_agent_${randomSecret(32)}`;
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);

  const child = await AgentCredential.create({
    tokenHash: hash(token),
    kind: 'runtime',
    ownerUserId: seat.ownerUserId,
    agentUserId: seat.agentUserId || input.agentUserId || null,
    machineId: seat.machineId ?? null,
    parentId: seat._id,
    label: `spawn:${spawnId}`,
    scopes: [SPAWN_SCOPE],
    expiresAt,
  });

  return {
    ok: true,
    token,
    credentialId: (child as { _id: Types.ObjectId })._id,
    expiresAt,
    spawnId,
  };
}

/**
 * Revoke one child. The parent link is part of the query, not a check after the
 * fact: a seat may only revoke its own children, and a child may only be
 * revoked by its seat, never by itself (a leaked file must not be able to hide
 * its own existence from the boot sweep).
 */
export async function revokeSpawnCredential({
  credentialId,
  seatCredentialId,
}: {
  credentialId: Types.ObjectId | string;
  seatCredentialId: Types.ObjectId | string;
}): Promise<{ revoked: number; found: boolean }> {
  const target = await AgentCredential.findOne({
    _id: credentialId,
    parentId: seatCredentialId,
  }).select('_id status').lean();
  if (!target) return { revoked: 0, found: false };

  const res = await AgentCredential.updateOne(
    { _id: credentialId, status: 'active' },
    { $set: { status: 'revoked', revokedAt: new Date() } },
  );
  return { revoked: res?.modifiedCount || 0, found: true };
}

/**
 * Revoke every active child of this seat — the boot sweep.
 *
 * Everything minted before a restart is dead by definition: no spawn survived
 * the restart, so any child still marked active was orphaned by a kill that
 * never ran its finally. Revoking on boot is what makes the TTL a backstop
 * rather than the primary mechanism, and it is idempotent.
 */
export async function revokeOrphanSpawnCredentials({
  seatCredentialId,
}: {
  seatCredentialId: Types.ObjectId | string;
}): Promise<number> {
  const res = await AgentCredential.updateMany(
    { parentId: seatCredentialId, status: 'active' },
    { $set: { status: 'revoked', revokedAt: new Date() } },
  );
  return res?.modifiedCount || 0;
}

module.exports = {
  SPAWN_SCOPE,
  SPAWN_TTL_DEFAULT_SECONDS,
  SPAWN_TTL_MAX_SECONDS,
  SPAWN_TTL_MIN_SECONDS,
  MAX_SPAWN_ID_LENGTH,
  clampSpawnTtlSeconds,
  isSpawnCredential,
  resolveSeatCredential,
  mintSpawnCredential,
  revokeSpawnCredential,
  revokeOrphanSpawnCredentials,
};
Object.assign(module.exports, exports);
