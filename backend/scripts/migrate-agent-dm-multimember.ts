#!/usr/bin/env node
/*
 * Restore the 1:1 invariant on `agent-dm` pods that have accumulated more
 * than two members. Sibling to `migrate-agent-room-multimember.ts` — same
 * rationale, different pod type. Per ADR-001 §3.10 an `agent-dm` is a 1:1
 * DM whose two members can be (human + agent) OR (agent + agent), and a
 * third party of either kind is never allowed. The runtime guard expansion
 * in `agentIdentityService.DM_POD_TYPES_GUARD` closes the bug going
 * forward; this script cleans up the historical artifacts (live data
 * showed agent-dm pods with 3 bot members where a stray
 * `ensureAgentInPod` had silently appended a third agent).
 *
 * Strategy is restoration, not relabeling. Pods were created as 2-member
 * DMs and got polluted; we want to undo the pollution.
 *
 *   For each agent-dm with members.length > 2:
 *     humans = members where User.isBot === false
 *     case humans.length >= 2:
 *       Was never a DM (multi-human). Promote to `chat`. All members preserved.
 *     case humans.length === 1:
 *       keep = [the_human, pod.members[0|1] whichever is the bot peer the
 *               creator wired in]. The 1-human-+-N-bots shape didn't exist
 *               in agent-dm by design, but defend symmetrically with
 *               agent-room: keep the human + the FIRST bot in member order
 *               (mirrors getOrCreateAgentDmRoom's `members: [aId, bId]`).
 *     case humans.length === 0:
 *       Agent↔agent DM. Trust array insertion order:
 *         1. dmService.getOrCreateAgentDmRoom creates pods with
 *            `members: [aId, bId]`.
 *         2. ensureAgentInPod / joinPod append via `.push()`.
 *         3. No code path reorders via `$set: { members: [...] }`
 *            (verified via repo-wide grep at PR-time).
 *       So memberIds[0] + memberIds[1] are the original peers; anything
 *       beyond is a rogue.
 *
 * Idempotent: a second run finds zero offenders. Run with `--dry` to see
 * the action plan without writing.
 *
 * Side effects:
 *   - PG `pod_members` is synced for each removed member (best-effort;
 *     if PG is unreachable, MongoDB is the source of truth and the next
 *     PG sync will reconcile via dmService).
 *   - `AgentInstallation` rows for removed bot members in this pod are
 *     marked `status: 'removed'` so `agentRuntimeAuth` no longer
 *     authorizes them. We don't `deleteMany` because identity continuity
 *     (the agent's User row) survives package reinstall — see
 *     CLAUDE.md "Identity is separate from package."
 *
 * Usage:
 *   ts-node backend/scripts/migrate-agent-dm-multimember.ts          # apply
 *   ts-node backend/scripts/migrate-agent-dm-multimember.ts --dry    # report
 */

import mongoose from 'mongoose';
import Pod from '../models/Pod';
import User from '../models/User';
import { AgentInstallation } from '../models/AgentRegistry';

let PGPod: { removeMember?: (podId: string, userId: string) => Promise<unknown> } | null = null;
try {
  // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
  PGPod = require('../models/pg/Pod');
} catch {
  PGPod = null;
}

type Action = 'restore-1to1-agent-agent' | 'restore-1to1-human-agent' | 'convert-to-chat';

interface Plan {
  podId: string;
  name: string;
  action: Action;
  before: number;
  after: number;
  keepIds: string[];
  dropIds: string[];
}

interface MigrationResult {
  total: number;
  applied: number;
  skipped: number;
  plans: Plan[];
  pgSynced: number;
  installationsDeactivated: number;
}

const idStr = (v: any): string => String(v?._id || v);

