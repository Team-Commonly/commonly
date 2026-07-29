export const NON_LISTABLE_POD_TYPES: readonly string[] = Object.freeze([
  'agent-room',
  'agent-dm',
  'agent-admin',
]);

/**
 * Flags-only fragment used by Community membership queries. Discover callers
 * must use communityDiscoverQuery so join-policy and membership gates cannot
 * drift from the listing flags.
 */
export const COMMUNITY_LISTING_QUERY = Object.freeze({
  publicRead: true,
  communityListed: true,
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
  ...COMMUNITY_LISTING_QUERY,
  joinPolicy: { $ne: 'invite-only' },
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
