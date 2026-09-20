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
// The lifetime contract (Wren, 2026-09-20, after Vera 70738): renewal EXTENDS
// THE SAME value rather than rotating it, so the TTL bounds the ABANDONED
// credential, not a stolen one. Once the supervisor stops renewing — spawn
// ends, crash, SIGKILL — any holder of the value is 401 within one TTL. While
// the supervisor is still renewing, a copy taken off-host is as alive as the
// spawn, and its ceiling is the spawn's end + one TTL, with `maxExpiresAt`
// (mint + 24h) as the absolute limit. "15 minutes" is never the exposure window
// for a stolen value; it is how long an abandoned one outlives its spawn.
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

// 15 minutes is the renewal TTL: it is what an abandoned credential outlives
// its spawn by, and it is why the default is short rather than long.
export const SPAWN_TTL_DEFAULT_SECONDS = 15 * 60;
export const SPAWN_TTL_MAX_SECONDS = 24 * 60 * 60;
export const SPAWN_TTL_MIN_SECONDS = 60;
// The absolute ceiling, measured from the mint: no amount of renewal moves a
// child past it, so a supervisor that never stops renewing still dies at 24h.
export const SPAWN_ABSOLUTE_LIFETIME_SECONDS = 24 * 60 * 60;

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
      maxExpiresAt: Date;
      spawnId: string;
    }
  | { ok: false; code: 'child_cannot_mint' | 'invalid_spawn_id' | 'invalid_ttl' };

export type RenewSpawnCredentialResult =
  | { ok: true; expiresAt: Date; extended: boolean }
  | { ok: false; code: 'not_found' | 'not_renewable' | 'invalid_ttl' };

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
  const now = Date.now();
  const expiresAt = new Date(now + ttlSeconds * 1000);
  const maxExpiresAt = new Date(now + SPAWN_ABSOLUTE_LIFETIME_SECONDS * 1000);

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
    maxExpiresAt,
  });

  return {
    ok: true,
    token,
    credentialId: (child as { _id: Types.ObjectId })._id,
    expiresAt,
    maxExpiresAt,
    spawnId,
  };
}

/**
 * Extend a live child's expiry — the same value, not a new one (Wren's ruling:
 * rotation cannot reach the http entries the adapter writes into the per-spawn
 * mcp-config, and `readToken` is read once at boot, so a rotating value would
 * either die mid-spawn or have to be carried somewhere that is not rotated).
 *
 * A renewal is a lease extension, never a resurrection: an already-expired or
 * revoked child is refused, because letting a late renewal revive it would make
 * the TTL advisory and the (v) acceptance untrue. Past `maxExpiresAt` the call
 * still succeeds but extends nothing, which is the signal for the caller to
 * stop renewing.
 */
export async function renewSpawnCredential({
  credentialId,
  seatCredentialId,
  ttlSeconds,
}: {
  credentialId: Types.ObjectId | string;
  seatCredentialId: Types.ObjectId | string;
  ttlSeconds?: unknown;
}): Promise<RenewSpawnCredentialResult> {
  const ttl = clampSpawnTtlSeconds(ttlSeconds);
  if (ttl === null) return { ok: false, code: 'invalid_ttl' };

  const row = await AgentCredential.findOne({
    _id: credentialId,
    parentId: seatCredentialId,
    scopes: SPAWN_SCOPE,
  }).select('_id status expiresAt maxExpiresAt').lean() as {
    _id: Types.ObjectId;
    status?: string;
    expiresAt?: Date | null;
    maxExpiresAt?: Date | null;
  } | null;
  if (!row) return { ok: false, code: 'not_found' };

  const now = Date.now();
  const currentExpiry = row.expiresAt ? new Date(row.expiresAt).getTime() : 0;
  if (row.status !== 'active' || currentExpiry <= now) return { ok: false, code: 'not_renewable' };

  const ceiling = row.maxExpiresAt ? new Date(row.maxExpiresAt).getTime() : now;
  const proposed = Math.min(now + ttl * 1000, ceiling);
  if (proposed <= currentExpiry) return { ok: true, expiresAt: new Date(currentExpiry), extended: false };

  const expiresAt = new Date(proposed);
  await AgentCredential.updateOne({ _id: row._id, status: 'active' }, { $set: { expiresAt } });
  return { ok: true, expiresAt, extended: true };
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
  SPAWN_ABSOLUTE_LIFETIME_SECONDS,
  MAX_SPAWN_ID_LENGTH,
  clampSpawnTtlSeconds,
  isSpawnCredential,
  resolveSeatCredential,
  mintSpawnCredential,
  renewSpawnCredential,
  revokeSpawnCredential,
  revokeOrphanSpawnCredentials,
};
Object.assign(module.exports, exports);
