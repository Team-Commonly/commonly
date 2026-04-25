#!/usr/bin/env node
/*
 * Restore the 1:1 invariant on agent-room pods that have accumulated more
 * than two members. Per ADR-001 §3.10 an agent-room is a 1:1 DM whose two
 * members can be (human + agent) OR (agent + agent), and a third party of
 * either kind is never allowed. Live data on dev showed pods of the shape
 * "1 human + N rogue agents that auto-joined via ensureAgentInPod" — the
 * exact bug the runtime guards in PR #232 close going forward. This script
 * cleans up the historical artifacts.
 *
 * Strategy is restoration, not relabeling. The pods were created as DMs
 * and got polluted; we want to undo the pollution, not promote them to
 * `chat` and legitimize it.
 *
 *   For each agent-room with members.length > 2:
 *     humans = members where User.isBot === false
 *     case humans.length === 1:
 *       keep = [pod.createdBy (host agent), the_human]
 *       drop = every other member (rogue agents)
 *       type stays 'agent-room'
 *     case humans.length === 0:
 *       agent↔agent DM. Trust array insertion order — pod was created with
 *       members: [creatorAgent, otherAgent]; later auto-joins appended.
 *       keep = [pod.members[0], pod.members[1]]
 *       drop = every other member
 *       type stays 'agent-room'
 *     case humans.length >= 2:
 *       Was never a DM — multi-human surfaces are chat pods, not DMs.
 *       type → 'chat'. All members preserved.
 *
 * Idempotent: a second run finds zero offenders. Run with `--dry` to print
 * the action plan without writing.
 *
 * Usage:
 *   ts-node backend/scripts/migrate-agent-room-multimember.ts          # apply
 *   ts-node backend/scripts/migrate-agent-room-multimember.ts --dry    # report
 */

import mongoose from 'mongoose';
import Pod from '../models/Pod';
import User from '../models/User';

type Action = 'restore-1to1-human-agent' | 'restore-1to1-agent-agent' | 'convert-to-chat';

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
}

const idStr = (v: any): string => String(v?._id || v);

export async function migrateAgentRoomMultimember(
  options: { dryRun?: boolean } = {},
): Promise<MigrationResult> {
  const dryRun = options.dryRun === true;
  const result: MigrationResult = { total: 0, applied: 0, skipped: 0, plans: [] };

  const cursor = Pod.find({
    type: 'agent-room',
    $expr: { $gt: [{ $size: '$members' }, 2] },
  }).cursor();

  for await (const pod of cursor) {
    result.total += 1;
    const memberIds: string[] = (pod.members || []).map(idStr);

    // Resolve isBot for every member in one round-trip — avoids N+1 lookups.
    const users = await User.find({ _id: { $in: memberIds } })
      .select('_id isBot username')
      .lean();
    const isBotById = new Map<string, boolean>();
    for (const u of users) {
      isBotById.set(String(u._id), Boolean((u as any).isBot));
    }

    // Orphan handling: a member ID with no corresponding User row returns
    // `undefined` from isBotById.get(). Such orphans are NOT counted as
    // humans (the `=== false` check excludes them); they fall through to
    // dropIds in the human↔agent branch and may end up in keepIds at
    // index 0/1 in the agent↔agent branch (we treat them as inert and
    // preserve them so an operator can triage). Either way the migration
    // never silently elevates an orphan to "the human" of a DM.
    const humans = memberIds.filter((id) => isBotById.get(id) === false);
    const hostId = idStr(pod.createdBy);

    let action: Action;
    let keepIds: string[];
    if (humans.length === 1) {
      action = 'restore-1to1-human-agent';
      keepIds = [hostId, humans[0]];
    } else if (humans.length === 0) {
      // Agent↔agent DM. Insertion-order is reliable because:
      //   1. dmService.getOrCreateAgentRoom creates pods with
      //      `members: [hostAgent, otherParty]`.
      //   2. Mongoose `.push()` (the only mutation path used by
      //      ensureAgentInPod / joinPod) appends to the end.
      //   3. No code path uses `$set: { members: [...] }` to reorder
      //      (verified via repo-wide grep at PR-time).
      // So memberIds[0] is always the host agent and memberIds[1] is
      // always the original counter-party. Anything beyond is a rogue.
      action = 'restore-1to1-agent-agent';
      keepIds = [memberIds[0], memberIds[1]];
    } else {
      // Multi-human — was never a DM. Promote to a regular chat pod and
      // keep all members; the privacy filter no longer applies.
      action = 'convert-to-chat';
      keepIds = memberIds;
    }

    // Defensive: if the human↔agent branch picked a `hostId` that isn't
    // actually in `pod.members` (data corruption — a `createdBy` that
    // points outside the membership), skip the pod rather than silently
    // ghosting a 2-member pod with an ID nobody can post as. Logged so
    // an operator can investigate. Detected via the keep-set check rather
    // than upstream because the agent↔agent branch trusts memberIds[0]
    // and memberIds[1] which by construction are real members.
    const skipIfGhost = action === 'restore-1to1-human-agent'
      && !memberIds.includes(hostId);
    if (skipIfGhost) {
      console.warn(
        `[migrate-agent-room] SKIP pod ${pod._id}: createdBy=${hostId} is not in members `
        + `[${memberIds.join(', ')}]. Manual triage required.`,
      );
      result.skipped += 1;
      continue;
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
      // Members unchanged.
    } else {
      pod.members = [...keepSet] as any;
    }
    await pod.save();
    result.applied += 1;
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
    const r = await migrateAgentRoomMultimember({ dryRun });
    console.log(`[migrate-agent-room] ${dryRun ? 'DRY-RUN' : 'APPLIED'}`);
    console.log(`  total offenders : ${r.total}`);
    console.log(`  applied         : ${r.applied}`);
    console.log(`  skipped (dry)   : ${r.skipped}`);
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
