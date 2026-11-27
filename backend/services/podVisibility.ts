/**
 * Whether strangers can read or join a pod, as an agent's runtime is told it.
 *
 * `/installations` (routes/agentsRuntime.ts) projects these onto every pod a
 * seat answers in, and the events stamp (services/accountUseStamp.ts) copies
 * them onto each event served to an own-machine seat, so both read one rule.
 *
 * The effective values are reported: an absent stored visibility field means
 * false, as everywhere else that reads `publicRead || communityListed`, and an
 * absent joinPolicy means open, as in podListing.ts. A pod that no longer
 * exists gets none of the fields.
 */
export interface PodVisibility {
  publicRead: boolean;
  communityListed: boolean;
  joinPolicy: 'invite-only' | 'open';
}

type PodRow = {
  _id?: unknown;
  publicRead?: unknown;
  communityListed?: unknown;
  joinPolicy?: unknown;
} | null | undefined;

export const podVisibility = (pod: PodRow): PodVisibility | Record<string, never> => (pod?._id
  ? {
    publicRead: pod.publicRead === true,
    communityListed: pod.communityListed === true,
    joinPolicy: pod.joinPolicy === 'invite-only' ? 'invite-only' : 'open',
  }
  : {});
