import fs from 'fs';
import path from 'path';

/**
 * Signal's type floors (ruling h, Sam, 2026-09-06), enforced over the whole
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
const CSS = fs.readFileSync(path.join(__dirname, '../v2.css'), 'utf8');

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

const ALLOWLIST: string[] = [
  // PR2a (24)
  '.v2-avatar', // 11.0px — no-mono-family
  '.v2-avatar--md', // 11.0px — no-mono-family
  '.v2-avatar--sm', // 10.0px — no-mono-family
  '.v2-chat__avatars-more', // 11.0px — no-mono-family
  '.v2-chat__composer-footer', // 11.0px — no-mono-family
  '.v2-chat__composer-hint', // 11.0px — no-mono-family
  '.v2-chat__composer-hint kbd', // 10.5px — mono-below-floor
  '.v2-chat__mode-toggle--header .v2-chat__mode-option', // 11.5px — no-mono-family
  '.v2-chat__new-pod-action-text, .v2-chat__new-pod-status', // 11.0px — no-mono-family
  '.v2-chat__new-pod-error', // 11.0px — no-mono-family
  '.v2-chat__title-mark', // 11.0px — no-mono-family
  '.v2-msg__file-icon', // 10.0px — no-mono-family
  '.v2-msg__file-size', // 11.0px — no-mono-family
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
  '.v2-root button.v2-composer__send', // 11.0px — no-mono-family
  // PR3 (20)
  '.v2-activity__compose h2.v2-activity__compose-label', // 11.0px — no-mono-family
  '.v2-activity__count', // 11.0px — no-mono-family
  '.v2-activity__count-chip, .v2-activity__status', // 11.0px — no-mono-family
  '.v2-activity__eyebrow', // 11.0px — no-mono-family
  '.v2-inspector__approval-agent', // 11.5px — no-mono-family
  '.v2-inspector__approval-waiting', // 11.5px — no-mono-family
  '.v2-inspector__artifact-sub', // 11.0px — no-mono-family
  '.v2-inspector__chip', // 11.0px — no-mono-family
  '.v2-inspector__detail-kicker', // 10.0px — no-mono-family
  '.v2-inspector__member-role', // 11.0px — no-mono-family
  '.v2-inspector__now-eyebrow', // 10.0px — mono-below-floor
  '.v2-inspector__pill', // 11.0px — no-mono-family
  '.v2-inspector__section-subtitle', // 11.0px — no-mono-family
  '.v2-inspector__section-title', // 10.0px — no-mono-family
  '.v2-inspector__tab-count', // 10.0px — no-mono-family
  '.v2-inspector__task-assignee', // 11.0px — no-mono-family
  '.v2-mobile-tabs__badge', // 10.0px — mono-below-floor
  '.v2-rail__utility .v2-lang-switch__trigger', // 11.0px — no-mono-family
  '.v2-root button.v2-inspector__tab', // 11.5px — no-mono-family
  '.v2-workspace-inspector__avatar.v2-avatar', // 10.0px — no-mono-family
  // PR4 (12)
  '.v2-billing__badge', // 11.0px — no-mono-family
  '.v2-byo__mode-kicker', // 10.0px — no-mono-family
  '.v2-byo__mode-meta', // 11.0px — no-mono-family
  '.v2-byo__preview-label', // 11.0px — no-mono-family
  '.v2-byo__stat-label', // 11.0px — no-mono-family
  '.v2-runtime-host', // 9.5px — no-mono-family
  '.v2-runtime-mono', // 9.5px — no-mono-family
  '.v2-runtime-mono__byo', // 8.5px — no-mono-family
  '.v2-runtime-pill', // 11.0px — no-mono-family
  '.v2-runtime-pill__mono', // 10.0px — no-mono-family
  '.v2-runtime-row__byo', // 9.0px — no-mono-family
  '.v2-runtime-row__label', // 10.5px — no-mono-family
  // unassigned (31)
  '.v2-approval__badge', // 10.5px — mono-below-floor
  '.v2-approval__time', // 11.5px — no-mono-family
  '.v2-board__card-id', // 10.5px — no-mono-family
  '.v2-board__detail-update-author', // 11.5px — no-mono-family
  '.v2-connect__number', // 11.0px — no-mono-family
  '.v2-decision-card__option > span', // 11.0px — no-mono-family
  '.v2-feature__eyebrow', // 11.0px — no-mono-family
  '.v2-filter-count', // 11.0px — no-mono-family
  '.v2-invite-card__meta', // 11.0px — no-mono-family
  '.v2-invite-link', // 11.0px — no-mono-family
  '.v2-invite-manage__empty', // 11.0px — no-mono-family
  '.v2-invite-manage__meta', // 10.0px — no-mono-family
  '.v2-invite-manage__summary', // 11.0px — no-mono-family
  '.v2-invite-manage__url', // 10.0px — mono-below-floor
  '.v2-invite-options__field', // 11.0px — no-mono-family
  '.v2-lang-switch__caret', // 9.0px — no-mono-family
  '.v2-lang-switch__check', // 11.0px — no-mono-family
  '.v2-mention-item__sub', // 11.0px — no-mono-family
  '.v2-modal__error', // 11.0px — no-mono-family
  '.v2-modal__hint--muted', // 11.0px — no-mono-family
  '.v2-pods__create-cancel, .v2-pods__create-submit', // 11.0px — no-mono-family
  '.v2-pods__create-error', // 11.0px — no-mono-family
  '.v2-pods__discover-meta', // 11.0px — no-mono-family
  '.v2-pods__item-icon', // 11.0px — no-mono-family
  '.v2-pods__item-time', // 11.0px — no-mono-family
  '.v2-pods__section-chevron', // 11.0px — no-mono-family
  '.v2-pods__status', // 10.0px — no-mono-family
  '.v2-role-chip', // 10.5px — no-mono-family
  '.v2-root button.v2-admin-users__inline-copy', // 11.0px — no-mono-family
  '.v2-root button.v2-invite-manage__action, .v2-invite-manage__action', // 11.0px — no-mono-family
  '.v2-syscard__time', // 11.5px — no-mono-family
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
    expect(CSS).toContain('font-size: var(--v2-fs-label)');
  });

  test('the scan is measuring something — the sheet parses into many rules', () => {
    // A broken brace or a changed path yields zero rules and a vacuous pass.
    expect(rules().length).toBeGreaterThan(400);
  });
});
