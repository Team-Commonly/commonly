import fs from 'fs';
import path from 'path';
import { V2_CSS_FILES, readV2Css } from '../__testkit__/v2Css';

/**
 * Signal's type floors (ruling h, 2026-09-06), enforced over the whole
 * stylesheet rather than per component.
 *
 *   mono  — never below 11px
 *   sans  — never below 12px
 *
 * 11px is mono-only, so a rule that sizes below 12 must NAME the mono family
 * in the same rule. Inheriting the family at 11 is banned precisely so this
 * check stays decidable without a browser: the two conditions are conjunctive,
 * and `font-size: var(--v2-fs-*)` is resolved from the sheet's own custom
 * properties before the comparison.
 *
 * This exists because the four per-component "is 11px" assertions in
 * v2-layout-invariants read like a floor and are not one — they name specific
 * rules that carry the right value and say nothing about the wrong value
 * appearing anywhere else. 87 rules were below the floors when this landed.
 *
 * ALLOWLIST is the burn-down, keyed to the PR that owns each surface. Entries
 * are removed, never added: a new violation fails the first assertion, and a
 * fixed one fails the second (the allowlist may not carry a selector that no
 * longer violates). Target is an empty list.
 */
// v2.css plus the surface files lifted out of it (D223): the chat sheets V2App
// loads, and the per-surface sheets their components import (R04 BYO, S4 board,
// R05 Connect, R06 Your team, the invite page).
// D225 sweep (2026-11-03): every v2 stylesheet, found by walking the tree, so
// a sheet lifted out of v2.css cannot leave the floor by moving. readV2Css()
// keeps its load order first; the rest follow in path order.
const V2_ROOT = path.join(__dirname, '..');
const allSheets = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true })
  .flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : allSheets(full);
    return entry.name.endsWith('.css') ? [full] : [];
  })
  .sort();
const LOADED = new Set(V2_CSS_FILES.map((rel) => path.join(V2_ROOT, rel)));
const CSS = [readV2Css(), ...allSheets(V2_ROOT).filter((file) => !LOADED.has(file))
  .map((file) => fs.readFileSync(file, 'utf8'))]
  .join('\n');

const MONO_FLOOR = 11;
const SANS_FLOOR = 12;

type Violation = { selector: string; size: number; reason: string };

const fontSizeVars = (): Record<string, number> => {
  const out: Record<string, number> = {};
  const re = /^\s*(--v2-fs-[a-z0-9-]+):\s*([0-9.]+)px/gm;
  let m = re.exec(CSS);
  while (m) {
    out[m[1]] = Number.parseFloat(m[2]);
    m = re.exec(CSS);
  }
  return out;
};

const rules = (): Array<{ selector: string; body: string }> => {
  const out: Array<{ selector: string; body: string }> = [];
  let i = 0;
  for (;;) {
    const open = CSS.indexOf('{', i);
    if (open < 0) break;
    const close = CSS.indexOf('}', open);
    if (close < 0) break;
    // lastIndexOf's second argument is INCLUSIVE, so searching for '{' from
    // `open` returns `open` itself and every selector comes back empty. The
    // first draft of this file did exactly that: 1,572 rules parsed, 1,572
    // blank selectors, and two of the four tests still passed.
    const from = Math.max(CSS.lastIndexOf('}', open - 1), CSS.lastIndexOf('{', open - 1)) + 1;
    const selector = CSS.slice(Math.max(0, from), open)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .trim()
      .replace(/\s+/g, ' ');
    // An at-rule that CONTAINS rules is not itself a rule. Without this the
    // block's body slice runs only to the first inner rule's `}`, so that
    // rule's declarations get attributed to the `@media` prelude — every
    // media block's first child was keyed to its at-rule (@ux-lead, #1580).
    // `@font-face` is a declaration block, so it stays a rule.
    if (/^@(media|supports|container|layer|keyframes|-webkit-keyframes)\b/.test(selector)) {
      i = open + 1;
      continue;
    }
    out.push({ selector, body: CSS.slice(open + 1, close) });
    i = close + 1;
  }
  return out;
};

