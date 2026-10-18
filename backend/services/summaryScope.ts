// A summary with no podId belongs to no pod, so pod membership cannot decide
// who reads it. Pod-less 'posts' summaries are served only when built solely
// from feed posts (podId null), and their writer says so by stamping
// `metadata.source` with FEED_POSTS_SOURCE. Daily digests are pod-less too,
// and are read by their own user only (summaries.ts).

export const FEED_POSTS_SOURCE = 'feed-posts';

export const isFeedOnlySummary = (summary: {
  podId?: unknown;
  type?: string;
  metadata?: { source?: string };
} | null | undefined): boolean => Boolean(
  summary
  && !summary.podId
  && summary.type === 'posts'
  && summary.metadata?.source === FEED_POSTS_SOURCE,
);

// CJS compat for the require()-style imports used elsewhere in backend/.
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = { FEED_POSTS_SOURCE, isFeedOnlySummary };
