export const NON_LISTABLE_POD_TYPES: readonly string[] = Object.freeze([
  'agent-room',
  'agent-dm',
  'agent-admin',
]);

/**
 * Flags-only fragment used by Community membership queries. Callers that need
 * a public pod an agent can join must compose DIRECTLY_JOINABLE_QUERY instead
 * of restating the join-policy gate.
 */
export const COMMUNITY_LISTING_QUERY = Object.freeze({
  publicRead: true,
  communityListed: true,
});

/**
 * Listed public pods whose join policy permits direct joining. Membership is
 * deliberately absent: Discover hides rows the caller already belongs to,
 * while agent runtime listings include installed pods.
 */
export const DIRECTLY_JOINABLE_QUERY = Object.freeze({
  ...COMMUNITY_LISTING_QUERY,
  joinPolicy: { $ne: 'invite-only' },
});

interface CommunityDiscoverQueryOptions {
  callerId: unknown;
  type?: unknown;
}

interface CommunityListingPod {
  type?: unknown;
  publicRead?: unknown;
  communityListed?: unknown;
  joinPolicy?: unknown;
}

export const communityDiscoverQuery = ({
  callerId,
  type,
}: CommunityDiscoverQueryOptions) => ({
  ...DIRECTLY_JOINABLE_QUERY,
  members: { $ne: callerId },
  type: type
    ? { $eq: type, $nin: NON_LISTABLE_POD_TYPES }
    : { $nin: NON_LISTABLE_POD_TYPES },
});

export const isCommunityListed = (pod: CommunityListingPod): boolean => (
  !NON_LISTABLE_POD_TYPES.includes(String(pod?.type))
  && pod?.publicRead === true
  && pod?.communityListed === true
);

export const isDirectlyJoinable = (pod: CommunityListingPod): boolean => (
  isCommunityListed(pod) && pod?.joinPolicy !== 'invite-only'
);
