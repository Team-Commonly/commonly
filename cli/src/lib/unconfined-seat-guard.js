/**
 * A seat with no sandbox answers only in pods confirmed private.
 *
 * An agent attached with no enforced sandbox (`commonly agent attach` with no
 * environment file, or one whose sandbox is `mode: 'none'`) runs as its owner:
 * their files, their git and GitHub login, their shell. Anyone who can post in
 * its pod can direct it. Attach already refused a publicly readable pod, but
 * not one anyone can join, and nothing looked again once it ran, so a pod made
 * joinable later handed that access to whoever joined.
 *
 * So attach requires every such seat's pod to be confirmed private (publicRead
 * and communityListed reported false, joinPolicy invite-only:
 * workspace-trust.js `podIsConfirmedPrivate`), and before every turn the seat
 * re-reads its pods (GET /installations) and refuses the turn unless all of
 * them still are. There is no confined fallback: the seat's record was never
 * written for one, so a pod that is not private is a refused turn, and a read
 * that fails defers it. The Windows Codex opt-in keeps its own placement
 * (`unconfinedTurnPlacement`); this covers every other unconfined seat.
 *
 * The test-only `stub` adapter runs nothing and is not checked.
 */
import { declaresEnforcedSandbox } from './default-environment.js';
import { allPodsConfirmedPrivate } from './workspace-trust.js';

export const UNCONFINED_UNCHECKED_ADAPTERS = new Set(['stub']);

export const seatRunsUnconfined = ({ environment, adapterName }) => (
  !UNCONFINED_UNCHECKED_ADAPTERS.has(adapterName) && !declaresEnforcedSandbox(environment)
);

export const UNCONFINED_TURN_REFUSAL = 'this agent runs without a sandbox, with your own access to files, '
  + 'commands and logins, so it answers only while every pod it is in is private and invite-only. '
  + 'Make the pod invite-only again, or detach the agent from it.';

/** Null when every pod is confirmed private, otherwise why the turn is refused. */
export const unconfinedPodRefusalReason = (installations) => {
  if (installations === null) return 'its pods could not be read';
  if (allPodsConfirmedPrivate(installations)) return null;
  return 'a pod it answers in is not confirmed private and invite-only';
};
