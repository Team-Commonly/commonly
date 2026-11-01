/**
 * Give every token that has been used a `lastListenedAt` equal to its
 * `lastUsedAt` (TASK-721, ahead of the listener-based agent state).
 *
 * Why. Agent state is about to read listener check-ins instead of any token
 * use. Tokens that existed before `lastListenedAt` shipped have no value, so
 * without this every long-gone seat would flip from gone-dark to never-connected
 * on the deploy and the stalled-connect nudge could post into old rooms. This
 * preserves the verdict the derivation gave before the change. It over-claims
 * for a token that was only ever used by MCP tool calls; a live listener's next
 * poll stamps the real value, and an MCP-only token stays as it was judged.
 *
 * Safety.
 *  - Insert-only against live writers. Each write is guarded by
 *    `lastListenedAt: { $exists: false }` on the one token element, so a stamp a
 *    running listener wrote in the meantime is never overwritten.
 *  - Per token, by its subdocument `_id`: no array is replaced, so a concurrent
 *    `lastUsedAt` write on another element or field is not lost.
 *  - Token hashes are never read or printed.
 *  - Dry run by default. A dry run can write the candidate set to `--out`; the
 *    apply run refuses to start without that frozen set (`--ids`) and touches
 *    only it. Re-running is harmless: a stamped token is skipped.
 *
 * Usage:
 *   cd backend && node dist/scripts/backfill-listener-check-in.js --out ids.json   # dry run
 *   cd backend && node dist/scripts/backfill-listener-check-in.js --apply --ids ids.json
 */
/* eslint-disable no-console */

import fs from 'fs';
import mongoose from 'mongoose';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const User = require('../models/User');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { AgentInstallation } = require('../models/AgentRegistry');

export type TokenStore = 'user' | 'installation';

export interface TokenCandidate {
  store: TokenStore;
  ownerId: string;
  tokenId: string;
  lastUsedAt: string;
}

export interface CandidateListing {
  candidates: TokenCandidate[];
  /**
   * Used, unstamped tokens whose subdocument has no ObjectId `_id`. They cannot
   * be addressed by this script, so the operator must see them before the
   * derivation switch ships; they would flip from gone-dark to never-connected.
   */
  unaddressable: number;
}

export interface ListenerBackfillDeps {
  listCandidates: () => Promise<CandidateListing>;
  /** Returns how many rows the database changed (0 when already stamped). */
  stamp: (candidate: TokenCandidate) => Promise<number>;
}

export interface ListenerBackfillReport {
  dryRun: boolean;
  candidates: number;
  unaddressable: number;
  byStore: Record<TokenStore, number>;
  frozen: number | null;
  applied: number;
  skippedAlreadyStamped: number;
  failed: number;
}

export async function backfillListenerCheckIn(
  deps: ListenerBackfillDeps,
  options: { apply?: boolean; frozen?: TokenCandidate[] } = {},
): Promise<ListenerBackfillReport> {
  const apply = Boolean(options.apply);
  if (apply && !options.frozen) {
    throw new Error('apply needs the frozen id set from a dry run (--ids)');
  }
  const { candidates: current, unaddressable } = await deps.listCandidates();
  const byStore: Record<TokenStore, number> = { user: 0, installation: 0 };
  current.forEach((candidate) => { byStore[candidate.store] += 1; });
  const report: ListenerBackfillReport = {
    dryRun: !apply,
    candidates: current.length,
    unaddressable,
    byStore,
    frozen: options.frozen ? options.frozen.length : null,
    applied: 0,
    skippedAlreadyStamped: 0,
    failed: 0,
  };
  if (!apply) return report;

  for (const candidate of options.frozen as TokenCandidate[]) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const changed = await deps.stamp(candidate);
      if (changed > 0) report.applied += changed;
      else report.skippedAlreadyStamped += 1;
    } catch (error) {
      report.failed += 1;
      const who = `${candidate.store}:${candidate.ownerId}:${candidate.tokenId}`;
      console.error(`stamp failed for ${who}:`, (error as Error).message);
    }
  }
  return report;
}

