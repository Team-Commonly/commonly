/**
 * Revive native AgentInstallation rows the staleness cron marked before native
 * runtimes were exempt from it (agentInstallationCleanupService, TASK-041).
 *
 * Dry run is the default and prints the count:
 *   npm run revive:native-installations
 * Apply:
 *   npm run revive:native-installations -- --apply
 *
 * What it does: every row with `status: 'stale'` whose
 * `config.runtime.runtimeType` is in STALENESS_EXEMPT_RUNTIME_TYPES goes back
 * to `status: 'active'` with `staleSince` cleared. Idempotent — a second run
 * finds nothing. It cannot restore rows the prune step already deleted (14 d
 * after staleSince); those are reinstalls, not revivals, and the count here
 * says nothing about them.
 *
 * Pre-runtime rows: installs written under the early first-teammate shape
 * (2026-09-01/02) carry no `config.runtime` at all. Reviving those alone is a
 * one-day fix — the sweep's `$nin` treats a missing runtimeType as sweepable,
 * so they go stale again at the next 04:00. Such a row is backfilled with
 * `config.runtime.runtimeType` first, in the same `--apply`, and only when the
 * agent's AgentRegistry row declares an exempt runtime. The registry's
 * ManifestRuntimeSchema is strict and drops `runtime.runtimeType` on write
 * (measured 2026-09-18 with the seed's own upsert shape), so the declaration
 * is read from `manifest.runtime.type` as well; either field counts, but only
 * a value that names an exempt runtime backfills — a deployment-shape value
 * (`standalone` / `commonly-hosted` / `hybrid`) never does. A stale row whose
 * agent has no registry declaration is reported under `backfill.skipped` and
 * left untouched.
 *
 * Why the row and not the user: pod authorization reads the installation's
 * status, so 'stale' 403s every @-mention while the agent User and its pod
 * membership are intact. The fix is the one field.
 */
/* eslint-disable no-console */
import mongoose from 'mongoose';
import { AgentInstallation, AgentRegistry } from '../models/AgentRegistry';
import { STALENESS_EXEMPT_RUNTIME_TYPES } from '../services/agentInstallationCleanupService';

type StaleRow = {
  _id: unknown;
  agentName: string;
  instanceId?: string;
  staleSince?: Date | null;
};

type ByAgentRow = { agentName: string; instanceId: string; count: number; oldestStaleSince: Date | null };

export type ReviveNativeInstallationsResult = {
  apply: boolean;
  exemptRuntimeTypes: string[];
  /** Every stale row that would be (or was) revived: typed native rows plus eligible pre-runtime rows. */
  candidates: number;
  byAgent: ByAgentRow[];
  /** Stale rows with no `config.runtime.runtimeType`, resolved against the registry. */
  backfill: {
    candidates: number;
    eligible: number;
    byAgent: ByAgentRow[];
    skipped: Array<{ agentName: string; count: number; reason: string }>;
    applied: number;
  };
  revived: number;
};

const staleFilter = () => ({
  status: 'stale',
  'config.runtime.runtimeType': { $in: STALENESS_EXEMPT_RUNTIME_TYPES },
});

const preRuntimeFilter = () => ({
  status: 'stale',
  'config.runtime.runtimeType': { $exists: false },
});

/**
 * The runtime an AgentRegistry row declares for its agent, or '' when it
 * declares nothing usable. `runtime.runtimeType` is the dedicated identity
 * field the installer reads; `runtime.type` is where the seed's value actually
 * survives the strict subschema. Only an exempt runtime name is returned —
 * deployment-shape values are not runtime identities.
 */
export const declaredExemptRuntime = (
  registry: { manifest?: { runtime?: { runtimeType?: unknown; type?: unknown } | null } | null } | null | undefined,
): string => {
  const runtime = registry?.manifest?.runtime || {};
  for (const raw of [runtime.runtimeType, runtime.type]) {
    const value = String(raw || '').trim().toLowerCase();
    if (value && STALENESS_EXEMPT_RUNTIME_TYPES.includes(value)) return value;
  }
  return '';
};

const groupByAgent = (rows: StaleRow[]): ByAgentRow[] => {
  const groups = new Map<string, ByAgentRow>();
  for (const row of rows) {
    const instanceId = String(row.instanceId || 'default');
    const key = `${row.agentName}::${instanceId}`;
    const group = groups.get(key) || { agentName: row.agentName, instanceId, count: 0, oldestStaleSince: null };
    group.count += 1;
    const since = row.staleSince ? new Date(row.staleSince) : null;
    if (since && !Number.isNaN(since.getTime()) && (!group.oldestStaleSince || since < group.oldestStaleSince)) {
      group.oldestStaleSince = since;
    }
    groups.set(key, group);
  }
  return Array.from(groups.values()).sort((a, b) => b.count - a.count);
};