const violations = (): Violation[] => {
  const vars = fontSizeVars();
  const seen = new Set<string>();
  const found: Violation[] = [];
  for (const { selector, body } of rules()) {
    const decl = /(?:^|;|\s)font(?:-size)?:\s*([^;]*)/.exec(body)?.[1];
    if (!decl) continue;
    const px = /(\d+(?:\.\d+)?)px/.exec(decl);
    const varName = /var\((--v2-fs-[a-z0-9-]+)/.exec(decl)?.[1];
    let size: number | undefined;
    if (px) size = Number.parseFloat(px[1]);
    else if (varName && vars[varName] !== undefined) size = vars[varName];
    if (size === undefined || size >= SANS_FLOOR) continue;
    const mono = body.includes('--v2-font-mono');
    if (mono && size >= MONO_FLOOR) continue;
    if (seen.has(selector)) continue;
    seen.add(selector);
    found.push({
      selector,
      size,
      reason: mono ? `mono at ${size}px is below the ${MONO_FLOOR}px floor` : `${size}px without the mono family declared in the rule`,
    });
  }
  return found;
};

// Group headers carry no counts: a hand-maintained number that nothing
// asserts is a claim that goes stale on the first burn-down step. The list
// length is the count.
const ALLOWLIST: string[] = [
  // PR2a
  '.v2-avatar', // 11.0px — no-mono-family
  '.v2-avatar--md', // 11.0px — no-mono-family
  '.v2-avatar--sm', // 10.0px — no-mono-family
  // Split in two by the D223 chat lift (S3d): the status half moved to
  // chat/chat-states.css, and the action-text half left with TASK-758.
  '.v2-chat__new-pod-status', // 11.0px — no-mono-family
  '.v2-chat__new-pod-error', // 11.0px — no-mono-family
  '.v2-msg__lead-badge', // 10.0px — mono-below-floor
  '.v2-msg__reaction-count', // 11.0px — no-mono-family
  '.v2-msg__reaction-error', // 11.0px — no-mono-family
  '.v2-msg__time', // 11.0px — no-mono-family
  '.v2-pods__row-mark.v2-avatar', // 11.0px — no-mono-family
  '.v2-prcard__avatar', // 10.0px — no-mono-family
  '.v2-prcard__avatar--overflow', // 10.0px — no-mono-family
  '.v2-prcard__state', // 11.0px — no-mono-family
  '.v2-root .v2-chat__new-pod-error button', // 11.0px — no-mono-family
  '.v2-root button.v2-chat__new-pod-copy', // 11.0px — no-mono-family
  // PR3 selectors meet the floor; no remaining allowances.
  // PR4
  // TASK-166 took `.v2-byo__mode-kicker` (10.0px, no family) and
  // `.v2-byo__preview-label` (11.0px, no family) to mono 500 11px, so both
  // entries left this burn-down list rather than being updated in place.
  // TASK-169 took `.v2-byo__stat-label` (11.0px, no family) to mono 500 11px
  // with item 2, so its entry left this burn-down list rather than being
  // updated in place.
  // unassigned
  // R05 took `.v2-connect__number` (11.0px, no family) to mono 500 11.5px
  // with the Connect lift, so its entry left this list.
  '.v2-approval__time', // 11.5px — no-mono-family
  // The invite link lift dropped `.v2-invite-card__meta` (11.0px, no family)
  // with the old centred card, so its entry left this list.
  '.v2-invite-link', // 11.0px — no-mono-family
  '.v2-invite-manage__empty', // 11.0px — no-mono-family
  '.v2-invite-manage__meta', // 10.0px — no-mono-family
  '.v2-invite-manage__summary', // 11.0px — no-mono-family
  '.v2-invite-manage__url', // 10.0px — mono-below-floor
  '.v2-invite-options__field', // 11.0px — no-mono-family
  '.v2-mention-item__sub', // 11.0px — no-mono-family
  '.v2-modal__error', // 11.0px — no-mono-family
  '.v2-pods__create-error', // 11.0px — no-mono-family
  '.v2-pods__section-chevron', // 11.0px — no-mono-family
  '.v2-root button.v2-admin-users__inline-copy', // 11.0px — no-mono-family
  '.v2-root button.v2-invite-manage__action, .v2-invite-manage__action', // 11.0px — no-mono-family
  '.v2-syscard__time', // 11.5px — no-mono-family
  // Glob widening (2026-11-03): the scan widened from 11 hand-listed sheets to
  // every v2 stylesheet. Every entry it surfaced left the list in the next
  // day's burn-down. Most were mono at 11–11.5px behind a sheet-local alias
  // (`--mono`, `--f-mono`) or an inherited family, and now name
  // `--v2-font-mono`; the badges and beta tags rose to mono 11, and the two
  // sans pills on the agent profile to 12.
];

describe('v2 type floors (ruling h)', () => {
  test('no rule sizes below the floors outside the burn-down allowlist', () => {
    const unexpected = violations().filter((v) => !ALLOWLIST.includes(v.selector));
    expect(unexpected.map((v) => `${v.selector} — ${v.reason}`)).toEqual([]);
  });

  test('the allowlist carries no selector that already complies', () => {
    // Without this the list silently outlives its entries and the burn-down
    // never reaches zero — the same failure mode as the floor it replaces.
    const live = new Set(violations().map((v) => v.selector));
    expect(ALLOWLIST.filter((selector) => !live.has(selector))).toEqual([]);
  });

  test('the scan resolves font-size variables rather than skipping them', () => {
    // `--v2-fs-label: 11px` is consumed by rules that declare no literal size.
    // If substitution regressed, those rules would silently drop out of scope.
    expect(CSS).toMatch(/--v2-fs-label:\s*11px/);
    expect(CSS + fs.readFileSync(path.join(__dirname, '../components/V2SettingsPage.css'), 'utf8')).toContain('font-size: var(--v2-fs-label)');
  });

  test('a rule inside an @media block is keyed to its own selector', () => {
    // The at-rule prelude is not a rule. Keyed to it, a media block's FIRST
    // child had its declarations attributed to `@media (...)` and could never
    // be allowlisted or fixed by name (@ux-lead, #1580).
    const selectors = rules().map((rule) => rule.selector);
    expect(selectors.filter((selector) => selector.startsWith('@'))).toEqual([]);
    // `.v2-verification-banner` is the first child of a `@media (max-width: 480px)`
    // block, which is exactly the position that was mis-keyed.
    expect(selectors).toContain('.v2-verification-banner');
  });

  test('the walk reaches every v2 stylesheet, not a hand list', () => {
    // A changed root or a broken walk would quietly shrink the scan back to
    // the hand-listed sheets and pass. Pin the count and a few sheets that only
    // the walk can reach.
    const walked = allSheets(V2_ROOT).map((file) => path.relative(V2_ROOT, file).split(path.sep).join('/'));
    expect(walked.length).toBeGreaterThanOrEqual(29);
    expect(walked).toEqual(expect.arrayContaining([
      'v2.css',
      'agents/v2-agent-settings-surface.css',
      'cards/uiCard.css',
      'connectors/connectors.css',
      'landing/v2-landing.css',
      'primitives/primitives.css',
    ]));
    expect(walked.some((file) => file.startsWith('__tests__/'))).toBe(false);
  });

  test('the scan is measuring something — the sheet parses into many rules', () => {
    // A broken brace or a changed path yields zero rules and a vacuous pass.
    expect(rules().length).toBeGreaterThan(400);
  });
});
