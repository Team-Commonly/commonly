#!/usr/bin/env node
/*
 * F202: put capped tool-call expiries back in the expiry sweep's retry.
 *
 * An expired broker approval whose side effects (the refusal trail, the
 * `approval.resolved` wake, the card) keep failing is retried with backoff for
 * about six hours, then the sweep logs "gave up" and stops selecting it. Once
 * the cause is fixed, this script finds those rows (expired, no
 * `expirySideEffectsDoneAt`, `expiryRetryCount` at the cap) and resets their
 * count to 0, so the next sweep retries them on the normal schedule. Every
 * side effect is safe to repeat, so a requeued row never doubles its trail
 * or its wake.
 *
 * A dry run by default: it lists the capped rows and writes nothing. It
 * writes only with an explicit --apply, and refuses any other argument.
 *
 * Usage:
 *   cd backend && node dist/scripts/retry-capped-approval-expiries.js          # dry run
 *   cd backend && node dist/scripts/retry-capped-approval-expiries.js --apply
 */

/* eslint-disable no-console */
import mongoose from 'mongoose';
import ApprovalAction from '../models/ApprovalAction';
import { MAX_EXPIRY_RETRIES } from '../services/approvalActionService';

const CAPPED = {
  status: 'expired',
  actionType: 'tool_call',
  expirySideEffectsDoneAt: null,
  expiryRetryCount: { $gte: MAX_EXPIRY_RETRIES },
};

export interface CappedExpiry {
  approvalId: string;
  podId: string;
  agentName: string;
  resolvedAt?: Date;
  expiryRetryClaimedAt?: Date;
  expiryRetryCount: number;
}

export const listCappedExpiries = async (): Promise<CappedExpiry[]> => {
  const rows = await ApprovalAction.find(CAPPED)
    .select('_id podId agentName resolvedAt expiryRetryClaimedAt expiryRetryCount')
    .sort({ resolvedAt: 1 })
    .lean() as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    approvalId: String(row._id),
    podId: String(row.podId),
    agentName: String(row.agentName),
    resolvedAt: row.resolvedAt as Date | undefined,
    expiryRetryClaimedAt: row.expiryRetryClaimedAt as Date | undefined,
    expiryRetryCount: Number(row.expiryRetryCount),
  }));
};

/** Reset each still-capped row's count; a row finished meanwhile is left alone. */
export const requeueCappedExpiries = async (approvalIds: string[]): Promise<number> => {
  if (!approvalIds.length) return 0;
  const result = await ApprovalAction.updateMany(
    { ...CAPPED, _id: { $in: approvalIds } },
    { $set: { expiryRetryCount: 0 } },
  );
  return result.modifiedCount ?? 0;
};

export const parseArgs = (argv: string[]): { apply: boolean } => {
  const unknown = argv.filter((arg) => arg !== '--apply');
  if (unknown.length) throw new Error(`unknown argument(s): ${unknown.join(' ')} (only --apply is accepted)`);
  return { apply: argv.includes('--apply') };
};

/** argv is a parameter so the service test can drive it against its own mongod. */
export const run = async (argv: string[]): Promise<{ apply: boolean; capped: CappedExpiry[]; requeued: number }> => {
  const { apply } = parseArgs(argv);
  const capped = await listCappedExpiries();
  console.log(`[retry-capped-approval-expiries] capped expiries: ${capped.length}`);
  capped.slice(0, 50).forEach((row) => {
    console.log(`  approval=${row.approvalId} pod=${row.podId} agent=${row.agentName} `
      + `retries=${row.expiryRetryCount} lastAttempt=${(row.expiryRetryClaimedAt || row.resolvedAt)?.toISOString?.()}`);
  });
  if (capped.length > 50) console.log(`  … and ${capped.length - 50} more`);
  if (!apply) {
    console.log('DRY RUN — nothing written. Re-run with --apply to requeue these rows.');
    return { apply, capped, requeued: 0 };
  }
  const requeued = await requeueCappedExpiries(capped.map((row) => row.approvalId));
  console.log(`requeued ${requeued} of ${capped.length}; the next expiry sweep retries them.`);
  return { apply, capped, requeued };
};

if (require.main === module) {
  (async () => {
    const uri = process.env.MONGO_URI;
    if (!uri) throw new Error('MONGO_URI is required');
    await mongoose.connect(uri);
    try {
      await run(process.argv.slice(2));
    } finally {
      await mongoose.disconnect();
    }
  })().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
