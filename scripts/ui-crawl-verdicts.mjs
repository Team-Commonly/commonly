// Pure rules for scripts/ui-interaction-crawler.mjs, split out so they can be tested without a browser.

// A row's age ("Docs 5h") ticks over during a capture, so it isn't part of the control's name.
export function stripAge(label) {
  return label.replace(/ \d+[smhd]$/, '');
}

// How many earlier candidates carry the same label. Label plus occurrence names a control after
// the page has shifted, which a position in the list cannot do.
export function withOccurrences(candidates) {
  const seen = new Map();
  return candidates.map((c) => {
    const label = stripAge(c.label);
    const occ = seen.get(label) || 0;
    seen.set(label, occ + 1);
    return { ...c, label, occ };
  });
}

export function resolveCandidate(current, cand) {
  return current.find((c) => c.label === cand.label && c.occ === cand.occ) || null;
}

// A refused write is its own verdict: the control works and the crawler stopped it. A refused read
// only qualifies what the click did, because it can be a background poll landing in the same window.
export function clickOutcome({ clicked, writesRefused, readsRefused, navigated, mutated, requested, dialog = false }) {
  if (writesRefused > 0) return 'write-refused';
  let outcome = 'dead';
  if (!clicked) outcome = 'unclickable';
  // A native dialog changes nothing in the DOM, so without this it reads as a dead control.
  else if (dialog) outcome = 'dialog';
  else if (navigated) outcome = 'navigated';
  else if (mutated) outcome = 'changed';
  else if (requested) outcome = 'requested';
  return readsRefused > 0 ? `${outcome}+read-refused` : outcome;
}

// Anything the click may have done can leave the page different, so only these skip the reload.
// A dialog is dismissed, so nothing it offered happened.
export function needsReload(outcome) {
  return !['dead', 'stale', 'unclickable', 'dialog'].includes(outcome);
}

// Words that stay in English in a translated UI: the zh-CN glossary, plus the product and tool names.
const KEEP_IN_ENGLISH = /\b(Commonly|Pods?|CLI|MCP|GitHub|Google|PR|Star|Webhook|Fork|Claude|Code|Codex|Cursor|OpenClaw|Discord|Slack|Telegram|Linear|Notion|Sentry|Airtable|Atlassian|Apache|SSO|SAML|SLA|API|URL|ID|OK|AI|Mac|macOS|Linux|Windows|Light|Dark)\b/g;

// Visible strings with an English word left over once those names are gone. The account's own
// content lands here too, because agent content is never translated, so this is a list to triage.
export function untranslatedStrings(strings) {
  const found = new Set();
  for (const raw of strings) {
    const text = raw.replace(/\s+/g, ' ').trim();
    if (/[A-Za-z]{3,}/.test(text.replace(KEEP_IN_ENGLISH, ''))) found.add(text.slice(0, 100));
  }
  return [...found].sort();
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
