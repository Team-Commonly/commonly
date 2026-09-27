#!/usr/bin/env node
/*
 * Rotate the stored password of every bot user.
 *
 * TASK-163 fixed the mint: new bot users get `crypto.randomBytes(32).toString('hex')`
 * instead of `agent-password-<milliseconds>` (agentIdentityService.ts:505-511).
 * That fix is prospective. Bots created before it still carry a password derived
 * from a clock reading — a millisecond timestamp is guessable, and one leaked bot
 * credential is a token for an installed agent. This script rotates them.
 *
 * Three properties this script is built to have, because it writes credentials to
 * production rows:
 *
 *   1. It goes through the model, not around it. `User` hashes on the pre-save
 *      hook (User.ts:419-421), so the write must be `.save()`; `updateMany`
 *      bypasses the hook and stores the plaintext, and a "rows seen == rows
 *      changed" check cannot tell the two apart. Every save is therefore followed
 *      by a fresh read, and the stored value must be a bcrypt hash and must
 *      differ from the value that was there before.
 *   2. The refusal is settled before the first write. A bot with no stored
 *      password authenticates through a provider; writing one would grant a
 *      password login it never had, which is a change of posture rather than a
 *      rotation. One such bot refuses the whole run — a half-rotated fleet is
 *      not a result an operator can check against a pre-state.
 *   3. The exit status is a function of the report, set once from one place, so
 *      a new condition cannot reach the log without reaching the status.
 *
 * Dry run by default; pass `--apply` to write. The real run happens on the
 * operator's word, never inline in a deploy.
 *
 * Usage:
 *   ts-node backend/scripts/rotate-bot-passwords.ts           # report
 *   ts-node backend/scripts/rotate-bot-passwords.ts --apply   # rotate
 */

import crypto from 'crypto';
import mongoose from 'mongoose';
import User from '../models/User';

export interface RotationReport {
  dryRun: boolean;
  /** Bot users read in this run. */
  examined: number;
  /** Bots carrying a stored password, by label — the ones a real run rotates. */
  toRotate: string[];
  rotated: number;
  /** Bots whose post-save read-back proved a hash that differs from the previous value. */
  verified: number;
  /**
   * Bots whose save did not read back as a fresh hash. The run stops at the
   * first one: the store is not in the state this script assumes.
   */
  unverified: string[];
  /** Bots with no stored password (OAuth-only) — a refusal, not a rotation. */
  withoutPassword: string[];
  /** True when the run refused to write at all. */
  refused: boolean;
  examples: { toRotate: string | null; withoutPassword: string | null };
}

const BCRYPT_HASH = /^\$2[aby]\$/;

export const generateBotPassword = (): string => crypto.randomBytes(32).toString('hex');

const label = (bot: { username?: unknown; _id?: unknown }): string => (
  bot.username ? String(bot.username) : `id:${String(bot._id)}`
);

export async function rotateBotPasswords(
  options: { dryRun?: boolean; generate?: () => string } = {},
): Promise<RotationReport> {
  const dryRun = options.dryRun !== false;
  const generate = options.generate ?? generateBotPassword;

  const bots = await User.find({ isBot: true }).sort({ _id: 1 });
  type BotDoc = (typeof bots)[number];

  const report: RotationReport = {
    dryRun,
    examined: bots.length,
    toRotate: [],
    rotated: 0,
    verified: 0,
    unverified: [],
    withoutPassword: [],
    refused: false,
    examples: { toRotate: null, withoutPassword: null },
  };

  const rotatable: BotDoc[] = [];
  for (const bot of bots) {
    if (!bot.password) {
      report.withoutPassword.push(label(bot));
      if (!report.examples.withoutPassword) report.examples.withoutPassword = label(bot);
      continue;
    }
    rotatable.push(bot);
    report.toRotate.push(label(bot));
    if (!report.examples.toRotate) report.examples.toRotate = label(bot);
  }

  if (report.withoutPassword.length > 0) {
    report.refused = true;
    return report;
  }

  if (dryRun) return report;

  for (const bot of rotatable) {
    const before = String(bot.password);
    bot.password = generate();
    // eslint-disable-next-line no-await-in-loop
    await bot.save();

    // eslint-disable-next-line no-await-in-loop
    const stored = await User.findById(bot._id).lean();
    const value = String((stored as { password?: string } | null)?.password ?? '');
    // Two assertions, each catching a different fault. The prefix catches a
    // write that skipped the hook — plaintext is not a hash. The comparison
    // catches a save that resolved without persisting, whose only signature is
    // a stored value byte-identical to the one the read-back replaced.
    if (!BCRYPT_HASH.test(value) || value === before) {
      report.unverified.push(label(bot));
      break;
    }
    report.rotated += 1;
    report.verified += 1;
  }

  return report;
}

/**
 * The exit status for a finished run.
 *
 * `refused` (2) means nothing was written, so a re-run is safe. An unverified
 * save (3) means a write was attempted and the store does not read back as this
 * script's invariant requires — that can only be discovered after the fact, so
 * it means inspect before touching the rows again. Distinct codes so a scripted
 * caller can tell them apart without parsing the log; refusal wins if both are
 * somehow true, since it is the state in which no write happened at all.
 */
export function exitCodeFor(report: RotationReport): number {
  if (report.refused) return 2;
  if (report.unverified.length > 0) return 3;
  return 0;
}

const nameList = (labels: string[], max = 10): string => {
  if (labels.length <= max) return labels.join(', ') || '(none)';
  return `${labels.slice(0, max).join(', ')}, … +${labels.length - max} more`;
};

export async function main(argv: string[] = process.argv): Promise<void> {
  const dryRun = !argv.includes('--apply');
  await mongoose.connect(process.env.MONGO_URI ?? '');

  const r = await rotateBotPasswords({ dryRun });

  console.log(`[bot-passwords] ${dryRun ? 'DRY RUN (pass --apply to rotate)' : 'APPLIED'}`);
  console.log(`[bot-passwords] bot users examined   : ${r.examined}`);
  console.log(`[bot-passwords] would rotate         : ${r.toRotate.length}`);
  console.log(`[bot-passwords]   ${nameList(r.toRotate)}`);
  console.log(`[bot-passwords] rotated              : ${r.rotated}`);
  console.log(`[bot-passwords] verified as hashes    : ${r.verified}`);
  console.log(`[bot-passwords] unverified           : ${nameList(r.unverified)}`);
  console.log(`[bot-passwords] without a password   : ${nameList(r.withoutPassword)}`);

  if (r.refused) {
    console.error(
      `[bot-passwords] REFUSED: ${r.withoutPassword.length} bot user(s) have no stored password`
      + ' (they authenticate through a provider). Writing one would grant a password login that'
      + ' was never there. Nothing was written.',
    );
  }
  if (r.unverified.length > 0) {
    console.error(
      `[bot-passwords] UNVERIFIED: after ${r.rotated} verified rotation(s), ${r.unverified[0]}`
      + ' did not read back as a fresh bcrypt hash. The run stopped there. Inspect that row before'
      + ' re-running: the store is not in the state this script assumes.',
    );
  }

  // Set once, from the one function that decides status, so a new condition
  // cannot be added to the log without being added to the exit code.
  process.exitCode = exitCodeFor(r);
}

if (require.main === module) {
  main()
    .catch((err) => {
      console.error('[bot-passwords] failed:', err);
      process.exitCode = 1;
    })
    .finally(() => {
      mongoose.connection.close().catch(() => {});
    });
}
