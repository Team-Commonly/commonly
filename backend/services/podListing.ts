export const NON_LISTABLE_POD_TYPES: readonly string[] = Object.freeze([
  'agent-room',
  'agent-dm',
  'agent-admin',
]);

/**
 * Types the DEFAULT (membership) listing hides even from a member who is in
 * them — and, for the same reason, the types no connector may target: a channel
 * that addresses a pod the app will not show its owner is a switch they cannot
 * see, cannot turn off, and did not ask for. Different set from
 * NON_LISTABLE_POD_TYPES, which also hides the personal DM types from the
 * Community and Discover scopes; those stay connector targets on purpose,
 * because an owner relaying their own DM is the feature.
 *
 * One constant, read by both the listing (`podController`) and the connector
 * target predicate (`connectorRelayPolicy`). Two lists that agree today is how
 * this gap opened: the listing dropped `agent-admin` and the gate-key check
 * never had a type rule at all, so an owner listed in one could switch a gate
 * on for a pod the Connectors page never offers (TASK-171). Add a type here and
 * it leaves both surfaces together.
 */
export const DEFAULT_LISTING_HIDDEN_POD_TYPES: readonly string[] = Object.freeze([
  'agent-admin',
]);

interface DefaultListingPod {
  type?: unknown;
}

/**
 * The default listing's type filter. An explicitly requested `type` is passed
 * through — a member asking for their own `agent-admin` pods still gets them,
 * which is the one way to reach a pod this filter hides.
 */
export const defaultListingTypeFilter = (type?: unknown) => (
  type ? { type } : { type: { $nin: DEFAULT_LISTING_HIDDEN_POD_TYPES } }
);

export const isHiddenFromDefaultListing = (pod: DefaultListingPod | null | undefined): boolean => (
  DEFAULT_LISTING_HIDDEN_POD_TYPES.includes(String(pod?.type))
);

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
