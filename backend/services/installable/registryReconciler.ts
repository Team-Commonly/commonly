/**
 * AgentRegistry -> Installable backfill (ADR-001 Phase 3, step 5).
 *
 * Insert-only. An existing Installable is never $set, nothing is deleted or
 * $unset, and no identity table (User, AgentInstallation, AgentProfile,
 * memory, Pod) is read or written: identity must survive whatever this does.
 * Drift on rows that already exist is counted, not fixed.
 * Guarantees: docs/architecture/installable-registry-bridge.md.
 */

import { registryToInstallable } from './agentRegistryBridge';

// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const Installable = require('../../models/Installable');
// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const { AgentRegistry } = require('../../models/AgentRegistry');

type Obj = Record<string, any>;

export interface RegistrySweepResult {
  dryRun: boolean;
  scanned: number;
  inserted: number;
  existing: number;
  errors: number;
  mismatches: { status: number; stats: number };
}

const isDuplicateKey = (err: unknown): boolean => (err as { code?: number })?.code === 11000;

// Validate first: $setOnInsert skips mongoose's update validators, and an
// invalid row would otherwise land as written.
const buildInsert = (row: Obj): Obj => {
  const mapped = registryToInstallable(row);
  const invalid = new Installable(mapped).validateSync();
  if (invalid) throw invalid;
  return mapped;
};

/**
 * Returns true when this call inserted the row. `timestamps: false` because
 * mongoose otherwise adds `$set: { updatedAt }`, which would touch an existing
 * row; the insert carries its own timestamps instead.
 */
const insertIfMissing = async (mapped: Obj, row: Obj): Promise<boolean> => {
  const now = new Date();
  try {
    const result = await Installable.updateOne(
      { installableId: mapped.installableId },
      { $setOnInsert: { ...mapped, createdAt: row.createdAt || now, updatedAt: now } },
      { upsert: true, timestamps: false },
    );
    return (result.upsertedCount || 0) > 0;
  } catch (err) {
    if (isDuplicateKey(err)) return false;
    throw err;
  }
};

export async function sweepRegistryDrift(
  { dryRun = true }: { dryRun?: boolean } = {},
): Promise<RegistrySweepResult> {
  const result: RegistrySweepResult = {
    dryRun, scanned: 0, inserted: 0, existing: 0, errors: 0, mismatches: { status: 0, stats: 0 },
  };
  const cursor = AgentRegistry.find({}).lean().cursor();
  for await (const row of cursor) {
    result.scanned += 1;
    try {
      const installableId = String(row.agentName).toLowerCase();
      const existing = await Installable.findOne({ installableId })
        .select('status stats.totalInstalls').lean();
      if (existing) {
        result.existing += 1;
        if ((existing.status || 'active') !== (row.status || 'active')) result.mismatches.status += 1;
        if ((existing.stats?.totalInstalls || 0) !== (row.stats?.installs || 0)) result.mismatches.stats += 1;
        continue;
      }
      const mapped = buildInsert(row);
      if (dryRun) {
        result.inserted += 1;
        continue;
      }
      if (await insertIfMissing(mapped, row)) result.inserted += 1;
      else result.existing += 1;
    } catch (err) {
      result.errors += 1;
      console.warn(
        `[registry-reconciler] ${row?.agentName}: ${(err as Error)?.message || err}`,
      );
    }
  }
  return result;
}

/**
 * Best-effort mirror for a write path that touches only AgentRegistry. Never
 * throws: a mirror failure must not fail the request, and the hourly sweep
 * backfills whatever this misses.
 */
export async function mirrorRegistryRow(row: Obj | null | undefined, site: string): Promise<void> {
  if (!row?.agentName) return;
  try {
    await insertIfMissing(buildInsert(row), row);
  } catch (err) {
    console.warn(`[installable-mirror] ${site} ${row.agentName}: ${(err as Error)?.message || err}`);
  }
}

/**
 * Mirrors an AgentRegistry.iconUrl change onto an existing Installable's agent
 * persona. With `onlyIf`, it changes the avatar only while it still holds that
 * value, matching the registry reset's guard. Never inserts, never throws.
 */
export async function mirrorRegistryAvatar(
  agentName: string,
  avatar: string,
  onlyIf?: string,
): Promise<void> {
  try {
    const elem: Obj = { type: 'agent' };
    if (onlyIf !== undefined) elem['persona.avatar'] = onlyIf;
    await Installable.updateOne(
      { installableId: String(agentName).toLowerCase(), components: { $elemMatch: elem } },
      { $set: { 'components.$.persona.avatar': avatar } },
    );
  } catch (err) {
    console.warn(`[installable-mirror] avatar ${agentName}: ${(err as Error)?.message || err}`);
  }
}
