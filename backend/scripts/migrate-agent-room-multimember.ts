#!/usr/bin/env node
/*
 * Find every Pod with `type: 'agent-room'` that has more than 2 members and
 * convert it to `type: 'chat'`. Agent rooms are strictly 1:1 per ADR-001
 * §3.10; pods with 3+ members were never DMs in the corrected model and
 * belong under the regular chat surface. Conversion preserves all messages,
 * members, and createdBy — only the type field changes.
 *
 * Idempotent: a second run after the migration finds zero offenders. Run
 * with `--dry` to print the offenders without writing. Partially-applied
 * runs are safe to re-run — the script picks up where it left off.
 *
 * Downstream consequences operators should be aware of before running:
 *   - UI: migrated pods move from the "Agent DMs" tab to the regular chats
 *     surface. Users with a stale URL bookmarked under /pods/agent-room/<id>
 *     may need to refresh.
 *   - Privacy filter: `agent-room` pods are membership-filtered in
 *     getAllPods/getPodsByType; `chat` pods are not. After conversion the
 *     pod becomes visible to non-members of the same type filter (i.e.,
 *     it now behaves like any other chat pod the user is a member of).
 *   - Auto-join: `agentAutoJoinService` scans pods by `createdBy` without
 *     a type filter. Migrated pods retain their `createdBy: <agent>` field
 *     and become candidates for the agent-owned-pod auto-join scan. If
 *     `autoJoinAgentOwnedPods` is set anywhere, audit the resulting
 *     candidate list before running on prod.
 *
 * Usage:
 *   ts-node backend/scripts/migrate-agent-room-multimember.ts          # apply
 *   ts-node backend/scripts/migrate-agent-room-multimember.ts --dry    # report
 */

import mongoose from 'mongoose';
import Pod from '../models/Pod';

interface MigrationResult {
  total: number;
  converted: number;
  skipped: number;
  offenders: Array<{ id: string; name: string; memberCount: number }>;
}

export async function migrateAgentRoomMultimember(
  options: { dryRun?: boolean } = {},
): Promise<MigrationResult> {
  const dryRun = options.dryRun === true;
  const result: MigrationResult = { total: 0, converted: 0, skipped: 0, offenders: [] };

  // Pods of type agent-room with members.length > 2. Use $expr so the
  // size check happens server-side rather than streaming everything back.
  const cursor = Pod.find({
    type: 'agent-room',
    $expr: { $gt: [{ $size: '$members' }, 2] },
  }).cursor();

  for await (const pod of cursor) {
    result.total += 1;
    const memberCount = Array.isArray(pod.members) ? pod.members.length : 0;
    result.offenders.push({
      id: pod._id.toString(),
      name: pod.name || '(unnamed)',
      memberCount,
    });

    if (dryRun) {
      result.skipped += 1;
      continue;
    }

    pod.type = 'chat';
    await pod.save();
    result.converted += 1;
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
    console.log(`  converted       : ${r.converted}`);
    console.log(`  skipped (dry)   : ${r.skipped}`);
    if (r.offenders.length > 0) {
      console.log('  pods:');
      for (const o of r.offenders) {
        console.log(`    - ${o.id}  (${o.memberCount} members)  "${o.name}"`);
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