const modifiedCount = (result: { modifiedCount?: number; nModified?: number } | null | undefined): number => (
  result?.modifiedCount ?? result?.nModified ?? 0
);

export const reviveNativeInstallations = async (
  options: { apply?: boolean } = {},
): Promise<ReviveNativeInstallationsResult> => {
  const apply = options.apply === true;
  const select = '_id agentName instanceId staleSince';
  const typedRows = await AgentInstallation.find(staleFilter()).select(select).lean() as StaleRow[];
  const preRuntimeRows = await AgentInstallation.find(preRuntimeFilter()).select(select).lean() as StaleRow[];

  // Resolve each pre-runtime agent against its registry declaration once.
  const agentNames = Array.from(new Set(preRuntimeRows.map((row) => String(row.agentName || '').toLowerCase())));
  const registryRows = agentNames.length
    ? await AgentRegistry.find({ agentName: { $in: agentNames } }).select('agentName manifest.runtime').lean()
    : [];
  const declaredByAgent = new Map<string, string>();
  type RegistryRuntimeRow = { agentName: string; manifest?: { runtime?: { runtimeType?: unknown; type?: unknown } } };
  for (const registry of registryRows as RegistryRuntimeRow[]) {
    declaredByAgent.set(String(registry.agentName).toLowerCase(), declaredExemptRuntime(registry));
  }

  const eligibleRows: StaleRow[] = [];
  const skippedCounts = new Map<string, { count: number; reason: string }>();
  for (const row of preRuntimeRows) {
    const agentName = String(row.agentName || '').toLowerCase();
    const declared = declaredByAgent.get(agentName);
    if (declared) {
      eligibleRows.push(row);
      continue;
    }
    const reason = declaredByAgent.has(agentName)
      ? 'registry row declares no exempt runtime'
      : 'no registry row';
    const entry = skippedCounts.get(agentName) || { count: 0, reason };
    entry.count += 1;
    skippedCounts.set(agentName, entry);
  }
  const skipped = Array.from(skippedCounts.entries())
    .map(([agentName, entry]) => ({ agentName, ...entry }))
    .sort((a, b) => b.count - a.count || a.agentName.localeCompare(b.agentName));

  let applied = 0;
  let revived = 0;
  if (apply && eligibleRows.length) {
    // One update per declared runtime, so a future second exempt runtime
    // backfills its own name rather than the first one in the list.
    const byRuntime = new Map<string, unknown[]>();
    for (const row of eligibleRows) {
      const runtime = declaredByAgent.get(String(row.agentName || '').toLowerCase()) as string;
      byRuntime.set(runtime, [...(byRuntime.get(runtime) || []), row._id]);
    }
    for (const [runtime, ids] of byRuntime) {
      // eslint-disable-next-line no-await-in-loop
      const result = await AgentInstallation.updateMany(
        { ...preRuntimeFilter(), _id: { $in: ids } },
        { $set: { 'config.runtime.runtimeType': runtime } },
      );
      applied += modifiedCount(result);
    }
  }
  const ids = [...typedRows, ...eligibleRows].map((row) => row._id);
  if (apply && ids.length) {
    // The filter re-checks runtimeType, so a pre-runtime row whose backfill
    // did not land is never flipped to active.
    const result = await AgentInstallation.updateMany(
      { ...staleFilter(), _id: { $in: ids } },
      { $set: { status: 'active' }, $unset: { staleSince: 1 } },
    );
    revived = modifiedCount(result);
  }

  return {
    apply,
    exemptRuntimeTypes: [...STALENESS_EXEMPT_RUNTIME_TYPES],
    candidates: typedRows.length + eligibleRows.length,
    byAgent: groupByAgent([...typedRows, ...eligibleRows]),
    backfill: {
      candidates: preRuntimeRows.length,
      eligible: eligibleRows.length,
      byAgent: groupByAgent(eligibleRows),
      skipped,
      applied,
    },
    revived,
  };
};

export const main = async (): Promise<void> => {
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is required');
  await mongoose.connect(process.env.MONGO_URI);
  try {
    const result = await reviveNativeInstallations({ apply: process.argv.includes('--apply') });
    console.log(JSON.stringify(result, null, 2));
    const backfillNote = `${result.backfill.eligible} of them pre-runtime rows backfilled from the registry first, `
      + `${result.backfill.candidates - result.backfill.eligible} pre-runtime row(s) skipped`;
    if (!result.apply) {
      console.log(
        `DRY RUN — ${result.candidates} stale native install(s) would be revived (${backfillNote}). Re-run with --apply.`,
      );
    } else {
      console.log(`Revived ${result.revived} of ${result.candidates} stale native install(s) (${backfillNote}).`);
    }
  } finally {
    await mongoose.disconnect();
  }
};

if (require.main === module) {
  main().catch((error) => {
    console.error('revive-native-installations failed:', error);
    process.exit(1);
  });
}
