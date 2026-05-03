#!/usr/bin/env node
/*
 * Rename existing `agent-dm` pods whose name was generated from the
 * runtime-leaning `botMetadata.agentName` ('openclaw' for every OpenClaw-
 * driven agent) instead of the curated `botMetadata.displayName`.
 *
 * Symptom on dev: pod named "openclaw ↔ openclaw" with members aria + pixel
 * (both stored as `agentName: 'openclaw', instanceId: 'aria' | 'pixel'`).
 * The runtime fix in this PR makes new pods compute the right name, but
 * existing pods keep their broken name until we re-derive it.
 *
 * Strategy:
 *   For each agent-dm pod:
 *     1. Pull the bot User rows for both members.
 *     2. Compute the desired name from each member's display label using
 *        the same fallback as `dmService.getOrCreateAgentDmRoom`:
 *          botMetadata.displayName → instanceId (if != 'default') → username.
 *     3. If the desired name differs from the stored name, update Mongo.
 *        Best-effort sync the PG `pods` row's name too (optional cosmetic).
 *
 * Idempotent. Run with `--dry` to preview.
 *
 * Usage (from /app inside the backend pod):
 *   node dist/scripts/rename-agent-dm-pods.js --dry
 *   node dist/scripts/rename-agent-dm-pods.js
 */

import mongoose from 'mongoose';
import Pod from '../models/Pod';
import User from '../models/User';

let dbPg: { pool: { query: (sql: string, params?: unknown[]) => Promise<unknown> } } | null = null;
try {
  // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
  dbPg = require('../config/db-pg');
} catch {
  dbPg = null;
}

interface Plan {
  podId: string;
  before: string;
  after: string;
  members: Array<{ id: string; label: string }>;
}

interface RenameResult {
  total: number;
  applied: number;
  skipped: number;
  pgSynced: number;
  plans: Plan[];
}

interface BotMetadata {
  displayName?: string;
  instanceId?: string;
  agentName?: string;
}

function labelFor(user: { username?: string; botMetadata?: BotMetadata } | null): string {
  if (!user) return 'unknown';
  const meta = user.botMetadata;
  const display = meta?.displayName?.trim();
  if (display) return display;
  const instanceId = meta?.instanceId?.trim();
  if (instanceId && instanceId !== 'default') return instanceId;
  return user.username || 'unknown';
}

export async function renameAgentDmPods(
  options: { dryRun?: boolean } = {},
): Promise<RenameResult> {
  const dryRun = options.dryRun === true;
  const result: RenameResult = { total: 0, applied: 0, skipped: 0, pgSynced: 0, plans: [] };

  const cursor = Pod.find({ type: 'agent-dm' }).cursor();

  for await (const pod of cursor) {
    result.total += 1;
    const memberIds: string[] = (pod.members || []).map((m: any) => String(m?._id || m));
    if (memberIds.length !== 2) {
      // Out of scope — the dedup migration handles non-2-member rooms.
      result.skipped += 1;
      continue;
    }

    const users = await User.find({ _id: { $in: memberIds } })
      .select('_id username botMetadata')
      .lean<Array<{ _id: unknown; username?: string; botMetadata?: BotMetadata }>>();
    // Preserve member order when computing the label so the name reflects
    // the insertion-time pair (memberA ↔ memberB).
    const userById = new Map<string, { username?: string; botMetadata?: BotMetadata }>();
    for (const u of users) {
      userById.set(String(u._id), { username: u.username, botMetadata: u.botMetadata });
    }
    const labels = memberIds.map((id) => labelFor(userById.get(id) || null));
    const desiredName = `${labels[0]} ↔ ${labels[1]}`;
    const currentName = String(pod.name || '');

    if (currentName === desiredName) {
      result.skipped += 1;
      continue;
    }

    const plan: Plan = {
      podId: String(pod._id),
      before: currentName,
      after: desiredName,
      members: memberIds.map((id, i) => ({ id, label: labels[i] })),
    };
    result.plans.push(plan);

    if (dryRun) continue;

    pod.name = desiredName;
    // Description tracks the same identities; cheap to refresh.
    const isBotPair = users.every((u) => u.botMetadata?.agentName);
    pod.description = isBotPair
      ? `Agent-to-agent DM — ${labels[0]} and ${labels[1]}`
      : `Direct message — ${labels[0]} and ${labels[1]}`;
    await pod.save();
    result.applied += 1;

    // PG cosmetic sync — `pods.name` is a display copy, not load-bearing
    // for routing. Best-effort; failures don't roll back Mongo.
    // PG `pods.id` stores the Mongo `_id.toString()` (single source of
    // truth for cross-DB routing); there is no `_id` column.
    if (dbPg && process.env.PG_HOST) {
      try {
        await dbPg.pool.query(
          'UPDATE pods SET name = $1 WHERE id = $2',
          [desiredName, String(pod._id)],
        );
        result.pgSynced += 1;
      } catch (pgErr) {
        console.warn(
          `[rename-agent-dm] PG name update failed for pod=${pod._id}:`,
          (pgErr as Error).message,
        );
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
    const r = await renameAgentDmPods({ dryRun });
    console.log(`[rename-agent-dm] ${dryRun ? 'DRY-RUN' : 'APPLIED'}`);
    console.log(`  pods scanned          : ${r.total}`);
    console.log(`  renamed               : ${r.applied}`);
    console.log(`  skipped (already ok)  : ${r.skipped}`);
    console.log(`  pg names synced       : ${r.pgSynced}`);
    if (r.plans.length > 0) {
      console.log('  changes:');
      for (const p of r.plans) {
        console.log(`    - ${p.podId}`);
        console.log(`        before: ${JSON.stringify(p.before)}`);
        console.log(`        after : ${JSON.stringify(p.after)}`);
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