const toIso = (value: unknown): string => new Date(value as string | number | Date).toISOString();

export const productionDeps = (): ListenerBackfillDeps => ({
  listCandidates: async () => {
    const out: TokenCandidate[] = [];
    let unaddressable = 0;
    const take = (store: TokenStore, ownerId: unknown, token: Record<string, any>) => {
      if (!token.lastUsedAt || token.lastListenedAt) return;
      if (!/^[0-9a-f]{24}$/i.test(String(token._id || ''))) {
        unaddressable += 1;
        return;
      }
      out.push({
        store,
        ownerId: String(ownerId),
        tokenId: String(token._id),
        lastUsedAt: toIso(token.lastUsedAt),
      });
    };
    // Only the ids and the two timestamps are selected: no token hash leaves the database.
    const users = await User.find({ 'agentRuntimeTokens.lastUsedAt': { $exists: true } })
      .select('agentRuntimeTokens._id agentRuntimeTokens.lastUsedAt agentRuntimeTokens.lastListenedAt')
      .lean();
    for (const user of users as Array<Record<string, any>>) {
      for (const token of user.agentRuntimeTokens || []) take('user', user._id, token);
    }
    const installs = await AgentInstallation.find({ 'runtimeTokens.lastUsedAt': { $exists: true } })
      .select('runtimeTokens._id runtimeTokens.lastUsedAt runtimeTokens.lastListenedAt')
      .lean();
    for (const install of installs as Array<Record<string, any>>) {
      for (const token of install.runtimeTokens || []) take('installation', install._id, token);
    }
    return { candidates: out, unaddressable };
  },
  stamp: async (candidate) => {
    const field = candidate.store === 'user' ? 'agentRuntimeTokens' : 'runtimeTokens';
    const Model = candidate.store === 'user' ? User : AgentInstallation;
    const res = await Model.updateOne(
      {
        _id: candidate.ownerId,
        [field]: {
          $elemMatch: {
            _id: new mongoose.Types.ObjectId(candidate.tokenId),
            // null matches an absent field and an explicit null, never a live Date.
            lastListenedAt: null,
          },
        },
      },
      { $set: { [`${field}.$.lastListenedAt`]: new Date(candidate.lastUsedAt) } },
    );
    // A write Mongoose dropped (a field missing from the schema) comes back
    // unacknowledged: report it as a failure, never as "already stamped".
    if (res?.acknowledged === false) throw new Error('write was not acknowledged');
    return res?.modifiedCount ?? res?.nModified ?? 0;
  },
});

const argValue = (flag: string): string | undefined => {
  const at = process.argv.indexOf(flag);
  return at >= 0 ? process.argv[at + 1] : undefined;
};

export async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const idsPath = argValue('--ids');
  const outPath = argValue('--out');
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is required');
  if (apply && !idsPath) throw new Error('--apply needs --ids <file from the dry run>');
  const frozen = idsPath
    ? (JSON.parse(fs.readFileSync(idsPath, 'utf8')) as { candidates: TokenCandidate[] }).candidates
    : undefined;

  await mongoose.connect(process.env.MONGO_URI);
  try {
    const deps = productionDeps();
    if (!apply && outPath) {
      const { candidates } = await deps.listCandidates();
      fs.writeFileSync(outPath, JSON.stringify({ createdAt: new Date().toISOString(), candidates }, null, 2));
      console.log(`[backfill-listener-check-in] wrote ${candidates.length} candidates to ${outPath}`);
    }
    const report = await backfillListenerCheckIn(deps, { apply, frozen });
    console.log(`[backfill-listener-check-in] ${JSON.stringify(report)}`);
    if (!apply) console.log('DRY RUN — nothing written. Re-run with --apply --ids <file>.');
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('listener check-in backfill failed:', error);
    process.exit(1);
  });
}
