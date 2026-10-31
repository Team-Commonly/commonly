#!/usr/bin/env node
/*
 * Remove stored pod-less 'posts' summaries that were built from pod posts.
 *
 * Pod-less 'posts' summaries are now built from feed posts only and stamped
 * `metadata.source: 'feed-posts'` (services/summaryScope.ts), and only stamped
 * ones are served. An unstamped one predates that. This removes an unstamped
 * one when its time window holds at least one post that belongs to a pod;
 * unstamped summaries of feed-only hours are left alone (they are garbage-
 * collected after 24 h like every non-digest summary).
 *
 * Built like cleanup-ghost-pod-members.ts, because it writes production data:
 *   1. Two numbers. It prints summaries examined and deleted, then re-counts:
 *      `before - after === deleted`.
 *   2. A read failure fails closed: an error counting a window's posts stops
 *      the run instead of reading as "no pod posts".
 *   3. Idempotent: a second run deletes nothing.
 *
 * Dry run by default; pass `--apply` to delete. Run it on the operator's word.
 *
 * Usage:
 *   cd backend && node dist/scripts/purge-unstamped-post-summaries.js           # report
 *   cd backend && node dist/scripts/purge-unstamped-post-summaries.js --apply   # delete
 */

import mongoose from 'mongoose';

const Summary = require('../models/Summary');
const Post = require('../models/Post');
const { FEED_POSTS_SOURCE } = require('../services/summaryScope');

const PODLESS_POSTS = { type: 'posts', $or: [{ podId: null }, { podId: { $exists: false } }] };

export interface PurgeReport {
  podless: number;
  unstamped: number;
  targets: string[];
  deleted: number;
  after: number | null;
}

// Pod-less 'posts' summaries without the feed stamp whose window holds a pod post.
export const findTargets = async (): Promise<{ podless: number; unstamped: number; targets: string[] }> => {
  const podless = await Summary.countDocuments(PODLESS_POSTS);
  const unstamped = await Summary.find(
    { ...PODLESS_POSTS, 'metadata.source': { $ne: FEED_POSTS_SOURCE } },
    { _id: 1, timeRange: 1 },
  ).lean() as Array<{ _id: unknown; timeRange?: { start?: Date; end?: Date } }>;
  const targets: string[] = [];
  for (const summary of unstamped) {
    const { start, end } = summary.timeRange || {};
    // No window means no way to know what it was built from: treat it as a target.
    const podPosts = (start && end)
      // eslint-disable-next-line no-await-in-loop
      ? await Post.countDocuments({ podId: { $ne: null }, createdAt: { $gte: start, $lte: end } })
      : 1;
    if (podPosts > 0) targets.push(String(summary._id));
  }
  return { podless, unstamped: unstamped.length, targets };
};

export const purge = async ({ apply }: { apply: boolean }): Promise<PurgeReport> => {
  const { podless, unstamped, targets } = await findTargets();
  if (!apply || targets.length === 0) return { podless, unstamped, targets, deleted: 0, after: apply ? podless : null };
  const result = await Summary.deleteMany({ _id: { $in: targets }, ...PODLESS_POSTS, 'metadata.source': { $ne: FEED_POSTS_SOURCE } });
  const after = await Summary.countDocuments(PODLESS_POSTS);
  return { podless, unstamped, targets, deleted: result.deletedCount || 0, after };
};

const main = async (): Promise<void> => {
  const apply = process.argv.includes('--apply');
  await mongoose.connect(String(process.env.MONGO_URI));
  const report = await purge({ apply });
  console.log(`[podless-post-summaries] mode=${apply ? 'apply' : 'dry-run'} podless=${report.podless} `
    + `unstamped=${report.unstamped} targets=${report.targets.length}`
    + `${report.targets.length ? ` first=${report.targets[0]}` : ''}`);
  if (apply) {
    console.log(`[podless-post-summaries] deleted=${report.deleted} after=${report.after} `
      + `check=${report.podless - (report.after ?? report.podless) === report.deleted ? 'ok' : 'MISMATCH'}`);
  }
};

if (require.main === module) {
  main()
    .catch((err) => {
      console.error('[podless-post-summaries] failed:', err);
      process.exitCode = 1;
    })
    .finally(() => {
      mongoose.connection.close().catch(() => {});
    });
}
