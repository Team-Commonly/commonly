/**
 * Community listing + direct-join eligibility — single source of truth.
 *
 * THE INVARIANT (#772): `communityListed` is a strict REFINEMENT of
 * `publicRead`. Listed ⇒ readable. A `{ publicRead: false,
 * communityListed: true }` pod is not a supported state; before this module
 * existed it was reachable, and it meant "joinable but invisible" — the join
 * gate checked `communityListed` alone while both discovery queries required
 * `publicRead && communityListed`. Anyone holding the pod id could walk into
 * a room that no discovery surface would ever show them.
 *
 * The two call sites (discovery query in podController.listPods, in-memory
 * check in podController.joinPod) now derive from the same predicate, so they
 * cannot drift apart again. If you add a third surface, use these helpers
 * rather than open-coding the flag check.
 *
 * Why narrow rather than widen: making listing work WITHOUT `publicRead` is
 * defensible (the community scope is authenticated-only), but it widens who
 * can enter a room. That is a pod-model decision for ADR-016, not something a
 * missing-writer bugfix should smuggle in. Narrowing is the safe direction on
 * a privacy gate.
 */

// Personal / DM pod types. These are never listable, never joinable by a
// third party, and never publishable — a 1:1 room is private by definition.
// NOTE: the same three values also live in podController
// (COMMUNITY_EXCLUDED_POD_TYPES), routes/admin/pods (PERSONAL_POD_TYPES) and
// agentIdentityService (DM_POD_TYPES_GUARD). Consolidating those is a
// separate concern from this fix; see #772 discussion.
export const NON_LISTABLE_POD_TYPES: readonly string[] = [
  'agent-room',
  'agent-dm',
  'agent-admin',
];

export interface ListingFlags {
  type?: string;
  publicRead?: boolean;
  communityListed?: boolean;
  joinPolicy?: string;
}

/** A pod type that may appear on the community surface at all. */
export function isListablePodType(type: unknown): boolean {
  return !NON_LISTABLE_POD_TYPES.includes(String(type));
}

/**
 * The listing predicate shared by both discovery scopes. Expressed as a Mongo
 * query fragment so `listPods` and the eligibility check below cannot diverge.
 */
export const COMMUNITY_LISTING_QUERY = Object.freeze({
  publicRead: true,
  communityListed: true,
});

/** Is this pod on the community discovery surface? */
export function isCommunityListed(pod: ListingFlags | null | undefined): boolean {
  if (!pod) return false;
  return isListablePodType(pod.type)
    && pod.publicRead === true
    && pod.communityListed === true;
}

/**
 * May a non-member walk into this pod directly (no invite, no admin bypass)?
 *
 * Deliberately the discovery predicate PLUS the join policy: you can only
 * self-join something you could have found. Invite redemption
 * (routes/podInvites) remains the separate, intentional rail into an
 * invite-only pod and is unaffected.
 */
export function isDirectlyJoinable(pod: ListingFlags | null | undefined): boolean {
  if (!pod) return false;
  return isCommunityListed(pod) && pod.joinPolicy !== 'invite-only';
}
