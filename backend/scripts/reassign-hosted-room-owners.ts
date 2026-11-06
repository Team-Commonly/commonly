#!/usr/bin/env node
/*
 * Puts the DM rows of hosted agents under their real owners: only an agent's
 * owner counts it against a cap, holds it, and can start or stop it. New rows
 * are written that way (services/dmService.ts); this brings older ones in line.
 *
 * For each DM row of a hosted agent that is not uninstalled:
 *   reassigned  the owner has a row standing: the DM row names them.
 *   retired     every row the owner had is uninstalled, so the agent is gone:
 *               the DM row names them and is uninstalled too.
 *   unresolved  no person owns the agent: reported, never written.
 * A row that is already right is left alone, so a second run changes nothing.
 *
 *   npm run backfill:hosted-room-owners              (dry run, the default)
 *   npm run backfill:hosted-room-owners -- --apply
 *
 * Exits 2 while anything is unresolved. Logs row ids and counts only.
 */
import mongoose from 'mongoose';
import { AgentInstallation } from '../models/AgentRegistry';
import {
  AGENT_ROOM_AUTO_JOIN_SOURCE, isHostedInstallation, readRuntimeConfig, resolveHostedOwner,
} from '../services/hostedRuntimeService';

export interface HostedRoomOwnerReport {
  scanned: number;
  unchanged: number;
  reassigned: string[];
  retired: string[];
  unresolved: string[];
}

export const reassignHostedRoomOwners = async ({ apply = false }: { apply?: boolean } = {}): Promise<HostedRoomOwnerReport> => {
  const report: HostedRoomOwnerReport = { scanned: 0, unchanged: 0, reassigned: [], retired: [], unresolved: [] };
  const rows: any[] = await AgentInstallation.find({
    'config.autoJoinSource': AGENT_ROOM_AUTO_JOIN_SOURCE, status: { $ne: 'uninstalled' },
  }).select('agentName instanceId installedBy config.runtime').lean();
  for (const row of rows) {
    // A row of an older DM may store no runtime and inherit it when it runs, so
    // only a row that names some other runtime is out of scope.
    const hosted = isHostedInstallation(row);
    if (hosted || !readRuntimeConfig(row).runtimeType) {
      report.scanned += 1;
      // eslint-disable-next-line no-await-in-loop
      const owner = await resolveHostedOwner(row.agentName, row.instanceId || 'default', row.installedBy);
      const id = String(row._id);
      if (!owner) {
        if (hosted) report.unresolved.push(id);
        else report.unchanged += 1;
      } else if (owner.live && String(owner.ownerId) === String(row.installedBy)) {
        report.unchanged += 1;
      } else {
        (owner.live ? report.reassigned : report.retired).push(id);
        if (apply) {
          // Conditional, so a row that moved since the read is left for the next run.
          // eslint-disable-next-line no-await-in-loop
          await AgentInstallation.updateOne(
            { _id: row._id, installedBy: row.installedBy },
            { $set: { installedBy: owner.ownerId, ...(owner.live ? {} : { status: 'uninstalled' }) } },
          );
        }
      }
    }
  }
  return report;
};

export const main = async (): Promise<void> => {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== '--apply') || !process.env.MONGO_URI) {
    throw new Error('invalid configuration');
  }
  const apply = args.includes('--apply');
  try {
    await mongoose.connect(process.env.MONGO_URI);
    const report = await reassignHostedRoomOwners({ apply });
    console.log(JSON.stringify({ mode: apply ? 'APPLY' : 'DRY-RUN', ...report }));
    if (report.unresolved.length) process.exitCode = 2;
  } finally {
    await mongoose.disconnect();
  }
};

if (require.main === module) {
  main().catch((error) => {
    console.error('[hosted-room-owners] failed:', (error as Error).message);
    process.exitCode = 1;
  });
}