export async function migrateAgentDmMultimember(
  options: { dryRun?: boolean } = {},
): Promise<MigrationResult> {
  const dryRun = options.dryRun === true;
  const result: MigrationResult = {
    total: 0,
    applied: 0,
    skipped: 0,
    plans: [],
    pgSynced: 0,
    installationsDeactivated: 0,
  };

  const cursor = Pod.find({
    type: 'agent-dm',
    $expr: { $gt: [{ $size: '$members' }, 2] },
  }).cursor();

  for await (const pod of cursor) {
    result.total += 1;
    const memberIds: string[] = (pod.members || []).map(idStr);

    const users = await User.find({ _id: { $in: memberIds } })
      .select('_id isBot username')
      .lean();
    const isBotById = new Map<string, boolean>();
    for (const u of users) {
      isBotById.set(String(u._id), Boolean((u as any).isBot));
    }

    const humans = memberIds.filter((id) => isBotById.get(id) === false);
    const bots = memberIds.filter((id) => isBotById.get(id) === true);

    let action: Action;
    let keepIds: string[];

    if (humans.length >= 2) {
      action = 'convert-to-chat';
      keepIds = memberIds; // promote, preserve everyone
    } else if (humans.length === 1) {
      // Defensive shape: agent-dm wasn't designed to ever hold a single
      // human (that's agent-room's role), but if it shows up, restore as
      // human + first bot in member order — same idea as agent-room migrator.
      action = 'restore-1to1-human-agent';
      const firstBot = bots[0];
      if (!firstBot) {
        console.warn(`[migrate-agent-dm] SKIP pod ${pod._id}: 1 human, 0 bots — degenerate shape`);
        result.skipped += 1;
        continue;
      }
      keepIds = [humans[0], firstBot];
    } else {
      // Agent↔agent — keep the original two by insertion order.
      action = 'restore-1to1-agent-agent';
      keepIds = [memberIds[0], memberIds[1]];
    }

    const keepSet = new Set(keepIds);
    const dropIds = memberIds.filter((id) => !keepSet.has(id));

    const plan: Plan = {
      podId: String(pod._id),
      name: pod.name || '(unnamed)',
      action,
      before: memberIds.length,
      after: keepSet.size,
      keepIds: [...keepSet],
      dropIds,
    };
    result.plans.push(plan);

    if (dryRun) {
      result.skipped += 1;
      continue;
    }

    if (action === 'convert-to-chat') {
      pod.type = 'chat';
    } else {
      pod.members = [...keepSet] as any;
    }
    await pod.save();
    result.applied += 1;

    // Sync PG and clean up AgentInstallation only for the trim cases —
    // a chat-promotion preserves all members, so neither cleanup applies.
    if (action !== 'convert-to-chat' && dropIds.length > 0) {
      // PG pod_members — best-effort; failures don't roll back Mongo.
      if (PGPod && typeof PGPod.removeMember === 'function' && process.env.PG_HOST) {
        for (const dropId of dropIds) {
          try {
            await PGPod.removeMember(String(pod._id), dropId);
            result.pgSynced += 1;
          } catch (pgErr) {
            console.warn(
              `[migrate-agent-dm] PG removeMember failed for pod=${pod._id} user=${dropId}:`,
              (pgErr as Error).message,
            );
          }
        }
      }

      // Deactivate AgentInstallation rows for dropped bot members so
      // their runtime tokens stop authorizing this pod. User rows stay —
      // identity is separate from package.
      const droppedBotUserIds = dropIds.filter((id) => isBotById.get(id) === true);
      if (droppedBotUserIds.length > 0) {
        try {
          // Map User._id -> agentName + instanceId via botMetadata so the
          // (agentName, podId, instanceId) AgentInstallation key resolves.
          const droppedBots = await User.find({ _id: { $in: droppedBotUserIds } })
            .select('_id username botMetadata')
            .lean<Array<{ _id: unknown; username?: string; botMetadata?: { agentName?: string; instanceId?: string } }>>();

          for (const bot of droppedBots) {
            const agentName = (bot.botMetadata?.agentName || bot.username || '').toLowerCase();
            const instanceId = bot.botMetadata?.instanceId || 'default';
            if (!agentName) continue;
            const updateRes = await AgentInstallation.updateMany(
              { agentName, podId: pod._id, instanceId, status: { $ne: 'removed' } },
              { $set: { status: 'removed' } },
            );
            result.installationsDeactivated += (updateRes as { modifiedCount?: number }).modifiedCount || 0;
          }
        } catch (instErr) {
          console.warn(
            `[migrate-agent-dm] AgentInstallation cleanup failed for pod=${pod._id}:`,
            (instErr as Error).message,
          );
        }
      }
    }
  }

  return result;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry');
  const mongoUri = process.env.MONGO_URI;
  if (!mongoUri) {
    console.error('MONGO_URI not set');
    process.exit(1);
  }

  await mongoose.connect(mongoUri);
  try {
    const r = await migrateAgentDmMultimember({ dryRun });
    console.log(`[migrate-agent-dm] ${dryRun ? 'DRY-RUN' : 'APPLIED'}`);
    console.log(`  total offenders          : ${r.total}`);
    console.log(`  applied                  : ${r.applied}`);
    console.log(`  skipped (dry / degen)    : ${r.skipped}`);
    console.log(`  pg member rows removed   : ${r.pgSynced}`);
    console.log(`  installations deactivated: ${r.installationsDeactivated}`);
    if (r.plans.length > 0) {
      console.log('  per-pod plan:');
      for (const p of r.plans) {
        console.log(
          `    - ${p.podId}  "${p.name}"  ${p.action}  members ${p.before} → ${p.after}`,
        );
        if (p.dropIds.length > 0) {
          console.log(`        drop: ${p.dropIds.join(', ')}`);
        }
      }
    }
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
