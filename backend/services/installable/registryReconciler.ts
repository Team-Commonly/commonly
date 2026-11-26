/**
 * AgentRegistry -> Installable backfill (ADR-001 Phase 3, step 5).
 *
 * Inserts missing rows, and refreshes the display fields of rows it created
 * (marked origin: 'registry-backfill'), never of anything else. Nothing is
 * deleted or $unset, origin/source/owner/published/status are never changed,
 * and no identity table (User, AgentInstallation, AgentProfile, memory, Pod)
 * is read or written: identity must survive whatever this does. Status and
 * stats drift on existing rows is counted, not fixed.
 * Guarantees: docs/architecture/installable-registry-bridge.md.
 */

import {
  DISPLAY_FIELDS, DISPLAY_FIELD_PATHS, bridgeDisplayDiff, registryKeyOf, registryToInstallable,
} from './agentRegistryBridge';
import { REGISTRY_BACKFILL_ORIGIN } from './registryBackfillOrigin';

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
  /** Existing marked rows whose display fields were brought back in line (also counted in existing). */
  refreshed: number;
  /** Registry rows with no usable agentName: never keyed, never written. */
  skipped: number;
  errors: number;
  mismatches: { status: number; stats: number };
}

// What the sweep and refresh read of an existing row: the gates it counts,
// the mark, and every display path, so a diff needs no second read.
const EXISTING_SELECT = Array.from(new Set([
  'installableId', 'origin', 'status', 'stats.totalInstalls', 'components',
  ...DISPLAY_FIELDS.flatMap((f) => DISPLAY_FIELD_PATHS[f].top || []),
])).join(' ');

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

/**
 * Writes the display-field diff onto a marked row. The mark is in the filter
 * itself, so a row that lost it since the read (a marketplace takeover) is
 * never written. Returns true when it wrote (or, in a dry run, would). Throws.
 */
const applyRefresh = async (row: Obj, doc: Obj, dryRun = false): Promise<boolean> => {
  if (!doc || doc.origin !== REGISTRY_BACKFILL_ORIGIN) return false;
  const { top, agent } = bridgeDisplayDiff(registryToInstallable(row), doc);
  const agentKeys = Object.keys(agent);
  if (!Object.keys(top).length && !agentKeys.length) return false;
  if (dryRun) return true;
  const filter: Obj = { installableId: doc.installableId, origin: REGISTRY_BACKFILL_ORIGIN };
  if (agentKeys.length) filter.components = { $elemMatch: { type: 'agent' } };
  const $set: Obj = { ...top };
  agentKeys.forEach((k) => { $set[`components.$.${k}`] = agent[k]; });
  // Timestamps stay on: updatedAt moves only because something really changed.
  // A row that lost its mark since the read matches nothing and counts as no write.
  const res = await Installable.updateOne(filter, { $set });
  return (res?.modifiedCount || 0) > 0;
};

export async function sweepRegistryDrift(
  { dryRun = true }: { dryRun?: boolean } = {},
): Promise<RegistrySweepResult> {
  const result: RegistrySweepResult = {
    dryRun, scanned: 0, inserted: 0, existing: 0, refreshed: 0, skipped: 0, errors: 0,
    mismatches: { status: 0, stats: 0 },
  };
  const cursor = AgentRegistry.find({}).lean().cursor();
  for await (const row of cursor) {
    result.scanned += 1;
    try {
      const installableId = registryKeyOf(row);
      if (!installableId) {
        result.skipped += 1;
        continue;
      }
      const existing = await Installable.findOne({ installableId })
        .select(EXISTING_SELECT).lean();
      if (existing) {
        result.existing += 1;
        // The backstop for edits no mirror saw (a direct DB write, a new path).
        if (await applyRefresh(row, existing, dryRun)) result.refreshed += 1;
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
 * throws: a mirror failure must not fail the request, and the sweep
 * backfills whatever this misses.
 */
export async function mirrorRegistryRow(row: Obj | null | undefined, site: string): Promise<void> {
  if (!row || !registryKeyOf(row)) return;
  try {
    await insertIfMissing(buildInsert(row), row);
  } catch (err) {
    console.warn(`[installable-mirror] ${site} ${row.agentName}: ${(err as Error)?.message || err}`);
  }
}

/**
 * Brings the backfilled Installable for an edited registry row back in line:
 * $sets only the display fields the read path compares (DISPLAY_FIELDS), and
 * only on a row marked origin: 'registry-backfill'. A marketplace listing or
 * a native-seeded builtin has its own write path and is never touched. Skips
 * the write when nothing differs. Never inserts, never throws: a failure must
 * not fail the request, and the sweep refreshes whatever this misses.
 * Returns true when it wrote.
 */
export async function refreshBridgeRow(row: Obj | null | undefined, site: string): Promise<boolean> {
  const installableId = registryKeyOf(row);
  if (!row || !installableId) return false;
  try {
    const doc = await Installable.findOne({ installableId, origin: REGISTRY_BACKFILL_ORIGIN })
      .select(EXISTING_SELECT).lean();
    return await applyRefresh(row, doc);
  } catch (err) {
    console.warn(`[installable-mirror] refresh ${site} ${row.agentName}: ${(err as Error)?.message || err}`);
    return false;
  }
}

/**
 * Mirrors an AgentRegistry.iconUrl change onto an existing backfilled
 * Installable's agent persona. With `onlyIf`, it changes the avatar only while it still holds that
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
    // Backfilled rows only: an installer's pick must never restyle a listing
    // another publisher owns.
    await Installable.updateOne(
      {
        installableId: String(agentName).toLowerCase(),
        origin: REGISTRY_BACKFILL_ORIGIN,
        components: { $elemMatch: elem },
      },
      { $set: { 'components.$.persona.avatar': avatar } },
    );
  } catch (err) {
    console.warn(`[installable-mirror] avatar ${agentName}: ${(err as Error)?.message || err}`);
  }
}
