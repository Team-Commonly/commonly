/**
 * A seat with no sandbox answers only in pods confirmed private.
 *
 * An agent the adapters do not confine runs as its owner: their files, their
 * git and GitHub login, their shell. Anyone who can post in its pod can direct
 * it. Attach already refused a publicly readable pod, but not one anyone can
 * join, and nothing looked again once it ran, so a pod made joinable later
 * handed that access to whoever joined.
 *
 * So attach requires such a seat's pod to be confirmed private (publicRead and
 * communityListed reported false, joinPolicy invite-only:
 * workspace-trust.js `podIsConfirmedPrivate`), and before every turn the seat
 * re-reads its pods (GET /installations) and refuses the turn unless all of
 * them still are. There is no confined fallback: the seat's record was never
 * written for one, so a pod that is not private is a refused turn, and a read
 * that fails defers it. The Windows Codex opt-in keeps its own placement
 * (`unconfinedTurnPlacement`); this covers every other unconfined seat.
 *
 * "Confined" is what the adapters enforce, not what the file declares: a public
 * or workspace trust, or a shape one adapter enforces with no trust (claude's
 * `bwrap` mode, dsh's `isConfinedDsh` shape). Any other `sandbox.mode` with no
 * trust is spawned bare (claude, codex) or refused at spawn, so it is
 * unconfined here, and `mode: 'none'` always is.
 *
 * A legacy pod with no joinPolicy is reported 'open', and that is not only a
 * default: an agent may self-install into a pod an agent created unless it is
 * invite-only, so a missing value is not confirmed private.
 *
 * The test-only `stub` adapter runs nothing and is not checked.
 */
import { normalizeSandboxTrust } from './environment.js';
import { podIsConfirmedPrivate } from './workspace-trust.js';

export const UNCONFINED_UNCHECKED_ADAPTERS = new Set(['stub']);

// adapters/dsh.js isConfinedDsh's accepted shape, copied so this module stays
// free of adapter imports; a test holds the two equal.
const isConfinedDshShape = (sandbox) => {
  if (!sandbox || typeof sandbox !== 'object' || sandbox.trust !== undefined) return false;
  const { mode, network, ...rest } = sandbox;
  return mode === 'workspace' && network?.policy === 'restricted'
    && Object.keys(network).length === 1 && Object.keys(rest).length === 0;
};

// Confinement an adapter applies with no trust: claude wraps any `bwrap` mode
// (adapters/claude.js), and dsh enforces its one shape. codex, opencode and the
// rest apply a mode only under a public or workspace trust.
const ADAPTER_OWN_CONFINEMENT = {
  claude: (sandbox) => sandbox?.mode === 'bwrap',
  dsh: isConfinedDshShape,
};

export const seatRunsUnconfined = ({ environment, adapterName }) => {
  if (UNCONFINED_UNCHECKED_ADAPTERS.has(adapterName)) return false;
  const sandbox = normalizeSandboxTrust(environment?.sandbox);
  // An explicit 'none' is no sandbox whatever the trust says.
  if (sandbox?.mode === 'none') return true;
  if (sandbox?.trust === 'public' || sandbox?.trust === 'workspace') return false;
  return !ADAPTER_OWN_CONFINEMENT[adapterName]?.(sandbox);
};

export const UNCONFINED_TURN_REFUSAL = 'This agent runs without a sandbox, with your own access to files, '
  + 'commands and logins, so it answers only while every pod it is in is private and invite-only. '
  + 'To fix it, the pod\'s owner opens it in Commonly and sets "Who can join" to Invite-only in its side '
  + 'panel (and makes it private if it is public or listed in Community), or you remove this agent from that pod.';

const MAX_PODS_NAMED = 3;

const describePod = (pod) => {
  const label = pod?.podName ? `"${pod.podName}" (${pod.podId})` : `pod ${pod?.podId || '(no id)'}`;
  if (typeof pod?.publicRead !== 'boolean' || typeof pod?.communityListed !== 'boolean') {
    return `${label} did not report whether it is private`;
  }
  if (pod.publicRead || pod.communityListed) return `${label} is public or listed in Community`;
  return `${label} is open to join`;
};

/** Null when every pod is confirmed private, otherwise why the turn is refused, naming the pods. */
export const unconfinedPodRefusalReason = (installations) => {
  if (installations === null) return 'its pods could not be read';
  if (!Array.isArray(installations) || installations.length === 0) return 'the server listed no pods for it';
  const seen = new Set();
  const notPrivate = installations.filter((pod) => {
    if (podIsConfirmedPrivate(pod)) return false;
    const key = String(pod?.podId || '');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (!notPrivate.length) return null;
  const named = notPrivate.slice(0, MAX_PODS_NAMED).map(describePod).join('; ');
  const more = notPrivate.length - MAX_PODS_NAMED;
  return more > 0 ? `${named}; and ${more} more` : named;
};
