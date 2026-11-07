// Pure rules for scripts/ui-interaction-crawler.mjs, split out so they can be tested without a browser.

// How many earlier candidates carry the same label. Label plus occurrence names a control after
// the page has shifted, which a position in the list cannot do.
export function withOccurrences(candidates) {
  const seen = new Map();
  return candidates.map((c) => {
    const occ = seen.get(c.label) || 0;
    seen.set(c.label, occ + 1);
    return { ...c, occ };
  });
}

export function resolveCandidate(current, cand) {
  return current.find((c) => c.label === cand.label && c.occ === cand.occ) || null;
}

// A refused write is its own verdict: the control works and the crawler stopped it. A refused read
// only qualifies what the click did, because it can be a background poll landing in the same window.
export function clickOutcome({ clicked, writesRefused, readsRefused, navigated, mutated, requested }) {
  if (writesRefused > 0) return 'write-refused';
  let outcome = 'dead';
  if (!clicked) outcome = 'unclickable';
  else if (navigated) outcome = 'navigated';
  else if (mutated) outcome = 'changed';
  else if (requested) outcome = 'requested';
  return readsRefused > 0 ? `${outcome}+read-refused` : outcome;
}

// Anything the click may have done can leave the page different, so only these three skip the reload.
export function needsReload(outcome) {
  return !['dead', 'stale', 'unclickable'].includes(outcome);
}

// The share of a capture's clicks that must get a verdict before the capture counts as evidence.
export const MIN_VERDICT_SHARE = 0.5;

// Why a capture is not evidence, or null. A blank page and a page whose controls all went stale
// both report zero dead clicks, which reads as a pass unless it is refused here.
export function captureProblem({ candidateCount, clicks }) {
  if (!candidateCount) return 'no controls found; the page may not have rendered';
  const tried = clicks.filter((c) => c.outcome !== 'repeat');
  if (tried.length === 0) return null;
  const stale = tried.filter((c) => c.outcome === 'stale').length;
  const judged = tried.length - stale;
  if (judged / tried.length < MIN_VERDICT_SHARE) return `only ${judged} of ${tried.length} clicks got a verdict`;
  return null;
}
