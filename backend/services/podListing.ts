export const NON_LISTABLE_POD_TYPES: readonly string[] = Object.freeze([
  'agent-room',
  'agent-dm',
  'agent-admin',
]);

export const COMMUNITY_LISTING_QUERY = Object.freeze({
  publicRead: true,
  communityListed: true,
});

interface CommunityListingPod {
  type?: unknown;
  publicRead?: unknown;
  communityListed?: unknown;
  joinPolicy?: unknown;
}

export const isCommunityListed = (pod: CommunityListingPod): boolean => (
  !NON_LISTABLE_POD_TYPES.includes(String(pod?.type))
  && pod?.publicRead === true
  && pod?.communityListed === true
);

export const isDirectlyJoinable = (pod: CommunityListingPod): boolean => (
  isCommunityListed(pod) && pod?.joinPolicy !== 'invite-only'
);
