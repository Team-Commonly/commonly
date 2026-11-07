#!/usr/bin/env node
/*
 * Puts the DM rows of hosted agents under their real owners: only an agent's
 * owner counts it against a cap, holds it, and can start or stop it. New rows
 * are written that way (services/dmService.ts); this brings older ones in line.
 *
 * For each DM row of a hosted agent that is not uninstalled, the owner is the
 * one resolved for the person in the room, not whoever the row names now:
 *   reassigned  the owner has a row standing: the DM row names them.
 *   retired     every row the owners had is uninstalled, so the agent is gone:
 *               the DM row is uninstalled, and names the owner if there is one
 *               the person shares a pod with.
 *   unresolved  reported, never written. No person owns the agent, the room has
 *               no one person in it, the person shares no pod with any owner,
 *               or the row is running and every owner paused the agent.
 * A row that is already right is left alone, so a second run changes nothing.
 * A paused agent's rooms stay where they are: paused is not gone.
 *
 *   npm run backfill:hosted-room-owners              (dry run, the default)
 *   npm run backfill:hosted-room-owners -- --apply
 *
 * Exits 2 while anything is unresolved. Logs row ids and counts only.
 */
import mongoose from 'mongoose';
import { AgentInstallation } from '../models/AgentRegistry';
import Pod from '../models/Pod';
import User from '../models/User';
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

// The one person in a room. An agent-room is 1:1, so anything else can't say whose
// DM this is. Null then, and when the person's account is gone.
const roomPerson = async (podId: unknown): Promise<unknown> => {
  const room = await Pod.findById(podId).select('members').lean<{ members?: unknown[] } | null>();
  const people = await User.find({ _id: { $in: room?.members || [] }, isBot: { $ne: true } })
    .select('_id').limit(2).lean();
  return people.length === 1 ? people[0]._id : null;
};

export const reassignHostedRoomOwners = async ({ apply = false }: { apply?: boolean } = {}): Promise<HostedRoomOwnerReport> => {
  const report: HostedRoomOwnerReport = { scanned: 0, unchanged: 0, reassigned: [], retired: [], unresolved: [] };
  const rows: any[] = await AgentInstallation.find({
    'config.autoJoinSource': AGENT_ROOM_AUTO_JOIN_SOURCE, status: { $ne: 'uninstalled' },
  }).select('agentName instanceId podId installedBy status config.runtime').lean();
  for (const row of rows) {
    // A row of an older DM may store no runtime and inherit it when it runs, so
    // only a row that names some other runtime is out of scope.
    const hosted = isHostedInstallation(row);
    if (hosted || !readRuntimeConfig(row).runtimeType) {
      report.scanned += 1;
      // eslint-disable-next-line no-await-in-loop
      const owner = await resolveHostedOwner(row.agentName, row.instanceId || 'default', await roomPerson(row.podId));
      const id = String(row._id);
      if (!owner) {
        if (hosted) report.unresolved.push(id);
        else report.unchanged += 1;
      } else if (owner.live && !owner.ownerId) {
        report.unresolved.push(id);
      } else if (owner.live && String(owner.ownerId) === String(row.installedBy)) {
        report.unchanged += 1;
      } else if (owner.paused && row.status !== 'paused') {
        report.unresolved.push(id);
      } else {
        (owner.live ? report.reassigned : report.retired).push(id);
        if (apply) {
          // Conditional, so a row that moved since the read is left for the next run.
          // eslint-disable-next-line no-await-in-loop
          await AgentInstallation.updateOne(
            { _id: row._id, installedBy: row.installedBy },
            { $set: { ...(owner.ownerId ? { installedBy: owner.ownerId } : {}), ...(owner.live ? {} : { status: 'uninstalled' }) } },
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
