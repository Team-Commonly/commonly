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
 * Why the row and not the user: pod authorization reads the installation's
 * status, so 'stale' 403s every @-mention while the agent User and its pod
 * membership are intact. The fix is the one field.
 */
/* eslint-disable no-console */
import mongoose from 'mongoose';
import { AgentInstallation } from '../models/AgentRegistry';
import { STALENESS_EXEMPT_RUNTIME_TYPES } from '../services/agentInstallationCleanupService';

type StaleRow = {
  _id: unknown;
  agentName: string;
  instanceId?: string;
  staleSince?: Date | null;
};

export type ReviveNativeInstallationsResult = {
  apply: boolean;
  exemptRuntimeTypes: string[];
  candidates: number;
  byAgent: Array<{ agentName: string; instanceId: string; count: number; oldestStaleSince: Date | null }>;
  revived: number;
};

const staleFilter = () => ({
  status: 'stale',
  'config.runtime.runtimeType': { $in: STALENESS_EXEMPT_RUNTIME_TYPES },
});

const modifiedCount = (result: { modifiedCount?: number; nModified?: number } | null | undefined): number => (
  result?.modifiedCount ?? result?.nModified ?? 0
);

export const reviveNativeInstallations = async (
  options: { apply?: boolean } = {},
): Promise<ReviveNativeInstallationsResult> => {
  const apply = options.apply === true;
  const rows = await AgentInstallation.find(staleFilter())
    .select('_id agentName instanceId staleSince')
    .lean() as StaleRow[];

  const groups = new Map<string, ReviveNativeInstallationsResult['byAgent'][number]>();
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

  let revived = 0;
  if (apply && rows.length) {
    const result = await AgentInstallation.updateMany(
      { ...staleFilter(), _id: { $in: rows.map((row) => row._id) } },
      { $set: { status: 'active' }, $unset: { staleSince: 1 } },
    );
    revived = modifiedCount(result);
  }

  return {
    apply,
    exemptRuntimeTypes: [...STALENESS_EXEMPT_RUNTIME_TYPES],
    candidates: rows.length,
    byAgent: Array.from(groups.values()).sort((a, b) => b.count - a.count),
    revived,
  };
};

export const main = async (): Promise<void> => {
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is required');
  await mongoose.connect(process.env.MONGO_URI);
  try {
    const result = await reviveNativeInstallations({ apply: process.argv.includes('--apply') });
    console.log(JSON.stringify(result, null, 2));
    if (!result.apply) {
      console.log(`DRY RUN — ${result.candidates} stale native install(s) would be revived. Re-run with --apply.`);
    } else {
      console.log(`Revived ${result.revived} of ${result.candidates} stale native install(s).`);
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
