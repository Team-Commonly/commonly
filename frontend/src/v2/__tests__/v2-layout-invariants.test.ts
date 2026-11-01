import fs from 'fs';
import path from 'path';
import { blockAt, blockContaining } from '../lib/cssBlocks';
import { readV2Css } from '../__testkit__/v2Css';

/**
 * Layout-invariant guards for v2 CSS rules that regressed in production.
 *
 * These assert the *presence* of specific override rules, NOT computed layout.
 * jsdom has no layout engine — `scrollHeight`, `offsetHeight`, and `overflow`
 * clipping are all 0 / meaningless — so a render test structurally cannot see
 * these bugs. Both invariants below shipped broken and were caught only by a
 * real-browser (MCP Playwright) measurement:
 *
 *   - Your Team card name was flex-crushed to a single char by the category
 *     chip ("AI Citation Strategist" -> "/"). Fixed in #568 — and it had already
 *     silently regressed once via a stale-base revert of the original fix
 *     (d8140397), so a revert is a real, observed failure mode.
 * This is a deliberate stand-in until a browser-level layout test tier exists.
 * It precisely guards the thing that actually broke: the override rule going
 * missing. If these assertions feel brittle, that's the point — the rule they
 * pin is load-bearing, and it has been removed by accident before.
 */

const read = (rel: string): string =>
  fs.readFileSync(path.join(__dirname, rel), 'utf8');

// The task board's own sheet (S4, lifted from the d215 frame). Its rules left
// v2.css in the same change, so every board guard reads this file.
const boardCss = read('../components/V2PodBoard.css');
// Settings keeps its own sheet, lifted from the d215 frame (TASK-688).
const ss = read('../components/V2SettingsPage.css');

// The team's phone block: the `@media (max-width: 760px)` block that carries
// `.v2-team__grid`, wherever it sits in the sheet — not the last one.
const teamPhoneBlock = (css: string): string =>
  blockContaining(css, '@media (max-width: 760px)', '.v2-team__grid');

// The `@media (max-width: 760px)` block that carries `selector`, wherever it
// sits in the sheet. A phone override is indented inside a media query, so
// `ruleBody` (which prefers a line-start selector) silently returns the desktop
// rule instead — and a guard reading the wrong rule is green while the phone
// layout is broken (TASK-140).
const mediaBlockContaining = (css: string, selector: string): string =>
  blockContaining(css, '@media (max-width: 760px)', selector);

// `within` bounds the read to a slice already taken out of the sheet (an
// at-rule's block, a media query's body). Pass it rather than passing the slice
// as `css`: the call then names the sheet it read AND the scope it read in, so a
// scoped read cannot be mistaken for a whole-sheet one.
const ruleBody = (
  css: string,
  selector: string,
  { within }: { within?: string } = {},
): string => {
  const scope = within ?? css;
  // Prefer a selector at the start of a CSS line. A descendant selector can
  // contain the same text (`.parent .target {`) and is not the rule being
  // pinned.
  const lineStart = scope.indexOf(`\n${selector} {`);
  const start = lineStart === -1 ? scope.indexOf(`${selector} {`) : lineStart + 1;
  if (start === -1) return '';
  const end = scope.indexOf('}', start);
  return end === -1 ? '' : scope.slice(start, end);
};

// TASK-129 supersedes a large sidebar block in place. The current artboard
// rules intentionally live later in the same stylesheet until the chat pass
// removes the retired selectors, so inspect the last exact rule for overrides.
const lastRuleBody = (css: string, selector: string): string => {
  const start = css.lastIndexOf(`\n${selector} {`);
  if (start === -1) return '';
  const end = css.indexOf('}', start);
  return end === -1 ? '' : css.slice(start, end);
};

// Some component rules deliberately share a declaration block with an
// element variant (for example, button + link CTAs). The guard still needs to
// inspect that one block without splitting the production selector just for a
// test helper.
const selectorRuleBody = (css: string, selector: string): string => {
  const selectorStart = css.indexOf(selector);
  if (selectorStart === -1) return '';
  const bodyStart = css.indexOf('{', selectorStart);
  const bodyEnd = css.indexOf('}', bodyStart);
  return bodyStart === -1 || bodyEnd === -1 ? '' : css.slice(bodyStart, bodyEnd);
};

// Brace-matched slice of one at-rule. `indexOf` to the next `@media` is not
// enough on a sheet with nested blocks, and which block a naive slice returns
// depends on the ORDER the file happens to put them in — a guard that asserts on
// the wrong block reads as a pass. Module-level because three describes need it
// and three copies is how the fourth one drifts.
const mediaAt = (css: string, atRule: string): string => {
  const at = css.indexOf(atRule);
  if (at < 0) return '';
  return blockAt(css, at);
};

// The `@media (prefers-reduced-motion: reduce)` block that carries `needle`, not
// the first such block in the sheet: v2-landing.css carries FIVE of them
// (531 / 1395 / 1421 / 1447 / 1517) and a plain `grep -c prefers-reduced-motion`
// reports six because the prose comment at 1356 mentions it. Each occurrence is
// brace-matched, not sliced to the next `@media` — which block a slice lands in
// depends on the order the file happens to put them in, so an assertion can end
// up made about the wrong block and still read as a pass.
const reducedMotionBlock = (css: string, needle: string): string =>
  blockContaining(css, '@media (prefers-reduced-motion', needle);

// Body of a rule that IS the whole selector — anchored at the start of a line, so
// it cannot match a rule where this selector is the TAIL of a longer one.
// `selectorRuleBody` finds the first substring match, which is wrong whenever an
// override names the class before the base rule does: the even-row rules say
// `.v2-landing__feature-row:nth-child(even) .v2-landing__feature-copy { order: 1 }`
// two rules above the base `.v2-landing__feature-copy {` — and a substring check
// reads the override's body instead of the rule's.
const topLevelRuleBody = (css: string, selector: string): string => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp('^' + escaped + ' \\{([^}]*)\\}', 'm').exec(css);
  return match ? match[1] : '';
};

const cssVariable = (css: string, name: string): string | undefined => (
  new RegExp(`${name}\\s*:\\s*([^;]+);`).exec(css)?.[1].trim()
);

const activeAccentBackgroundSelectors = (css: string, classNames: Set<string>): string[] => (
  [...new Set(Array.from(css.matchAll(/([^{}]+)\{([^{}]*)\}/g)).flatMap(([, rawSelector, body]) => {
    if (!/background\s*:\s*var\(--v2-accent(?:-fill)?\)/.test(body)) return [];
    return rawSelector
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split(',')
      .map((selector) => selector.trim().replace(/:hover(?::[^\s.{]+)?/g, ''))
      .filter((selector) => Array.from(classNames).some((className) => (
        new RegExp(`\\.${className}(?![\\w-])`).test(selector)
      )));
  }))].sort()
);

// App.css is shared by legacy V1 and v2. A leading element selector in V1
// styles crosses that boundary unless it is rooted beneath the legacy canvas.
// Keep html/body as the two deliberate document-level exceptions.
const bareElementSelectors = (css: string): string[] => {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const selectorGroups = Array.from(withoutComments.matchAll(/([^{}]+)\{/g), ([, selector]) => selector.trim());

  return selectorGroups
    .filter((selector) => !selector.startsWith('@'))
    .flatMap((selector) => selector.split(',').map((part) => part.trim()))
    .filter((selector) => {
      const element = /^([a-z][\w-]*)\b/i.exec(selector)?.[1].toLowerCase();
      return Boolean(element && !['html', 'body'].includes(element));
    });
};

describe('v2 layout invariants (CSS rule presence)', () => {
  test('/cli/authorize scrolls inside the .v2-root shell on a short viewport (TASK-682)', () => {
    // .v2-root is height 100vh + overflow hidden; the page must override it or
    // the lower controls (Deny / Authorize) are unreachable on a short screen.
    const cli = fs.readFileSync(path.join(__dirname, '../components/V2CliAuthorize.css'), 'utf8');
    const root = /^\.v2-root\.v2-cli-authorize \{([^}]*)\}/m.exec(cli)?.[1] ?? '';
    expect(root).toContain('overflow-y: auto');
    expect(root).toContain('display: grid');
    expect(root).not.toContain('place-items: center');
    expect(/^\.v2-cli-authorize__card \{([^}]*)\}/m.exec(cli)?.[1]).toContain('margin: auto');
    // The legacy V1 form rule (0,2,2) would paint the form #111827.
    expect(cli).toContain('.v2-root.v2-cli-authorize .v2-cli-authorize__card form {');
  });

  const v2 = readV2Css();
  const tokens = read('../../../design-system/tokens.css');
  const aprofile = read('../agents/v2-agent-profile.css');
  const agentSettings = read('../agents/v2-agent-settings.css');
  const byoCss = read('../components/V2AgentBYO.css');
  // R05 lifted the Connect page onto the d215 frame (V2ConnectPage.css).
  const connectCss = read('../components/V2ConnectPage.css');
  // R06 lifted the Your team page onto the d215 frame (V2YourTeamPage.css).
  const teamCss = read('../components/V2YourTeamPage.css');
  const landing = read('../landing/v2-landing.css');
  const podChat = read('../components/V2Thread.tsx');
  const podsSidebar = read('../components/V2PodsSidebar.tsx');
  const podAttention = read('../hooks/useV2PodAttention.ts');
  const podHeaderMeta = read('../hooks/useV2PodHeaderMeta.ts');
  const workspaceInspector = read('../components/V2Inspector.tsx');
  const thread = read('../components/V2Thread.tsx');
  const threadMessages = read('../components/V2ThreadMessages.tsx');
  const messageRow = read('../components/V2MessageRow.tsx');
  const composer = read('../components/V2Composer.tsx');
  const segmented = read('../components/V2Segmented.tsx');
  const primitives = read('../primitives/primitives.css');
  const decisionCard = read('../components/V2DecisionCard.tsx');
  const navRail = read('../components/V2NavRail.tsx');
  const threadCard = read('../components/V2ThreadCard.tsx');
  const v2Layout = read('../components/V2Layout.tsx');
  const mobileTabs = read('../components/V2MobileTabs.tsx');
  const podBoard = read('../components/V2PodBoard.tsx');
  const activityPage = read('../components/V2ActivityPage.tsx');
  const yourTeamPage = read('../components/V2YourTeamPage.tsx');
  const featurePage = read('../components/V2FeaturePage.tsx');
  const v2App = read('../V2App.tsx');
  const app = read('../../App.tsx');
  const appStyles = read('../../App.css');
  const settingsPage = read('../components/V2SettingsPage.tsx');
  const avatarCropDialog = read('../components/V2AvatarCropDialog.tsx');
  const avatar = read('../components/V2Avatar.tsx');
  const billingPanel = read('../components/V2BillingPanel.tsx');
  const appsManagement = read('../../components/AppsManagement.tsx');
  const podModel = read('../../../../backend/models/Pod.ts');

  test('agent Settings key metadata wraps within the page at phone width', () => {
    expect(ruleBody(agentSettings, '.v2-agent-settings__column')).toContain('width: min(100%, 960px)');
    expect(ruleBody(agentSettings, '.v2-agent-settings__key-meta')).toContain('flex-wrap: wrap');
    expect(mediaBlockContaining(agentSettings, '.v2-agent-settings__key-meta')).toContain('display: grid');
  });

  test('agent Settings section headers stack at phone width so the key hint stays visible', () => {
    const phone = mediaBlockContaining(agentSettings, '.v2-agent-settings__section-head');
    const header = selectorRuleBody(phone, '.v2-agent-settings__section-head');
    expect(header).toContain('flex-direction: column');
    expect(header).toContain('align-items: flex-start');
  });

  test('agent Settings phone rows keep the value cell visible under the label', () => {
    const surface = read('../agents/v2-agent-settings-surface.css');
    const phone = surface.slice(surface.indexOf('@media (max-width: 600px)'));
    expect(ruleBody(phone, '.v2-agent-settings-page .lrow .vl')).toContain('grid-row: 2');
    expect(ruleBody(phone, '.v2-agent-settings-page .lrow .ac')).toContain('grid-row: 1 / span 2');
  });

  test('agent Settings buttons retain their chrome over the v2 button reset', () => {
    const button = ruleBody(agentSettings, '.v2-root .v2-agent-settings button:not(.MuiButtonBase-root):not(.b):not(.seg > button):not(.v2-agent-wake-pods__fold)');
    expect(button).toContain('border: 1px solid var(--v2-border)');
    expect(button).toContain('background: var(--v2-surface)');
    expect(ruleBody(agentSettings, '.v2-root .v2-agent-settings .v2-agent-settings__section-head button')).toContain('background: var(--v2-ink)');
  });

  test('agent Settings controls reach 44px at phone width', () => {
    // Same selector as the base button rule, so it wins only by coming after it.
    const base = '.v2-root .v2-agent-settings button:not(.MuiButtonBase-root):not(.b):not(.seg > button):not(.v2-agent-wake-pods__fold)';
    const phone = mediaBlockContaining(agentSettings, '.v2-agent-settings__key-meta');
    expect(selectorRuleBody(phone, base)).toContain('min-height: 44px');
    expect(agentSettings.indexOf(phone)).toBeGreaterThan(agentSettings.indexOf(base + ' {'));

    const surface = read('../agents/v2-agent-settings-surface.css');
    const stack = blockContaining(surface, '@media (max-width: 760px)', '.wt td:not(:first-child) { display: none; }');
    const targets = blockContaining(surface, '@media (max-width: 760px)', '.v2-agent-settings-page .lrow .ac .b {');
    expect(stack).not.toBe('');
    // An opened row shows its hidden cells again; without this the expanded controls stay hidden.
    expect(stack).toContain('.v2-agent-settings-page .wt tr[data-open="true"] td:not(:first-child) { display: block; }');
    // The thead hides at the same width, or a long pod name widens the stacked table past the page.
    const tableStack = blockContaining(surface, '@media (max-width: 760px)', '.wt thead { display: none; }');
    expect(tableStack).toContain('.v2-agent-settings-page .wt, .v2-agent-settings-page .wt tbody, .v2-agent-settings-page .wt tr, .v2-agent-settings-page .wt td { display: block; width: 100%; }');
    // The fold's 28px lives in the stack block; the 44px override has to come after it.
    expect(surface.indexOf(targets)).toBeGreaterThan(surface.indexOf(stack));
    expect(selectorRuleBody(targets, '.v2-agent-settings-page .lrow .ac .b {')).toContain('height: 44px');
    expect(selectorRuleBody(targets, '.v2-agent-settings-page .lrow .ac .b.ib')).toContain('width: 44px');
    const fold = selectorRuleBody(targets, '.v2-agent-settings-page .v2-agent-wake-pods__fold');
    expect(fold).toContain('width: 44px');
    expect(fold).toContain('height: 44px');
    // The pod link keeps a text box (not inline-flex) so a long name still ends in an ellipsis.
    const link = selectorRuleBody(targets, '.v2-agent-settings-page .wt td:first-child a');
    expect(link).toContain('display: block');
    expect(link).toContain('padding-block: 12px');
    expect(link).toContain('line-height: 20px');
    expect(link).toContain('text-overflow: ellipsis');
    const option = selectorRuleBody(targets, '.v2-agent-settings-page .wt .seg > label');
    expect(option).toContain('height: 44px');
    expect(option).toContain('min-width: 44px');
    expect(selectorRuleBody(targets, '.v2-agent-settings-page .wt .sel')).toContain('--box-h: 44px');
    expect(selectorRuleBody(targets, '.v2-agent-settings-page .wt .b {')).toContain('height: 44px');
    expect(selectorRuleBody(targets, '.v2-agent-settings-page .wt .b.ib')).toContain('width: 44px');
    const toggle = selectorRuleBody(targets, '.v2-agent-settings-page .v2-agent-wake-pods__toggle');
    expect(toggle).toContain('min-width: 44px');
    expect(toggle).toContain('min-height: 44px');
    expect(selectorRuleBody(targets, '.v2-agent-settings-page .ph .seg > a')).toContain('height: 44px');
  });

  test('agent Control reconnect remains an ink action with a focus edge', () => {
    const action = ruleBody(agentSettings, '.v2-root .v2-agent-settings a.v2-agent-settings__action');
    expect(action).toContain('background: var(--v2-ink)');
    expect(action).toContain('color: var(--v2-on-ink)');
    expect(ruleBody(agentSettings, '.v2-root .v2-agent-settings a.v2-agent-settings__action:focus-visible'))
      .toContain('box-shadow: var(--v2-focus-ring)');
  });

  test('agent profile Reconnect keeps ink chrome over the primary and link rules', () => {
    const profile = read('../agents/v2-agent-profile.css');
    const reconnect = ruleBody(profile, '.v2-root a.v2-aprofile__btn--reconnect');
    expect(reconnect).toContain('background: var(--v2-ink)');
    expect(reconnect).toContain('color: var(--v2-on-ink)');
    expect(ruleBody(profile, '.v2-root a.v2-aprofile__btn--reconnect:hover'))
      .toContain('background: var(--v2-ink-hover)');
  });

  test('BYO hints do not add paragraph margins to flex gaps', () => {
    expect(ruleBody(byoCss, '.v2-byo__hint')).toContain('margin: 0');
  });

  test('BYO field hints take no space until focused or in error', () => {
    expect(ruleBody(byoCss, '.v2-feature--byo .v2-byo__field > .v2-byo__hint')).toContain('display: none');
    expect(selectorRuleBody(byoCss, '.v2-feature--byo .v2-byo__field:focus-within > .v2-byo__hint, .v2-feature--byo .v2-byo__field--error > .v2-byo__hint'))
      .toContain('display: block');
    // The page's rules left v2.css for the page's own sheet (R04 lift).
    expect(v2).not.toContain('.v2-byo__field');
  });

  test('the global button reset stays a low-specificity default', () => {
    const reset = ruleBody(v2, '.v2-root :where(button:not(.MuiButtonBase-root))');
    expect(reset).toContain('font-family: inherit');
    expect(reset).toContain('border: none');
    expect(reset).toContain('background: none');
    expect(reset).toContain('padding: 0');
    expect(v2).not.toMatch(/^\.v2-root button:not\(\.MuiButtonBase-root\)\s*\{/m);
  });

  test('authored utility controls remain visible after the button reset loses specificity', () => {
    const rail = selectorRuleBody(v2, '.v2-rail__feedback');
    const languageTrigger = ruleBody(v2, '.v2-lang-switch__trigger');
    const languageItem = ruleBody(v2, '.v2-lang-switch__item');
    const mobile = mediaBlockContaining(v2, '.v2-inspector-backdrop');

    // These are deliberate neutral controls, not accidental reset leaks.
    expect(rail).toContain('color: var(--v2-text-tertiary)');
    expect(rail).toContain('background: transparent');
    expect(rail).toContain('border-radius: var(--v2-radius-sm)');
    expect(languageTrigger).toContain('padding: 4px 6px');
    expect(languageItem).toContain('padding: 8px 12px');
    expect(languageItem).toContain('color: var(--v2-text-secondary)');
    expect(mobile).toContain('background: rgba(15, 17, 21, 0.42)');
  });

  // #2287 (QA BYO walk 1): "Other ways to connect" folds the alternatives so the
  // page shows one command, and the needs line is read before the Copy button.
  // jsdom cannot see either; sprint-review deleted all three rules and every
  // other test stayed green.
  // R04 (d215 frame): the disclosure is now a bordered row with a chevron, its
  // contents inset under the summary, and the needs line is a 13px secondary line.
  test('BYO "Other ways" is a bordered disclosure row with a chevron, and the needs line reads before the command', () => {
    const more = ruleBody(byoCss, '.v2-feature--byo .v2-byo__more');
    expect(more).toContain('border-radius: 12px');
    expect(more).toContain('box-shadow: inset 0 0 0 1px var(--v2-border-soft)');
    const summary = ruleBody(byoCss, '.v2-feature--byo .v2-byo__more > summary');
    expect(summary).toContain('cursor: pointer');
    expect(summary).toContain('display: flex');
    expect(summary).toContain('min-height: 52px');
    expect(ruleBody(byoCss, '.v2-feature--byo .v2-byo__more > summary::after')).toContain('rotate(45deg)');
    expect(ruleBody(byoCss, '.v2-feature--byo .v2-byo__more[open] > summary::after')).toContain('rotate(225deg)');
    // The folded contents keep their spacing from the summary and each other.
    expect(ruleBody(byoCss, '.v2-feature--byo .v2-byo__more > :not(summary)')).toContain('margin: 0 16px 14px');
    expect(ruleBody(byoCss, '.v2-feature--byo .v2-byo__needs')).toContain('font-size: 13px');
  });

  // #2670: the Cursor rule card's header names an unbroken save path; without
  // these two declarations it pushes the Copy button out of the card at 390px.
  test('Cursor rule card header wraps its save path inside the card', () => {
    expect(ruleBody(connectCss, '.v2-connect .v2-connect__rule .v2-connect__code-head span')).toContain('min-width: 0');
    expect(ruleBody(connectCss, '.v2-connect .v2-connect__rule .v2-connect__code-head code')).toContain('overflow-wrap: anywhere');
  });

  test('Your Team card name owns its line so the category chip cannot crush it', () => {
    // Direction C: the name sits in its own column of the card head; the
    // crush guard is min-width 0 on the name and the head, not a flex basis.
    const rule = ruleBody(teamCss, '.v2-team .v2-team-card__name');
    expect(rule).toContain('min-width: 0');
    expect(ruleBody(teamCss, '.v2-team .v2-team-card__head')).toContain('min-width: 0');
    // ruleBody reads the first, desktop rule; no phone override may undo it.
    for (const phone of [...teamCss.matchAll(/@media \(max-width: 760px\) \{[\s\S]*?\n\}/g)].map((m) => m[0])) {
      expect(phone).not.toMatch(/v2-team-card__name[^{]*\{[^}]*(nowrap|min-width: auto|flex-shrink: 0)/);
    }
  });

  test('Your Team card name WRAPS — a primary identifier never one-line-ellipsizes (craft audit rule 1)', () => {
    // At 1440px half the fleet's names truncated ("Commonly…", "Pod Summ…").
    // The name wraps to two lines; single-line nowrap+ellipsis was the defect.
    const rule = ruleBody(teamCss, '.v2-team .v2-team-card__name');
    expect(rule).toContain('white-space: normal');
    expect(rule).toContain('-webkit-line-clamp: 2');
    expect(rule).not.toContain('white-space: nowrap');
  });

  test('Your Team keeps template copy out of cards and folds long pod lists', () => {
    expect(yourTeamPage).toContain('isTemplateDescription(description, display)');
    expect(yourTeamPage).toContain("(a.podNames || []).slice(0, 2)");
    expect(yourTeamPage).toContain('v2-team-card__pod--more');
  });

  test('the workspace grid owns the measured 56 / 260 / fluid / 272 geometry', () => {
    // Direction C (walk-1 ruling a, 2026-09-06): 14px page padding and three
    // 14px gaps leave the 782px chat track the artboard measured.
    expect(cssVariable(v2, '--v2-rail-w')).toBe('56px');
    expect(cssVariable(v2, '--v2-pods-w')).toBe('260px');
    expect(cssVariable(v2, '--v2-inspector-w')).toBe('272px');
    expect(lastRuleBody(v2, '.v2-shell')).toContain('gap: 14px');
    expect(lastRuleBody(v2, '.v2-shell')).toContain('padding: 14px');
  });

  test('the workspace keeps each artboard column width declared exactly once', () => {
    // cssVariable() intentionally reads the first match, so it would miss a
    // later media override. Only the chat track may contract before phone.
    for (const name of ['--v2-rail-w', '--v2-pods-w', '--v2-inspector-w']) {
      expect(v2.match(new RegExp(`${name}\\s*:`, 'g')) || []).toHaveLength(1);
    }
  });

  test('the compact rail uses the artboard’s 36px logo and bare 38px nav glyphs (D223, TASK-735)', () => {
    const rail = ruleBody(v2, '.v2-rail');
    const brand = ruleBody(v2, '.v2-rail__brand-icon');
    const item = ruleBody(v2, '.v2-root button.v2-rail__item');
    const active = ruleBody(v2, '.v2-root button.v2-rail__item--active');
    expect(rail).toContain('padding: 6px 8px');
    // The nav glyph must fit the rail's content box or the nav scrolls
    // sideways (staging smoke, "rail no h-scroll @1440px"): rail width, less
    // the pane's 1px border, less both side paddings.
    const railW = Number(/--v2-rail-w:\s*(\d+)px/.exec(v2)?.[1]);
    const padX = Number(/padding: \d+px (\d+)px/.exec(rail)?.[1]);
    const itemW = Number(/(?:^|\s)width: (\d+)px/.exec(item)?.[1]);
    expect(railW - 1 - 2 * padX).toBeGreaterThanOrEqual(itemW);
    expect(brand).toContain('width: 36px');
    expect(brand).toContain('height: 36px');
    expect(item).toContain('width: 38px');
    expect(item).toContain('height: 38px');
    expect(item).toContain('border-radius: var(--v2-r-10, 10px)');
    // At rest a glyph has no box behind it; only the active item is filled.
    expect(item).toContain('background: transparent');
    expect(active).toContain('background: var(--v2-ink)');
    expect(active).toContain('linear-gradient(180deg, var(--v2-fill-a, var(--v2-ink)), var(--v2-fill-b, var(--v2-ink)))');
    // TASK-701: inactive glyphs read a token, so the dark set can lift them.
    expect(item).toContain('color: var(--v2-rail-icon)');
  });

  test('the rail account avatar is the artboard’s 36px square with a hairline ring', () => {
    const accountButton = lastRuleBody(v2, '.v2-rail__account');
    const accountAvatar = lastRuleBody(v2, '.v2-rail__account .v2-avatar');
    const accountCluster = ruleBody(v2, '.v2-rail__user');
    expect(accountButton).toContain('width: 36px');
    expect(accountButton).toContain('height: 36px');
    expect(accountAvatar).toContain('width: 36px');
    expect(accountAvatar).toContain('height: 36px');
    expect(accountAvatar).toContain('border-radius: var(--v2-r-9, 9px)');
    expect(accountAvatar).toContain('border: 0');
    expect(accountAvatar).toContain('box-shadow: 0 0 0 1px var(--v2-av-ring, var(--v2-border-soft))');
    expect(accountCluster).toContain('align-items: center');
  });

  test('sidebar is direction C: a white panel with search, a Recent · All · Pinned segment, and rows that carry mark, pill and time', () => {
    // Walk-1 rulings (2026-09-06): the six 11px mono labels are gone; two
    // 12px semibold section heads plus a folded inventory replace them.
    const panel = lastRuleBody(v2, '.v2-pods');
    const head = ruleBody(v2, '.v2-root button.v2-pods__section-head');
    const row = ruleBody(v2, '.v2-root button.v2-pods__row');
    const mark = ruleBody(v2, '.v2-pods__row-mark');
    const meta = ruleBody(v2, '.v2-pods__row-meta');
    const pill = ruleBody(v2, '.v2-pods__row-pill');
    const search = lastRuleBody(v2, '.v2-pods__search');

    // D223 (TASK-735): the artboard's .pane.pods, a 14px card ringed by a
    // shadow rather than a border, its rows inset by 10px.
    expect(panel).toContain('border: 0');
    expect(panel).toContain('padding: 12px 10px');
    expect(panel).toContain('border-radius: var(--v2-r-14, 14px)');
    expect(panel).toContain('box-shadow: var(--v2-shadow-pane, 0 0 0 1px var(--v2-border-soft))');
    expect(panel).toContain('background: var(--v2-surface)');
    expect(head).toContain('font: 600 12px/16px var(--v2-font)');
    expect(search).toContain('height: 34px');
    expect(podsSidebar).toContain('<ShellGlyph name="search" size={15} />');
    // The + is the artboard's 32px raised key, a glyph rather than a character.
    // D223: the new-pod key is the primitives' 32px secondary icon key.
    expect(podsSidebar).toContain('className="v2p-b v2p-b-s v2p-ib v2-pods__new"');
    expect(primitives).toMatch(/\.v2p-ib \{ width: 32px; height: 32px;/);
    expect(podsSidebar).toContain('<ShellGlyph name="plus" size={17} />');
    expect(row).toContain('grid-template-columns: 24px minmax(0, 1fr) auto');
    expect(row).toContain('min-height: 36px');
    // Rows are inset with 8px corners; the selected one is not a full-bleed block.
    expect(row).toContain('border-radius: var(--v2-r-8, 8px)');
    expect(mark).toContain('width: 24px');
    expect(mark).toContain('height: 24px');
    expect(mark).toContain('font: 600 11px/1 var(--v2-font-mono)');
    const directMark = ruleBody(v2, '.v2-pods__row-mark.v2-avatar');
    expect(directMark).toContain('border: 0');
    expect(directMark).toContain('border-radius: var(--v2-r-6, 6px)');
    expect(meta).toContain('font: 500 11px/16px var(--v2-font-mono)');
    expect(pill).toContain('background: var(--v2-ink)');
    expect(pill).toContain('height: 18px');
    expect(podsSidebar).toContain("'podsSidebar.workspace.recent'");
    // D215 (TASK-691): one segment replaced the Pinned / Recent headings and the
    // "Everything ▸" fold.
    expect(podsSidebar).toContain("'podsSidebar.workspace.all'");
    expect(podsSidebar).toContain('<V2Segmented');
    expect(podsSidebar).not.toContain("'podsSidebar.workspace.everything'");
    expect(podsSidebar).toContain('v2-pods__search');
    expect(podsSidebar).toContain('RECENT_LIMIT');
    // Pinned has an entry point (ux-lead gate 2026-09-06): the pin control is a
    // sibling of the row. D215: an icon on row hover or focus that takes the
    // time's slot, out of sight at rest even when pinned.
    expect(podsSidebar).toContain('togglePin(pod._id)');
    expect(podsSidebar).toContain('<ShellGlyph name="pin"');
    // visibility, not opacity: an opacity-0 pin still catches a tap on the time.
    expect(ruleBody(v2, '.v2-root button.v2-pods__pin')).toContain('visibility: hidden');
    expect(ruleBody(v2, '.v2-root button.v2-pods__pin')).not.toContain('opacity: 0');
    expect(v2).toContain('.v2-pods__rowwrap:hover .v2-pods__pin,\n.v2-pods__rowwrap:has(:focus-visible) .v2-pods__pin { visibility: visible; }');
    // Touch has no hover: the pin shows at rest there, or a phone cannot pin.
    expect(v2).toMatch(/@media \(hover: none\) and \(pointer: coarse\) \{\n  \.v2-root button\.v2-pods__pin \{ visibility: visible; \}\n  \.v2-pods__row-time \{ visibility: hidden; \}/);
    expect(v2).not.toContain('.v2-root button.v2-pods__pin--active { opacity: 1; }');
    expect(v2).not.toContain("button.v2-pods__pin::before { content: '⌖'");
    expect(v2).toContain('.v2-pods__rowwrap:hover .v2-pods__row-time,\n.v2-pods__rowwrap:has(:focus-visible) .v2-pods__row-time { visibility: hidden; }');
    expect(ruleBody(v2, '.v2-pods__row-time')).toContain('min-width: 24px');
    // The shared segment: a tinted track with the checked option raised.
    // D223: the segment draws as the primitives' v2p-seg; v2.css keeps only its states.
    expect(segmented).toContain("'v2p-seg v2-seg'");
    expect(segmented).toContain("' on v2-seg__option--on'");
    expect(ruleBody(primitives, '.v2p-seg')).toContain('display: inline-flex');
    expect(ruleBody(primitives, '.v2p-seg button.on')).toContain('background: var(--v2-surface)');
    expect(v2).not.toMatch(/(^|\n)\.v2-seg \{/);
    expect(ruleBody(v2, '.v2-root button.v2-seg__option:focus-visible')).toContain('box-shadow: var(--v2-focus-ring)');
    expect(ruleBody(v2, '.v2-root button.v2-icon-button:focus-visible')).toContain('box-shadow: var(--v2-focus-ring)');
    expect(v2).toContain('.v2-root .v2-pods__section--kind button.v2-pods__section-head');
    expect(lastRuleBody(v2, '.v2-pods__search:focus-within')).toContain('inset 0 0 0 2px var(--v2-accent)');
    expect(podsSidebar).not.toContain("'podsSidebar.workspace.pods'");
    expect(podsSidebar).not.toContain("'podsSidebar.workspace.channels'");
    expect(podsSidebar).not.toContain('v2-pods__filter');
    expect(podsSidebar).not.toContain('v2-pods__community');
    expect(podsSidebar).not.toContain('v2-pods__subgroup-label');
    expect(v2).not.toContain('.v2-pods__subgroup-label');
    expect(v2).not.toContain('.v2-pods__channel-dot');
  });

  test('pod list rows keep a 44px touch target at 760px and below, with the artboard mark', () => {
    const mobile = blockContaining(v2, '@media (max-width: 760px)', '.v2-root button.v2-pods__row');
    const row = ruleBody(v2, '.v2-root button.v2-pods__row', { within: mobile });
    const pin = ruleBody(v2, '.v2-root button.v2-pods__pin', { within: mobile });

    expect(mobile).not.toBe('');
    expect(row).toContain('min-height: 44px');
    // D223 (TASK-735): the 24px mark and the 13.5px name hold at 390, as drawn.
    expect(row).toContain('grid-template-columns: 24px minmax(0, 1fr) auto');
    expect(ruleBody(v2, '.v2-pods__row-mark', { within: mobile })).toBe('');
    expect(ruleBody(v2, '.v2-pods__row-name', { within: mobile })).toBe('');
    expect(pin).toContain('width: 28px');
    expect(pin).toContain('height: 28px');
  });

  test('phone tab labels keep text contrast while the glyphs take the artboard grey (D223)', () => {
    expect(v2).toContain('.v2-root button.v2-mobile-tabs__item:not(.v2-mobile-tabs__item--active) .v2-mobile-tabs__label { color: var(--v2-text-muted); }');
    // The glyph half: inactive tabs take the artboard's placeholder grey.
    const phone = blockContaining(v2, '@media (max-width: 760px)', '.v2-mobile-tabs__label {');
    // Icons are controls, so they take the rail's 3:1 grey, not the artboard's placeholder.
    expect(ruleBody(v2, '.v2-root button.v2-mobile-tabs__item', { within: phone })).toContain('color: var(--v2-rail-icon)');
    // D223 ruling: the artboard's sans family at the 12px sans floor.
    expect(ruleBody(v2, '.v2-mobile-tabs__label', { within: phone })).toContain('font: 500 12px/14px var(--v2-font)');
  });

  test('rail glyphs at rest are the nearest grey to the artboard that clears 3:1 (D223 ruling)', () => {
    // Measured on the rail's own surface, --v2-shell-bg #eef0f4: the
    // artboard's #98a2b3 is 2.26:1 and #828a99 is 3.05:1.
    expect(v2).toContain('--v2-shell-bg: #eef0f4;');
    expect(v2).toContain('--v2-rail-icon: #828a99;');
    expect(v2.match(/--v2-rail-icon: #5f6979;/g) || []).toHaveLength(2);
  });

  test('the phone pods page leads with the artboard title bar, search behind an icon (D223)', () => {
    expect(podsSidebar).toContain('className="v2-pods__bar"');
    expect(podsSidebar).toContain('v2-pods__search-open');
    expect(podsSidebar).toContain("size={isPage ? 'md' : 'sm'}");
    expect(ruleBody(v2, '.v2-pods__bar')).toContain('height: 52px');
    expect(ruleBody(v2, '.v2-pods__page-title')).toContain('font: 800 21px/1 var(--v2-font-display, var(--v2-font))');
  });

  test('the phone pods bar gives each control a 44px target', () => {
    const icon = topLevelRuleBody(v2, '.v2-pods-aside--page .v2-pods__bar .v2p-ib');
    expect(icon).toContain('width: 44px');
    expect(icon).toContain('height: 44px');
    // .v2-pods__new sets flex: 0 0 32px; without this the New pod key stays 32px wide.
    expect(topLevelRuleBody(v2, '.v2-root .v2-pods-aside--page .v2-pods__bar button.v2-pods__new')).toContain('flex-basis: 44px');
    const theme = topLevelRuleBody(v2, '.v2-pods-aside--page .v2-pods__bar .seg.v2-theme-seg button');
    expect(theme).toContain('position: relative');
    expect(theme).toContain('width: 44px');
    expect(theme).toContain('height: 40px');
    // The 2px the seg's padding takes back comes from ::after, inside the button's own column.
    expect(topLevelRuleBody(v2, '.v2-pods-aside--page .v2-pods__bar .seg.v2-theme-seg button::after')).toContain('inset: -2px 0');
  });

  test('pod search shortcut hint hides on narrow and touch-only screens', () => {
    const hideHint = mediaAt(v2, '@media (max-width: 760px), (hover: none) and (pointer: coarse) {');
    expect(hideHint).not.toBe('');
    expect(ruleBody(v2, '.v2-pods__search-kbd', { within: hideHint })).toContain('display: none');
    expect(v2).not.toContain('.v2-pods__search-kbd::before');
  });

  test('pod create actions beat the button reset and keep phone-sized targets', () => {
    const shared = selectorRuleBody(v2, '.v2-root button.v2-pods__create-cancel,');
    const cancel = ruleBody(v2, '.v2-root button.v2-pods__create-cancel');
    const submit = lastRuleBody(v2, '.v2-root button.v2-pods__create-submit');
    const disabled = ruleBody(v2, '.v2-root button.v2-pods__create-submit:disabled');
    const phone = blockContaining(v2, '@media (max-width: 760px)', '.v2-root button.v2-pods__create-cancel,');

    expect(shared).toContain('padding: 6px 9px');
    expect(shared).toContain('font-size: 12px');
    expect(cancel).toContain('color: var(--v2-text-tertiary)');
    expect(submit).toContain('background: var(--v2-ink)');
    expect(submit).toContain('color: var(--v2-on-ink)');
    expect(disabled).toContain('background: var(--v2-border-strong)');
    expect(phone).not.toBe('');
    expect(ruleBody(v2, '.v2-root button.v2-pods__create-submit', { within: phone })).toContain('min-height: 40px');
  });

  test('the selected pod fills from the row token, so dark can go neutral (TASK-701)', () => {
    const selected = selectorRuleBody(v2, '.v2-root button.v2-pods__row--selected');
    expect(selected).toContain('background: var(--v2-row-active)');
    // D223 (TASK-735): the artboard's .pod.on carries no accent bar.
    expect(selected).not.toContain('inset 3px 0 0');
    expect(selected).toContain('font-weight: 600');
    expect(podsSidebar).not.toContain('v2-pods__item--active');
    expect(podsSidebar).not.toContain('v2-pods__item-dot');
  });

  test('row pills, inspector rows, and the phone tab count derive from one attention collection', () => {
    expect(podAttention).toContain("'/api/activity/decision-queue'");
    expect(v2Layout).toContain('useV2PodAttention()');
    expect(v2Layout).toContain('attentionItems={attention.items}');
    expect(v2Layout).toContain('attentionCountByPod={attention.countByPod}');
    expect(v2Layout).toContain('needsYouCount={attention.count}');
    expect(v2Layout).toContain('attentionCount={attention.count === null ? null : (attention.countByPod[selectedPodId] || 0)}');
    expect(v2Layout).toContain('needsYouCount={attention.count ?? 0}');
    expect(podsSidebar).toContain('attentionCountByPod');
    expect(podsSidebar).toContain('count > 0');
    expect(workspaceInspector).toContain('attentionItems.filter');
    expect(podsSidebar).not.toContain('useV2Unread');
  });

  test('pod kinds are an explicit reviewed mapping, not a complement of direct types', () => {
    expect(podsSidebar).toContain('const ROOM_POD_TYPES');
    expect(podsSidebar).toContain('const ROOM_POD_TYPE_LABELS');
    expect(podsSidebar).toContain('communityListed === true');
    expect(podsSidebar).toContain('export const podKind');
    expect(podsSidebar).toContain('export const isRoomPod');
    expect(podsSidebar).toContain('podKind(pod) !== null');
    expect(podsSidebar).not.toContain('pods.filter((pod) => !isDirectPod(pod))');
  });

  test('every stored pod type has exactly one reviewed sidebar group', () => {
    const entriesFor = (source: string, setName: string): string[] => {
      const match = source.match(new RegExp(`const ${setName} = new Set\\(\\[([\\s\\S]*?)\\]\\);`));
      return Array.from(match?.[1].matchAll(/'([^']+)'/g) || [], ([, entry]) => entry);
    };
    const schemaTypes = Array.from(
      podModel.match(/type:\s*\{[\s\S]*?enum:\s*\[([^\]]+)\],[\s\S]*?default:\s*'chat'/)?.[1].matchAll(/'([^']+)'/g) || [],
      ([, entry]) => entry,
    );
    const roomTypes = entriesFor(podsSidebar, 'ROOM_POD_TYPES');
    const directTypes = entriesFor(podsSidebar, 'DM_POD_TYPES');
    const typeLabelBody = podsSidebar.match(/const ROOM_POD_TYPE_LABELS:[\s\S]*?= \{([\s\S]*?)\};/)?.[1] || '';
    const mappedRoomTypes = Array.from(typeLabelBody.matchAll(/(?:'([^']+)'|(\w+)):\s*'[^']+'/g), ([, quoted, bare]) => quoted || bare);
    const sidebarTypes = [...roomTypes, ...directTypes];

    expect(new Set(sidebarTypes).size).toBe(sidebarTypes.length);
    expect(sidebarTypes.sort()).toEqual(schemaTypes.sort());
    expect(mappedRoomTypes.sort()).toEqual(roomTypes.sort());
  });

  test('bound channels left the sidebar for the pod header meta, read from the same binding endpoint', () => {
    expect(podHeaderMeta).toContain("'/api/integrations/user/all'");
    expect(podHeaderMeta).toContain("row.status === 'connected'");
    expect(thread).toContain('v2-pod-header__channel');
    expect(podsSidebar).not.toContain('/api/integrations');
  });

  test('on the phone the pods list is a page and a pod is the next page — no drawer', () => {
    expect(v2Layout).toContain('phone && !selectedPodId');
    expect(v2Layout).toContain('variant="page"');
    expect(v2Layout).not.toContain('mobileNavOpen');
    expect(v2).toContain('.v2-shell--list');
    expect(v2).toContain('.v2-pods-aside:not(.v2-pods-aside--page) { display: none; }');
    expect(thread).toContain('v2-thread__back');
    expect(thread).not.toContain('v2-chat__mobile-nav-btn');
  });

  test('grouped messages keep the avatar column so text never shifts (craft audit rule 3)', () => {
    // Consecutive same-author messages within the grouping window drop the
    // header row; the ghost cell must match the D215 artboard's 36px avatar
    // column or grouped text mis-aligns with headed text by exactly the
    // avatar width — a defect jsdom cannot see.
    expect(ruleBody(v2, '.v2-thread .v2-msg')).toContain('grid-template-columns: 36px');
    expect(ruleBody(v2, '.v2-thread .v2-msg__avatar-ghost')).toContain('width: 36px');
    expect(ruleBody(v2, '.v2-msg__gutter-time')).toContain('width: 36px');
    // S3b: the typing line is the D215 presence chip; it carries a 7px dot,
    // not faces, so nothing in it can take the 36px message column.
    expect(ruleBody(v2, '.v2-chat__typing-dot')).toContain('width: 7px');
    expect(thread).not.toContain('v2-chat__typing-avatars');
    // The phone hides the panel's Hide key; .v2-root button.<class> outranks
    // the primitive key's display.
    expect(mediaBlockContaining(v2, '.v2-workspace-inspector__hide')).toMatch(/\.v2-root button\.v2-workspace-inspector__hide \{ display: none; \}/);
    expect(workspaceInspector).toContain('className="v2p-b v2p-b-g v2p-ib v2p-b-sm v2-workspace-inspector__head-button v2-workspace-inspector__hide"');
    expect(v2).toContain('.v2-msg--grouped');
  });

  test('the workspace route uses the small replacement components, never the retired chat or bubble files', () => {
    expect(fs.existsSync(path.join(__dirname, '../components/V2PodChat.tsx'))).toBe(false);
    expect(fs.existsSync(path.join(__dirname, '../components/V2MessageBubble.tsx'))).toBe(false);
    expect(thread).toContain("from './V2ThreadMessages'");
    expect(thread).toContain('V2ThreadHistoryStatus');
    expect(threadMessages).toContain("import V2MessageRow from './V2MessageRow'");
    expect(thread).toContain("import V2Composer");
    expect(messageRow).toContain("import V2DecisionCard");
    expect(composer).toContain('const V2Composer');
    expect(decisionCard).toContain('const V2DecisionCard');
  });

  test('direct-agent liveness stays above the composer as a stable, readable row', () => {
    // A successful DM POST is not proof of an active seat. This row keeps
    // liveness and the bounded reply wait outside the scrollable transcript
    // and outside the textarea, so both remain visible while composing.
    const status = ruleBody(v2, '.v2-chat__agent-room-status');
    expect(status).toContain('margin: 6px 18px 0');
    expect(status).toContain('flex: none');
    // The fix command shrinks and wraps inside its row rather than pushing the
    // copy key out of the pane.
    expect(ruleBody(v2, '.v2-chat__agent-room-command')).toContain('display: flex');
    const commandCode = ruleBody(v2, '.v2-chat__agent-room-command code');
    expect(commandCode).toContain('flex: 1');
    expect(commandCode).toContain('min-width: 0');
    expect(commandCode).toContain('overflow-wrap: anywhere');
    const waiting = ruleBody(v2, '.v2-chat__agent-room-status--wait');
    expect(waiting).toContain('var(--v2-font-mono)');
    // The waiting dot is ink, never the success green (d215 frame).
    expect(ruleBody(v2, '.v2-chat__agent-room-status-dot')).toContain('background: var(--v2-ink)');
    // The copy key is a 44px target on a phone (an exception to the 32px desktop key).
    const phone = mediaBlockContaining(v2, '.v2-root button.v2-chat__agent-room-copy { width: 44px');
    expect(phone).toContain('.v2-root button.v2-chat__agent-room-copy { width: 44px; height: 44px; }');
    // The read-only note replaces the composer, so on a phone it clears the
    // fixed 54px tab bar as the composer does.
    expect(mediaBlockContaining(v2, '.v2-chat__readonly { margin')).toContain('.v2-chat__readonly { margin: 4px 12px 66px; }');
    // A 1:1 room's empty state draws the agent at the frame's 32px (two
    // agents at 36px), out-ranking the 28px base avatar inside the thread.
    const face = ruleBody(v2, '.v2-thread .v2-empty--room .v2-avatar');
    expect(face).toContain('width: 32px');
    expect(face).toContain('height: 32px');
    expect(ruleBody(v2, '.v2-thread .v2-empty__stack .v2-avatar')).toContain('width: 36px');
  });

  test('runtime vocabulary stays off Your Team cards (ADR-022 D1, ratified)', () => {
    // The chip shipped in violation of the ratified rule; the craft audit
    // (finding 2) removed it. This pins the removal against reintroduction.
    expect(v2).not.toContain('.v2-team-card__runtime');
    expect(teamCss).not.toContain('.v2-team-card__runtime');
  });

  test('touch inputs are 16px — iOS auto-zoom never fires and never strands the page zoomed', () => {
    // Every input under 16px makes iOS Safari zoom on focus and stay zoomed
    // on blur (2026-08-26). The floor lives in the touch media block and
    // must keep its !important (it has to beat per-component sizes including
    // a legacy 15px !important).
    expect(v2).toMatch(/@media \(hover: none\), \(pointer: coarse\) \{[\s\S]*?\.v2-root input,\n\s*\.v2-root textarea,\n\s*\.v2-root select \{\n\s*font-size: 16px !important;/);
  });

  test('signup controls meet the 44px / 16px phone floor', () => {
    // Task-103: the full-register form was 39px tall with 14px text at 390px,
    // a tap target and Safari zoom regression on the first real-user path.
    const phoneStart = v2.indexOf('@media (max-width: 480px)');
    const phoneBlock = v2.slice(phoneStart, v2.indexOf('@media', phoneStart + 10));
    expect(phoneStart).toBeGreaterThan(-1);
    expect(phoneBlock).toMatch(/\.v2-login__input \{[\s\S]*?min-height: 44px;[\s\S]*?font-size: 16px;/);
    expect(phoneBlock).toMatch(/\.v2-root button\.v2-login__submit \{[\s\S]*?min-height: 44px;[\s\S]*?font-size: 16px;/);
  });

  test('unverified shell banner keeps the named address visible on phones', () => {
    const phoneStart = v2.indexOf('@media (max-width: 480px)');
    const phoneBlock = v2.slice(phoneStart, v2.indexOf('@media', phoneStart + 10));
    const shell = ruleBody(v2, '.v2-authenticated-shell');
    const banner = ruleBody(v2, '.v2-verification-banner');
    const text = ruleBody(v2, '.v2-verification-banner__text');
    const notice = ruleBody(v2, '.v2-verification-banner__notice');

    expect(shell).toContain('grid-template-columns: minmax(0, 1fr)');
    expect(banner).toContain('grid-template-columns: minmax(0, 1fr) auto auto');
    expect(banner).toContain('min-width: 0');
    expect(text).toContain('overflow-wrap: anywhere');
    expect(text).not.toContain('white-space: nowrap');
    expect(text).not.toContain('text-overflow: ellipsis');
    expect(notice).not.toContain('position: absolute');
    expect(phoneBlock).toMatch(/\.v2-verification-banner \{[\s\S]*?grid-template-areas:[\s\S]*?"content dismiss"[\s\S]*?"resend resend"[\s\S]*?font-size: 16px;/);
    expect(phoneBlock).toMatch(/\.v2-root button\.v2-verification-banner__resend \{[\s\S]*?justify-self: start;/);
    expect(ruleBody(v2, '.v2-root button.v2-verification-banner__resend,\n.v2-root button.v2-verification-banner__dismiss')).toContain('min-height: 44px');
    expect(v2).toMatch(/\.v2-root button\.v2-verification-banner__dismiss \{[\s\S]*?width: 44px;/);
  });

  test('Activity queue actions stay in the row grammar and wrap on narrow screens', () => {
    // Day-zero onboarding and approval actions share the queue row. Keeping
    // their action cluster explicit prevents a later button refactor from
    // forcing a third column past a 390px viewport.
    // The desktop declaration shares its rule with the buttons, so it is not
    // eligible for ruleBody's exact-selector helper.
    expect(v2).toMatch(/\.v2-activity__queue-actions,\n\.v2-activity__queue-row button \{\n\s*display: flex;[\s\S]*?gap: 6px;/);
    expect(v2).toMatch(/@media \(max-width: 640px\)[\s\S]*?\.v2-activity__queue-actions \{ grid-column: 2; \}[\s\S]*?\.v2-activity__queue-actions \{ flex-wrap: wrap; \}/);
    expect(v2).toMatch(/@media \(max-width: 640px\)[\s\S]*?\.v2-root \.v2-activity__queue-actions button \{ min-height: 44px; \}/);
    // Every non-option card act is 32 tall at desktop, level with the options (ux-lead 67327):
    // Approve / Deny / Mark handled / Reply / Open read 30 from the shared row-button rule.
    expect(ruleBody(v2, '.v2-root .v2-activity__queue-actions button')).toContain('min-height: 32px');
  });

  test('Activity details clamp to two lines and reveal full copy on hover, focus, or expand', () => {
    const detail = ruleBody(v2, '.v2-root .v2-activity__queue-detail');
    expect(detail).toContain('display: -webkit-box');
    expect(detail).toContain('-webkit-line-clamp: 2');
    expect(detail).toContain('overflow: hidden');
    const reveal = selectorRuleBody(v2, '.v2-root .v2-activity__queue-detail--expanded');
    expect(reveal).toContain('display: block');
    // Tab-in preview is kept; a reader's collapse is excluded so focus can't re-open it (#2407).
    const focusReveal = selectorRuleBody(v2, '.v2-root .v2-activity__queue-detail:focus-visible:not(.v2-activity__queue-detail--dismissed)');
    expect(focusReveal).toContain('display: block');
    expect(focusReveal).toContain('-webkit-line-clamp: unset');
    expect(activityPage).toContain('v2-activity__queue-detail--dismissed');
    expect(reveal).toContain('-webkit-line-clamp: unset');
    const baseDetail = selectorRuleBody(v2, '.v2-root button.v2-activity__queue-detail');
    expect(baseDetail).toContain('color: var(--v2-text-secondary)');
    const mentionDetail = selectorRuleBody(v2, '.v2-root .v2-activity__queue-row--mention .v2-activity__queue-detail');
    expect(mentionDetail).toContain('color: var(--v2-text-primary)');
    expect(v2).toContain('.v2-root:lang(zh) .v2-activity__queue-detail,');
    expect(v2).toContain('.v2-root .v2-activity__queue-detail:hover:not(:focus)');
    expect(v2).toContain('@media (hover: hover)');
    expect(activityPage).toContain('aria-expanded={expandedDetailIds.has(item.id)}');
    expect(activityPage).toContain('v2-activity__queue-detail');
    expect(activityPage).toContain('aria-label={t(\'activity.compose.placeholder\')}');
    expect(activityPage).not.toContain('v2-activity__compose-label');
  });

  test('Activity pagination keeps the Show more affordance visible and keyboard-sized', () => {
    const more = ruleBody(v2, '.v2-activity__queue-more');
    expect(more).toContain('min-height: 36px');
    expect(more).toContain('border: 1px solid var(--v2-accent)');
    expect(more).toContain('color: var(--v2-accent-text)');
    expect(v2).toContain('.v2-activity__queue-more:hover:not(:disabled)');
    expect(v2).toContain('.v2-activity__queue-more:disabled');
  });

  test('DecisionRequest options preserve authored order with one cobalt primary choice', () => {
    // The first build left options inside the narrow actions column. Generic
    // queue-button CSS once made every non-recommended option blue while the
    // first authored option looked secondary — exactly backwards for a fork card.
    const decisionActions = ruleBody(v2, '.v2-activity__queue-row--decision .v2-activity__queue-actions');
    expect(decisionActions).toContain('grid-column: 1 / -1');
    expect(decisionActions).toContain('justify-content: flex-start');
    const decisionActionsOverride = lastRuleBody(v2, '.v2-activity__queue-row.v2-activity__queue-row--decision .v2-activity__queue-actions');
    expect(decisionActionsOverride).toContain('grid-column: 1 / -1');
    expect(decisionActionsOverride).toContain('max-width: none');
    expect(decisionActionsOverride).toContain('width: 100%');
    // Inline at 32px with Other… beside (ux-lead 66400 fix 4), never stacked bars.
    expect(decisionActionsOverride).toContain('flex-direction: row');
    expect(decisionActionsOverride).toContain('flex-wrap: wrap');
    expect(decisionActionsOverride).toContain('gap: 8px');
    expect(lastRuleBody(v2, '.v2-activity__queue-row.v2-activity__queue-row--decision .v2-activity__decision-footer')).toContain('display: contents');
    expect(ruleBody(v2, '.v2-activity__queue-row.v2-activity__queue-row--decision')).toContain('align-items: start');
    expect(lastRuleBody(v2, '.v2-activity__queue-row.v2-activity__queue-row--decision .v2-activity__option-choice'))
      .toContain('flex: 0 1 auto');
    expect(lastRuleBody(v2, '.v2-activity__queue-row.v2-activity__queue-row--decision .v2-activity__option-choice button'))
      .toContain('min-height: 32px');
    expect(lastRuleBody(v2, '.v2-activity__queue-row.v2-activity__queue-row--decision .v2-activity__option-choice button'))
      .toContain('padding-inline: 12px');
    const neutralOptionHover = ruleBody(v2, '.v2-activity__queue-row.v2-activity__queue-row--decision .v2-activity__option-choice button.v2-activity__option:not(.v2-activity__option--primary):hover:not(:disabled)');
    expect(neutralOptionHover).toContain('background: var(--v2-surface-hover)');
    expect(neutralOptionHover).toContain('color: var(--v2-text-primary)');
    const primaryOptionHover = ruleBody(v2, '.v2-root .v2-activity__queue-actions button.v2-activity__option--primary:hover:not(:disabled)');
    expect(primaryOptionHover).toContain('background: var(--v2-accent-strong)');
    expect(primaryOptionHover).toContain('color: var(--v2-on-ink)');
    expect(activityPage).toContain('aria-describedby={describedBy}');
    expect(activityPage).toContain('v2-activity__decision-footer');
    expect(decisionCard).toContain('aria-describedby={describedBy}');
    expect(decisionCard).toContain('v2-decision-card__option-recommended');
    expect(decisionCard).toContain('v2-decision-card__option-description');
    expect(ruleBody(v2, '.v2-decision-card__options')).toContain('display: grid');
    expect(ruleBody(v2, '.v2-decision-card__options')).toContain('gap: 12px');
    expect(ruleBody(v2, '.v2-decision-card__option')).toContain('display: grid');
    expect(ruleBody(v2, '.v2-decision-card__option')).toContain('gap: 4px');

    const neutralOption = ruleBody(v2, '.v2-root .v2-activity__queue-actions button.v2-activity__option');
    expect(neutralOption).toContain('border: 1px solid var(--v2-border)');
    expect(neutralOption).toContain('background: var(--v2-surface)');
    expect(neutralOption).toContain('border-radius: var(--v2-radius-sm)');

    const primaryOption = ruleBody(v2, '.v2-root .v2-activity__queue-actions button.v2-activity__option--primary');
    expect(primaryOption).toContain('background: var(--v2-accent)');
    expect(primaryOption).toContain('color: var(--v2-on-ink)');
    expect(v2).toContain('v2-activity__queue-action--bordered');
    const borderedAction = ruleBody(v2, '.v2-root .v2-activity__queue-actions button.v2-activity__queue-action--bordered');
    expect(borderedAction).toContain('border: 1px solid var(--v2-border)');
    expect(ruleBody(v2, '.v2-root .v2-activity__compose .v2-activity__compose-picker-button')).toContain('border: 1px solid var(--v2-border)');
    const composeMenu = ruleBody(v2, '.v2-root .v2-activity__compose .v2-activity__compose-picker-menu');
    expect(composeMenu).toContain('max-height: 240px');
    expect(composeMenu).toContain('overflow-y: auto');
    const composeOption = ruleBody(v2, '.v2-root .v2-activity__compose .v2-activity__compose-picker-option');
    expect(composeOption).toContain('min-height: 30px');
    expect(composeOption).toContain('background: transparent');
    expect(composeOption).toContain('color: var(--v2-text-primary)');
    const composeOptionHover = ruleBody(v2, '.v2-root .v2-activity__compose .v2-activity__compose-picker-menu button.v2-activity__compose-picker-option:hover:not(:disabled)');
    expect(composeOptionHover).toContain('background: var(--v2-surface-hover)');
    expect(composeOptionHover).toContain('color: var(--v2-text-primary)');
    expect(composeOptionHover).toContain('border-color: transparent');
    expect(v2).toMatch(/@media \(max-width: 640px\) \{[\s\S]*?\.v2-root \.v2-activity__compose \.v2-activity__compose-picker-menu \.v2-activity__compose-picker-option \{ min-height: 44px; \}/);
    const otherOption = ruleBody(v2, '.v2-root .v2-activity__queue-actions button.v2-activity__option.v2-activity__queue-action--secondary');
    expect(otherOption).toContain('color: var(--v2-accent-text)');
    expect(v2).toContain('.v2-activity__option-description');
    expect(activityPage).toContain('(option, index)');
    expect(activityPage).not.toContain('.sort((a, b) => Number(Boolean(b.recommended))');
    expect(thread).toContain("loadDecisionPages<T>(");
    expect(thread).toContain("'/api/activity/decision-queue'");
    expect(thread).toContain("'/api/activity/decision-history'");
    expect(thread).toContain('DECISION_MESSAGE_ID_BATCH_SIZE = 200');
    expect(thread).toContain('loadDecisionPagesForMessageIds<ThreadDecision>');
    expect(thread).toContain('loadedMessageIdsRef.current = [...new Set(messages');
    expect(thread).toContain('if (pendingData)');
    expect(thread).toContain("'/api/activity/decision-history'");
    expect(thread).toContain('settledDecisionByMessageId');
  });

  test('the mobile inspector is a drawer, never display:none — the header avatars button must do something', () => {
    // Below 1024px the pane used display:none while V2Layout still mounted it
    // on tap: the avatar-stack button looked broken and members/files were
    // unreachable on phones (2026-08-26). The pane's presence in the DOM
    // is the open state, so the drawer needs no extra toggle class.
    // Slice the 1023px block out rather than regex across it — a lazy
    // [\s\S]*? happily crosses media-block boundaries and matches unrelated
    // rules pages later.
    const start = v2.indexOf('@media (max-width: 1023px)');
    expect(start).toBeGreaterThan(-1);
    const block = v2.slice(start, v2.indexOf('@media', start + 10));
    expect(block).toContain('.v2-shell:not(.v2-shell--feature-wide)');
    expect(block).not.toMatch(/\.v2-shell\s*\{/);
    expect(block).not.toContain('display: none');
    // S3c (D223): the drawer rule moved to chat/chat-inspector.css in its own
    // 1023px block; read that block the same way.
    const drawerStart = v2.indexOf('@media (max-width: 1023px) {\n  /* Below the 3-pane width the inspector');
    expect(drawerStart).toBeGreaterThan(-1);
    const drawer = v2.slice(drawerStart, v2.indexOf('@media', drawerStart + 10));
    expect(drawer).toContain('.v2-pane--inspector');
    expect(drawer).toContain('position: fixed');
    expect(drawer).not.toContain('display: none');
    // The 760px secondary-pane eraser out-specifies the drawer (0-4-0 vs
    // 0-1-0); the inspector must be in its :not chain or the drawer is a
    // mounted-but-invisible pane again — the exact live bug, twice.
    expect(v2).toContain(':not(.v2-pods-aside):not(.v2-pane--inspector)');
  });

  test('Artifacts (direction C, PR 5): display head, one segment grammar, bordered ext chip, mono numbers, phone block', () => {
    const artifactsPage = fs.readFileSync(path.join(__dirname, '../components/V2ArtifactsPage.tsx'), 'utf8');
    expect(v2App).toContain("'v2-feature--artifacts'");
    expect(v2App).toContain('<V2ArtifactsPage />');
    expect(ruleBody(v2, '.v2-artifacts__title')).toContain('32px/1.1 var(--v2-font-display)');
    expect(ruleBody(v2, '.v2-page-head__meta')).toContain('color: var(--v2-text-muted)');
    expect(ruleBody(v2, '.v2-artifacts__seg')).toContain('border: 1px solid var(--v2-border)');
    expect(ruleBody(v2, '.v2-root button.v2-artifacts__seg-button--active')).toContain('background: var(--v2-surface-hover)');
    expect(ruleBody(v2, '.v2-root button.v2-artifacts__seg-button--active')).not.toContain('var(--v2-ink)');
    const ext = ruleBody(v2, '.v2-artifacts__ext');
    expect(ext).toContain('border: 1px solid var(--v2-border)');
    expect(ext).toContain('var(--v2-font-mono)');
    expect(ruleBody(v2, '.v2-artifacts__mono')).toContain('var(--v2-font-mono)');
    expect(ruleBody(v2, '.v2-artifacts__table-wrap')).toContain('overflow-x: auto');
    expect(ruleBody(v2, '.v2-root button.v2-artifacts__more')).toContain('color: var(--v2-accent-text)');
    // page = text/html only shows no size; the ext chip is the extension, never a colour square.
    expect(artifactsPage).toContain("item.kind === 'page' ? '—' : formatSize(item.size)");
    expect(artifactsPage).toContain('extOf(item.name)');
    expect(v2).toMatch(/@media \(max-width: 760px\) \{[\s\S]*?\.v2-artifacts__controls \{ flex-direction: column; align-items: stretch; \}/);
    // ux-lead 66462: mono floor 11 on the chip; the table spans the content area (no centred cap);
    // ≤760 hides pod / shared-by / size and folds the pod under the name; the head stays 32.
    expect(ext).toContain('11px/14px var(--v2-font-mono)');
    expect(ruleBody(v2, '.v2-workspace-inspector__ext')).toContain('11px/14px var(--v2-font-mono)');
    expect(ruleBody(v2, '.v2-artifacts')).not.toContain('1040px');
    expect(v2).toMatch(/@media \(max-width: 760px\) \{[\s\S]*?\.v2-artifacts__pod-line \{ display: block; flex: 1 1 100%; \}/);
    expect(v2).not.toMatch(/@media \(max-width: 760px\) \{[\s\S]*?\.v2-artifacts__title \{ font-size: 28px; \}/);
    // An image row opens the chat lightbox; pages and docs open in a new tab (66462 overrule).
    expect(artifactsPage).toContain("if (item.kind === 'image') { setLightbox(item); return; }");
    expect(workspaceInspector).toContain("if (file.kind === 'image') { setLightbox(file); return; }");
    // Inspector Files pane: same rows, ext chip in front, All N files as cobalt text.
    expect(workspaceInspector).toContain("'inspector.workspace.files'");
    expect(workspaceInspector).toContain('/api/artifacts?podId=');
    expect(ruleBody(v2, '.v2-root button.v2-workspace-inspector__all-files')).toContain('color: var(--v2-accent-text)');
  });

  test('workspace inspector is the small three-card replacement, with a phone sheet rather than legacy tabs', () => {
    // TASK-129 replaces the 86KB tabbed inspector in the same cutover as the
    // artboard cards. Keeping the old component anywhere in the route would
    // turn this back into a skin over two competing inspector models.
    expect(fs.existsSync(path.join(__dirname, '../components/V2PodInspector.tsx'))).toBe(false);
    expect(workspaceInspector).toContain('v2-workspace-inspector__card v2-workspace-inspector__group');
    expect(workspaceInspector).toContain("'inspector.workspace.agents'");
    expect(workspaceInspector).toContain("'inspector.workspace.needsYou'");
    // D215: the mono captions ("agents in sharpen") are gone; each group is a
    // 44px fold row at rest, and members / manage are head icon buttons.
    expect(workspaceInspector).not.toContain("'inspector.workspace.agentsIn'");
    expect(workspaceInspector).not.toContain('shortRoomName');
    expect(workspaceInspector).not.toContain('v2-workspace-inspector__foot');
    expect(workspaceInspector).toContain('className="v2-workspace-inspector__fold"');
    expect(ruleBody(v2, '.v2-root button.v2-workspace-inspector__fold')).toContain('height: 44px');
    expect(ruleBody(v2, '.v2-workspace-inspector__card.v2-workspace-inspector__group')).toContain('flex: none');
    expect(ruleBody(v2, '.v2-workspace-inspector__fold-label')).toContain('text-overflow: ellipsis');
    expect(ruleBody(v2, '.v2-workspace-inspector__head')).toContain('flex: none');
    // board · today left the inspector on ruling 66311; the board keeps its own tab.
    expect(workspaceInspector).not.toContain("'inspector.workspace.boardToday'");
    expect(workspaceInspector).toContain('v2-workspace-inspector__state--${state.kind}');
    expect(workspaceInspector).not.toContain('v2-inspector__tabs');
    expect(workspaceInspector).not.toContain('v2-inspector__progress');

    const card = ruleBody(v2, '.v2-workspace-inspector__card');
    // D223 (TASK-735): the artboard's details.grp, a 14px card ringed by the pane shadow.
    expect(card).toContain('border: 0');
    expect(card).toContain('box-shadow: var(--v2-shadow-pane, 0 0 0 1px var(--v2-border-soft))');
    expect(card).toContain('border-radius: var(--v2-r-14, 14px)');
    expect(ruleBody(v2, '.v2-workspace-inspector__state--needs-you')).toContain('background: var(--v2-accent)');
    expect(ruleBody(v2, '.v2-workspace-inspector__state--working')).toContain('animation: v2-pulse');
    const stateDot = ruleBody(v2, '.v2-workspace-inspector__state');
    expect(stateDot).toContain('width: 8px');
    expect(stateDot).toContain('height: 8px');
    const avatar = ruleBody(v2, '.v2-workspace-inspector__avatar.v2-avatar');
    expect(avatar).toContain('border: 0');
    expect(avatar).toContain('box-shadow: none');
    const label = ruleBody(v2, '.v2-workspace-inspector__label');
    expect(label).toContain('font: 600 13px/18px var(--v2-font)');
    expect(label).toContain('white-space: nowrap');
    expect(label).not.toContain('text-transform: lowercase');
    const close = selectorRuleBody(v2, '.v2-root button.v2-workspace-inspector__close');
    expect(close).toContain('display: none');
    expect(v2).toContain('.v2-root button.v2-workspace-inspector__close { display: inline-grid; }');

    const phoneSheetStart = v2.lastIndexOf('/* The inspector is a bottom sheet on phones');
    const phoneSheet = v2.slice(phoneSheetStart, v2.indexOf('/* ---------- Workspace inspector', phoneSheetStart));
    expect(phoneSheetStart).toBeGreaterThan(-1);
    expect(phoneSheet).toContain('top: auto');
    expect(phoneSheet).toContain('width: 100%');
    expect(v2Layout).toContain('className="v2-inspector-backdrop"');
  });

  test('v2 claims the page canvas — the V1 dark body cannot show through', () => {
    // App.tsx stamps `modern-ui` (V1 dark gradient) on <body> unconditionally;
    // .v2-root paints only its own box. Without this override the V1 dark
    // showed on load flash, overscroll, and gaps (2026-08-24). The
    // compound selector must out-rank body.modern-ui so bundle order can
    // never decide the canvas color. Keep the literal in lockstep with
    // --v2-page-bg (tokens don't reach body — it sits outside .v2-root).
    expect(v2).toContain('body.modern-ui.v2-canvas');
    expect(v2).toMatch(/body\.v2-canvas,\nbody\.modern-ui\.v2-canvas \{[\s\S]*?background: #f8f8fb/);
    expect(v2).toContain('--v2-page-bg: #eef0f4');
    // The flash half of the same bug: App.css's BARE body rule painted every
    // load dark before React could stamp any class. The dark default is
    // V1-scoped under body.modern-ui; the bare default matches v2's canvas.
    const appCss = read('../../App.css');
    // The standalone `body {` rule, not the `html,\nbody {` reset above it —
    // hence the no-comma-before lookbehind.
    const bareBody = appCss.match(/(?<!,)\nbody \{([^}]*)\}/)?.[1] ?? '';
    expect(bareBody).toContain('background-color: #f8f8fb');
    expect(bareBody).not.toContain('#0b1220');
    expect(ruleBody(appCss, 'body.modern-ui')).toContain('#0b1220');
    // The render-time half: MUI CssBaseline injects the V1 palette's dark
    // body at render, and V2App's useEffect class lands only after first
    // paint — so the entry file must stamp v2-canvas synchronously at boot
    // for the v2 front door, or every load flashes one dark frame.
    const entry = read('../../index.tsx');
    expect(entry).toContain("classList.add('v2-canvas')");
    expect(entry.indexOf("classList.add('v2-canvas')"))
      .toBeLessThan(entry.indexOf('createRoot'));
    // The FOURTH and largest dark source: index.html ships the dark
    // prerendered #seo-page INSIDE #root on every route, painted for the
    // beat before React replaces it. The head script stamps `js` on <html>
    // before first paint and CSS hides the prerender; crawlers without JS
    // still see the content. The script must PRECEDE the style block that
    // uses it, and both must precede </head>.
    const indexHtml = read('../../../index.html');
    // Rev 2 (the flash was re-sighted, 2026-08-26): the script-gate had a
    // timing window — delayed head-script execution painted the prerender.
    // Hidden-by-default has none: #seo-page is display:none from the first
    // byte, and <noscript> reveals it only for text-only crawlers. The
    // noscript override must carry !important to beat the base rule.
    expect(indexHtml).toContain('#seo-page { display: none; }');
    expect(indexHtml).toMatch(/<noscript><style>#seo-page \{ display: block !important; \}<\/style><\/noscript>/);
    // The FIFTH dark source, and the only one the TASK-145 route split
    // introduced: the Suspense fallback frame. It mounts in `.App`, OUTSIDE
    // `.v2-root`, so `var(--v2-page-bg, #0b1220)` could never reach the token
    // (`#eef0f4` is declared on .v2-root, v2.css:22) and its navy fallback
    // painted the whole viewport — the SAME shape as the four above, one
    // mount point further out. ux-lead's #1861 gate, 390 at 1.6 Mbps: light
    // at 3.0 s from the entry CSS, #0b1220 from 4.4 s to 7.35 s from this
    // frame, light again. Three seconds of the flash ruled out on 08-24,
    // and under 150 ms unthrottled, so a laptop check cannot see it.
    //
    // The frame therefore paints nothing and lets the bare-body canvas pinned
    // three assertions above show through; the boot colour IS that body
    // colour, which is why it is asserted up there and not restated here. A
    // literal `#f8f8fb` in the frame would work today and drift tomorrow — the
    // body is where that value is pinned in lockstep with --v2-page-bg. Its
    // height is the one thing the frame owns, so the viewport never jumps.
    const appEntry = read('../../App.tsx');
    const routeBoot = appEntry.slice(
      appEntry.indexOf('const RouteBoot'),
      appEntry.indexOf('class AppErrorBoundary'),
    );
    // Read the STYLE PROP, not the slice: the comment above it legitimately
    // names both the token and the navy fallback, and a bare /background/
    // over the slice would red on the explanation rather than the code.
    const bootStyle = /style=\{\{([^}]*)\}\}/.exec(routeBoot)?.[1] ?? '';
    expect(bootStyle).toContain("minHeight: '100vh'");
    expect(bootStyle).not.toMatch(/background/);
  });

  test('the conversation column is FULL-WIDTH — no measure cap, one left edge (rule 2, v5)', () => {
    // Fifth mechanism, ruled 2026-08-23: the Slack model. With a
    // line cap, leftover space must pool somewhere — center was rejected,
    // and left-anchor pools it all on the right — so the cap itself goes.
    // No revision may reintroduce a conversation measure token: that is
    // the corner-of-the-triangle debate re-opening by accident.
    expect(v2).not.toContain('--v2-conv-measure');
    // v6 (2026-09-01): the var ban was not enough — #1367 reintroduced the
    // cap as a LITERAL (`max-width: 75ch`) via a craft audit that called it
    // a P0, and even claimed this test guarded it. The third ruling:
    // full-width stands. Ban any ch-unit max-width inside the message
    // content block, not just the token.
    const msgContentBlock = v2.slice(v2.indexOf('.v2-msg__content {'), v2.indexOf('.v2-msg__content p'));
    expect(msgContentBlock).not.toMatch(/max-width:\s*\d+ch/);
    // What survives every revision is COHERENCE: messages' and composer's
    // children share the pane's full width and one explicit left edge.
    // margin-inline stays an explicit 0 — a stray auto re-centers a subset
    // of rows and recreates the v1 island.
    expect(ruleBody(v2, '.v2-chat__messages > *')).toContain('width: 100%');
    expect(ruleBody(v2, '.v2-chat__messages > *')).toContain('margin-inline: 0');
    // D215 (TASK-734): the composer is a floating card on the pop shadow, so
    // no border draws its edge; the plus is a ghost key inside it.
    expect(ruleBody(v2, '.v2-composer')).toContain('border: 0');
    expect(ruleBody(v2, '.v2-composer')).toContain('box-shadow: var(--v2-shadow-pop');
    expect(composer).toContain('className="v2p-b v2p-b-g v2p-ib v2-composer__plus"');
    // Nothing in the column may escape the shared edge (2026-08-23:
    // mentions and threads sat off-grid while messages aligned).
    // Mentions: no row wash and no bleed (D224); the tint is on the chip only.
    expect(v2).not.toContain('.v2-chat__messages > .v2-msg--mention');
    // Threads (ux-lead 64476 (2)): the ROOT now renders inside the block, so
    // the block itself is a full-width child like any message and the INDENT
    // moved to the inner wrap (chip + rail at the text column, 36px avatar +
    // 12px gap, D215).
    const block = ruleBody(v2, '.v2-thread-block');
    expect(block).toContain('width: 100%');
    expect(ruleBody(v2, '.v2-thread .v2-thread-block__inner')).toContain('margin-left: 48px');
    // Indent + width must still sum to 100%: an indented child that ALSO
    // carried width:100% pushed every thread past the pane's right edge and
    // made the transcript horizontally swipeable (2026-08-24; 350 vs
    // 326 scrollWidth at 390). The inner wrap must never take a width.
    expect(ruleBody(v2, '.v2-thread .v2-thread-block__inner')).not.toContain('width');
    // S3b: the phone indent is D215's 40px (.app.m .thr), in the 760 block.
    expect(ruleBody(v2, '.v2-thread .v2-thread-block__inner', { within: mediaBlockContaining(v2, '.v2-thread .v2-thread-block__inner') })).toContain('margin-left: 40px');
    // Belt-and-braces: the transcript itself never scrolls sideways.
    expect(ruleBody(v2, '.v2-chat__messages')).toContain('overflow-x: hidden');
    expect(ruleBody(v2, '.v2-thread-block')).toContain('margin-bottom');
  });

  test('motion timing is tokenized and all three active V2 animations consume it', () => {
    expect(tokens).toContain('--motion-stagger:    0.18s');
    expect(tokens).toContain('--motion-breath:     1.2s');
    expect(tokens).toContain('--motion-ease-breath: ease-in-out');
    expect(tokens).toContain('--motion-ease-state:  ease-out');
    expect(tokens).toContain('--motion-ease-linear: linear');

    // V2 is a scoped stylesheet, so it cannot inherit :root tokens directly.
    // Bind its local copy to the design-system source of truth rather than
    // allowing the two timing layers to quietly diverge.
    const v2Root = ruleBody(v2, '.v2-root');
    for (const name of [
      '--motion-stagger',
      '--motion-breath',
      '--motion-pulse',
      '--motion-spin',
      '--motion-ease-breath',
      '--motion-ease-state',
      '--motion-ease-linear',
    ]) {
      expect(cssVariable(v2Root, name)).toBe(cssVariable(tokens, name));
    }

    // S3b: the typing dots became the presence chip's pulse; the breath token
    // is still consumed by the boot mark (asserted above).
    expect(ruleBody(v2, '.v2-chat__typing-dot::after')).toContain('var(--motion-pulse)');
    expect(ruleBody(v2, '.v2-workspace-inspector__state--working')).toContain('var(--motion-pulse)');
    expect(ruleBody(v2, '.v2-spinner')).toContain('var(--motion-spin)');
  });

  test('the app boot mark reuses the typing keyframes and does not replace state spinners', () => {
    expect(ruleBody(v2, '.v2-boot__mark-dot')).toContain('animation: v2-typing-dot');
    expect(ruleBody(v2, '.v2-boot__mark-dot:nth-of-type(2)')).toContain('var(--motion-stagger)');
    expect(ruleBody(v2, '.v2-boot__mark-dot:nth-of-type(3)')).toContain('var(--motion-stagger)');
    expect(ruleBody(v2, '.v2-spinner')).toContain('animation: v2-spin');
  });

  test('Your Team grid columns can shrink below 320px on phones', () => {
    // A bare minmax(320px, 1fr) floor overflows the ~326px content area on a
    // 390px phone (nav rail eats the rest) — the agent card clipped its
    // "Talk to" button off-screen (2026-07-03 mobile smoke). min(320px, 100%)
    // lets the column collapse to the container width.
    // Direction C: three equal columns that can shrink to zero, and ONE column
    // at ≤760 — the same guarantee (a column never wider than its container)
    // expressed on the new grid.
    expect(ruleBody(teamCss, '.v2-team .v2-team__grid')).toContain('repeat(3, minmax(0, 1fr))');
    expect(ruleBody(teamCss, '.v2-team .v2-team__grid', { within: teamPhoneBlock(teamCss) })).toContain('repeat(1, minmax(0, 1fr))');
  });

  test('the agent profile page overrides the app-shell overflow too (sibling invariant)', () => {
    // Any full-page `.v2-root.<surface>` must set its own scroll, or the base
    // `.v2-root { height:100vh; overflow:hidden }` clips it. This is the general
    // rule the showcase bug taught us; keep the known-good example pinned.
    expect(ruleBody(aprofile, '.v2-root.v2-aprofile')).toContain('overflow-y: auto');
  });

  test('the authenticated agent-profile Talk button is ink, while public links stay cobalt', () => {
    const linkPrimary = ruleBody(aprofile, '.v2-aprofile__btn--primary');
    const buttonPrimary = ruleBody(aprofile, '.v2-root button.v2-aprofile__btn--primary');

    expect(linkPrimary).toContain('background: var(--v2-accent)');
    expect(buttonPrimary).toContain('background: var(--v2-ink)');
    expect(buttonPrimary).toContain('border-color: var(--v2-ink)');
    expect(aprofile).toContain('.v2-root button.v2-aprofile__btn--primary:hover');
    expect(aprofile).toContain('background: var(--v2-ink-hover)');
  });

  test('agent profile Phase B uses ink actions, the halo, and the type ladder', () => {
    const primary = ruleBody(aprofile, '.v2-root button.v2-aprofile__btn--primary');
    expect(primary).toContain('background: var(--v2-ink)');
    expect(primary).not.toContain('var(--v2-accent)');
    expect(ruleBody(aprofile, '.v2-root button.v2-aprofile__btn--primary:hover')).toContain('var(--v2-ink-hover)');
    expect(ruleBody(aprofile, '.v2-root .v2-aprofile__btn--primary')).toContain('color: var(--v2-on-ink)');
    // The footer CTA sits on the accent-deep band, so it keeps main's white fill.
    // An ink fill there reads as a dark hole (review 5673841827).
    const footerPrimary = ruleBody(aprofile, '.v2-root .v2-aprofile__footer-cta .v2-aprofile__btn--primary');
    expect(footerPrimary).toContain('background: var(--v2-on-accent, #fff)');
    expect(footerPrimary).toContain('color: var(--v2-accent-fill, var(--v2-accent))');

    const avatarFocus = ruleBody(aprofile, '.v2-root button.v2-aprofile__avatar-button:focus-visible');
    expect(avatarFocus).toContain('outline: none');
    expect(avatarFocus).toContain('box-shadow: var(--v2-focus-ring)');

    for (const selector of ['.v2-aprofile__empty-title', '.v2-aprofile__name', '.v2-aprofile__stat-num']) {
      expect(ruleBody(aprofile, selector)).toContain('font-weight: 700');
    }
    expect(aprofile).not.toContain('font-weight: 850');
  });

  test('the nav rail pane lets its language dropdown escape the pane clip', () => {
    // The rail is 56px wide; its language menu is a wider floating popover.
    // Base `.v2-pane { overflow: hidden }` clips it to the rail edge, so the
    // menu rendered cut-off "outside the sidebar" (2026-07-23). `.v2-pane--rail`
    // must override to overflow: visible so the menu floats over the pods sidebar.
    expect(ruleBody(v2, '.v2-pane--rail')).toContain('overflow: visible');
  });

  test('the nav rail exposes badges and hover labels, scrolling only in short viewports', () => {
    expect(ruleBody(v2, '.v2-rail__nav')).toContain('overflow: visible');
    const shortViewport = mediaAt(v2, '@media (max-height: 460px)');
    expect(shortViewport).not.toBe('');
    const shortNav = ruleBody(v2, '.v2-rail__nav', { within: shortViewport });
    expect(shortNav).toContain('overflow-y: auto');
    expect(shortNav).toContain('overflow-x: hidden');
  });

  test('the Activity badge stays inside the rail at three digits, and keeps the exact count on the element', () => {
    // TASK-363. A three-digit count ("230") pushed the badge 6px past the rail
    // edge, and the nav scrolled sideways. The fix is the offset, not a cap:
    // the full count stays visible (see V2CommunityNav "not a capped ... 99+").
    expect(navRail).toContain('title={String(count)}');
    expect(navRail).toContain('className="v2-rail__badge--activity"');
    // Only the Activity badge takes the inward offset. The base rule keeps -14px,
    // and the Activity selector outranks it (0,3,0 against 0,2,0).
    expect(ruleBody(v2, '.v2-rail__item-icon .v2-rail__badge--activity .MuiBadge-badge')).toContain('right: -6px');
    expect(ruleBody(v2, '.v2-rail__item-icon .MuiBadge-badge')).toContain('right: -14px');
  });

  test('team-card actions wrap on narrow screens so the agent name keeps width', () => {
    // At <=560px the Profile+Talk-to actions row must wrap to its own line —
    // inline, it squeezes the flex body to zero and the agent NAME disappears
    // (2026-07-05 mobile smoke; same crush family as the #568 chip bug).
    // Direction C: the action row is its own flex row under the body and wraps;
    // it never shares a line with the name.
    expect(ruleBody(teamCss, '.v2-team .v2-team-card__actions')).toContain('flex-wrap: wrap');
  });

  test('the a2a-DM system card overrides the two-column message grid', () => {
    // .v2-msg is `grid-template-columns: 38px minmax(0,1fr)` (avatar | body).
    // A system notice has a single child (.v2-syscard); without the override it
    // lands in the 38px avatar column, collapsing the headline and wrapping the
    // timestamp (2026-07-05 a2a-DM preview glitch).
    // MUST be the compound `.v2-msg.v2-msg--system` selector: `.v2-msg` sets
    // `display: grid` LATER in the file, so a single-class `.v2-msg--system`
    // ties on specificity and loses on source order (the first ship of this fix
    // regressed on exactly that). Higher specificity wins regardless of order.
    expect(v2).toContain('.v2-msg.v2-msg--system {');
    expect(ruleBody(v2, '.v2-msg.v2-msg--system')).toContain('display: block');
  });

  test('system actions align with message text and keep the avatar and time in their own slots', () => {
    const rule = ruleBody(v2, '.v2-system-action-line');
    expect(rule).toContain('display: grid');
    expect(rule).toContain('grid-template-columns: 16px minmax(0, max-content) auto minmax(0, 1fr) auto');
    expect(rule).toContain('margin-left: 48px');
    expect(rule).toContain('width: calc(100% - 48px)');
    expect(ruleBody(v2, '.v2-thread .v2-system-action-line .v2-avatar')).toContain('width: 16px');
    expect(ruleBody(v2, '.v2-system-action-line__action')).toContain('grid-column: 3;');
    expect(ruleBody(v2, '.v2-system-action-line time')).toContain('grid-column: 5');
    expect(ruleBody(v2, '.v2-system-action-line__name')).toContain('color: var(--v2-text-primary)');
    expect(ruleBody(v2, '.v2-system-action-line__verb')).toContain('color: var(--v2-text-tertiary)');
    expect(ruleBody(v2, '.v2-system-action-line__object')).toContain('var(--v2-font-mono)');
    expect(ruleBody(v2, '.v2-system-action-line time')).toContain('var(--v2-font-mono)');
  });

  test('the feedback popover overrides the legacy dark MUI paper theme', () => {
    // body.modern-ui .MuiPaper-root has enough specificity to beat a two-class
    // selector and turn portaled v2 popovers dark. Keep the compound Paper
    // selector that won the real-browser specificity check.
    const rule = ruleBody(v2, '.v2-root .v2-feedback-menu__popover.MuiPaper-root');
    expect(rule).toContain('background: var(--v2-surface)');
    expect(rule).toContain('border: 1px solid var(--v2-border)');
  });

  test('the first-run modal stays within the mobile viewport', () => {
    // First-run is shell-level now: the overlay must own the viewport and the
    // dialog must cap both axes so the last step and dismissal stay reachable
    // at 390x844 instead of overflowing behind the fixed shell.
    expect(ruleBody(v2, '.v2-first-run__overlay')).toContain('position: fixed');
    expect(ruleBody(v2, '.v2-first-run')).toContain('width: min(720px, 100%)');
    expect(ruleBody(v2, '.v2-first-run')).toContain('max-height: calc(100dvh - 48px)');
    expect(ruleBody(v2, '.v2-first-run')).toContain('overflow-y: auto');
  });

  test('the first-run setup CTA beats the global inherited anchor color with ink', () => {
    // `.v2-root a { color: inherit }` outranks a bare class selector. The
    // first browser pass rendered inherited text on the filled CTA until this
    // compound selector matched/exceeded the reset specificity.
    const rule = ruleBody(
      v2,
      '.v2-root a.v2-first-run__setup,\n.v2-root button.v2-first-run__hello',
    );
    expect(rule).toContain('background: var(--v2-ink)');
    expect(rule).toContain('color: var(--v2-on-ink)');
  });

  test('Settings is the one home for the folded self-profile and device routes', () => {
    // Structural guard: route retirement is an absence property, so executing
    // a happy path cannot prove the old page stops being reachable. The
    // positive controls below pin both the new destination and the public
    // profile route that must remain available.
    expect(settingsPage).toContain('<SettingsSection id="account" title="Account">');
    // D215 (TASK-688): Plan, Devices, API token and Connectors are rows in Account / Access.
    expect(settingsPage).toContain('<SettingsSection id="access" title="Access">');
    // D215: the language segment lives under Look, beside the theme.
    expect(settingsPage).toContain('<SettingsSection id="look" title="Look">');
    expect(settingsPage).toContain('className="v2-settings__avatar"');
    expect(settingsPage).toContain('src={currentUser?.profilePicture || undefined}');
    expect(settingsPage).toContain('kind="human"');
    expect(settingsPage).toContain('<AppsManagement variant="settings" showIntegrations={false} />');
    expect(settingsPage).toContain('to="/v2/connectors"');
    expect(settingsPage).toContain('<summary>Developer apps</summary>');
    expect(settingsPage).toContain('<V2BillingPanel />');
    expect(settingsPage).toContain('<V2DevicesPanel showHeading={false} asFold />');
    expect(ruleBody(ss, '.v2-settings__avatar')).toContain('width: 44px');
    expect(ruleBody(ss, '.v2-settings__avatar')).toContain('border-radius: var(--v2-radius-sm)');
    expect(ruleBody(ss, '.v2-settings__avatar img')).toContain('border-radius: var(--v2-radius-sm)');
    expect(avatar).toContain("borderRadius: 'inherit'");
    expect(v2App).toMatch(/path="settings\/devices"\s+element=\{<Navigate to="\/v2\/settings" replace \/>\}/);
    expect(v2App).toMatch(/path="profile"\s+element=\{<Navigate to="\/v2\/settings" replace \/>\}/);
    expect(v2App).toContain('path="profile/:id"');
    expect(v2App).toContain('<UserProfile />');
    expect(app).toContain('<Route path="/settings/devices" element={<Navigate to="/v2/settings" replace />} />');
  });

  test('Settings errors never sit inside the value column the phone hides', () => {
    const devicesPanel = read('../components/V2DevicesPanel.tsx');
    // billing error is its own line under the row, not a child of .vl
    expect(billingPanel).toMatch(/<\/span>\s*\{error && <span className="v2-settings__error v2-settings__error--row"/);
    expect(billingPanel).not.toMatch(/<span className="vl">[^]*v2-settings__error[^]*<\/span>\s*<span className="ac">/);
    expect(ruleBody(ss, '.v2-settings__error--row')).toContain('grid-column: 1 / -1');
    // devices: a load failure keeps its summary visible at 390
    expect(devicesPanel).toContain("'vl v2-settings__vl--error'");
    expect(ss).toMatch(/\.v2-settings \.v2p-disc > summary \.v2-settings__vl--error \{ display: flex/);
  });

  test('Settings is one screen: grouped cards, no jump nav', () => {
    expect(settingsPage).not.toContain('v2-settings__nav');
    expect(ruleBody(ss, '.v2-settings__content')).toContain('width: min(100%, 760px)');
    expect(ruleBody(ss, '.v2-settings__edit--closed')).toContain('display: none');
  });

  test('Settings saves a display name while allowing handle changes and exposing the email change affordance', () => {
    expect(settingsPage).toContain('className="v2-settings__account-fields"');
    expect(settingsPage).toContain('await updateProfile({ displayName: nextName });');
    // TASK-295 intentionally makes the handle editable. The previous handle
    // remains reserved and historical-only, so this control must stay separate
    // from the display-name save and expose its own rename action.
    expect(settingsPage).toContain('id="v2-settings-username"');
    expect(settingsPage).toContain('value={username}');
    expect(settingsPage).toContain('className="v2-settings__email-control"');
    expect(settingsPage).toContain('id="v2-settings-email" type="email" value={email} onChange={(event) => setEmail(event.target.value)}');
    expect(settingsPage).toContain('type="button">Change</button>');
    expect(settingsPage).not.toContain('Email changes go through re-verification; ask us for now.');
    expect(settingsPage).not.toContain('v2-settings__nav-note');
    expect(ruleBody(ss, '.v2-settings__account-fields')).toContain('grid-template-columns: repeat(2, minmax(0, 1fr))');
    expect(ruleBody(ss, '.v2-settings__account-fields > label')).toContain('align-content: start');
    expect(ruleBody(ss, '.v2-settings__account-fields > .v2-settings__account-email')).toContain('grid-column: 1 / -1');
    expect(ruleBody(ss, '.v2-settings__account-fields input')).toContain('border-radius: var(--v2-radius-sm)');
    expect(ruleBody(ss, '.v2-settings__email-control')).toContain('display: flex');
    const accountForm = ruleBody(ss, '.v2-settings form.v2-settings__account');
    expect(accountForm).toContain('padding: 0');
    expect(accountForm).toContain('background: transparent');
    expect(accountForm).toContain('box-shadow: none');
  });

  test('Settings avatar controls keep the account face square and the crop step usable on phones', () => {
    const avatar = ruleBody(ss, '.v2-settings__avatar');
    expect(avatar).toContain('width: 44px');
    expect(avatar).toContain('height: 44px');
    expect(avatar).toContain('border-radius: var(--v2-radius-sm)');
    expect(ruleBody(ss, '.v2-settings__avatar-overlay')).toContain('background: rgba(16, 24, 40, 0.55)');
    expect(avatarCropDialog).toContain('className="v2-root v2-modal__overlay v2-settings__avatar-overlay"');
    expect(avatarCropDialog).toContain('className="v2-modal v2-settings__avatar-dialog"');
    expect(ruleBody(ss, '.v2-settings__avatar-crop-stage')).toContain('aspect-ratio: 392 / 260');
    expect(ruleBody(ss, '.v2-settings__avatar-crop-frame')).toContain('border: 1px solid var(--v2-surface)');
    expect(ruleBody(ss, '.v2-settings__avatar-crop-dim span')).toContain('background: rgba(16, 24, 40, 0.55)');
    expect(ruleBody(ss, '.v2-root .v2-settings__avatar-zoom input[type="range"]::-webkit-slider-thumb')).toContain('width: 16px');
    expect(ruleBody(ss, '.v2-root .v2-settings__avatar-dialog-actions button')).toContain('min-width: 112px');
    const phone = blockContaining(ss, '@media (max-width: 680px)', '.v2-settings__avatar-actions');
    expect(ruleBody(phone, '.v2-settings__avatar-actions', { within: phone })).toContain('grid-template-columns: repeat(2, minmax(0, 1fr))');
    expect(ruleBody(phone, '.v2-settings__avatar-actions .v2p-b', { within: phone })).toContain('min-height: 44px');
    expect(ruleBody(phone, '.v2-settings__avatar-footer', { within: phone })).toContain('flex-direction: column');
    expect(ruleBody(phone, '.v2-root .v2-settings__avatar-dialog-actions button', { within: phone })).toContain('min-height: 44px');

    const modalPhone = blockContaining(v2, '@media (max-width: 480px)', '.v2-modal__overlay');
    expect(ruleBody(modalPhone, '.v2-modal__overlay', { within: modalPhone })).toContain('padding: 12px');
  });

  test('App.css keeps every V1 element selector out of the v2 canvas', () => {
    // This catches both a new `select { ... }` rule and a comma-list escape
    // such as `textarea, form { ... }`, neither of which a named allowlist
    // would see. The original dark form, blue button, and focus-ring leaks
    // were all this same selector-shape failure.
    expect(bareElementSelectors(appStyles)).toEqual([]);
    expect(bareElementSelectors('select { color: red; }')).toEqual(['select']);
    expect(bareElementSelectors('textarea, form { color: red; }')).toEqual(['textarea', 'form']);
  });

  test('Settings renders the account’s real plan with its appropriate billing action', () => {
    expect(billingPanel).toContain('currentUser?.entitlements');
    expect(billingPanel).toContain("isPro ? '/api/billing/portal' : '/api/billing/checkout'");
    expect(billingPanel).toContain("t(isPro ? 'billing.tier.pro' : 'billing.tier.free')");
    expect(billingPanel).toContain("t(isPro ? 'billing.manage' : 'billing.upgrade')");
    expect(billingPanel).not.toContain('free in beta');
    expect(billingPanel).not.toContain('included during beta');
    // The frame reads the plan as plain text in the row value, not a chip.
    expect(billingPanel).toContain('<span className="v2-settings__plan">');
    expect(billingPanel).not.toContain('v2-billing__badge');
  });

  test('Settings flattens connected apps and folds Developer Tips under the form', () => {
    expect(appsManagement).toContain("const isSettingsVariant = variant === 'settings'");
    expect(appsManagement).toContain('{!isSettingsVariant && <WebhookIcon color="primary" />}');
    expect(appsManagement).toContain('{!isSettingsVariant && <SettingsIcon color="primary" />}');
    expect(appsManagement).toContain('className="apps-management__developer-tips"');
    expect(appsManagement).toContain('{!isSettingsVariant && (');
    expect(appsManagement).toContain('? <Box className={className}>{children}</Box>');
    expect(ruleBody(ss, '.v2-settings .apps-management--settings .apps-management__section + .apps-management__section')).toContain('border-top: 1px solid var(--v2-border-soft)');
    expect(ruleBody(ss, '.v2-settings .apps-management--settings .apps-management__integration')).toContain('border: 1px solid var(--v2-border)');
  });

  test('mention treatment is a tight chip on the handle, never a row wash or rail', () => {
    // Accent rails made otherwise ordinary cards look like generic callouts.
    // Message rows retain a neutral semantic wash, while quote edges stay
    // neutral structural affordances.
    expect(v2).not.toMatch(/border-left:\s*[^;]*var\(--v2-accent\)/);
    expect(ruleBody(v2, '.v2-msg--mention')).toContain('background: none');
    const chip = ruleBody(v2, '.v2-msg__mention');
    expect(chip).toContain('background: color-mix(in srgb, var(--v2-accent) 10%, transparent)');
    expect(chip).toContain('padding: 0 4px');
  });

  test('quote edges share the same neutral 3px structural weight', () => {
    expect(ruleBody(v2, '.v2-msg__content blockquote')).toContain('border-left: 3px solid var(--v2-border)');
    expect(ruleBody(v2, '.v2-msg__quote')).toContain('border-left: 3px solid var(--v2-border)');
  });

  test('the workspace inspector working dot is cobalt and uses the semantic pulse timing', () => {
    const pulse = ruleBody(v2, '.v2-workspace-inspector__state--working');
    expect(pulse).toContain('background: var(--v2-accent)');
    expect(pulse).toContain('animation: v2-pulse var(--motion-pulse) var(--motion-ease-state) infinite');
  });

  test('v2 focus treatment reuses the shared focus-ring token', () => {
    expect(ruleBody(boardCss, '.v2-board__field input:focus')).toContain('box-shadow: var(--v2-focus-ring)');
  });

  test('board cards scroll intact and titles stay scannable in full columns', () => {
    // The column body is a grid of max-content rows (S4: the d215 .cbody), so a
    // full column scrolls instead of crushing its cards; the empty note keeps
    // its flex-shrink guard from the flex era.
    expect(ruleBody(boardCss, '.v2-feature--board .v2-board__col-body')).toContain('grid-auto-rows: max-content');
    expect(ruleBody(boardCss, '.v2-board__col-empty')).toContain('flex-shrink: 0');

    // The frame's .tt: two lines, then an ellipsis.
    const title = ruleBody(boardCss, '.v2-feature--board .v2-board__card-title');
    expect(title).toContain('display: -webkit-box');
    expect(title).toContain('-webkit-line-clamp: 2');
    expect(title).toContain('-webkit-box-orient: vertical');
    expect(title).toContain('overflow: hidden');
  });

  test('a board claim lease is the frame\'s accent mono timer on the id row (D215 .lease)', () => {
    expect(podBoard).toContain('className="v2-board__owner-line"');
    expect(ruleBody(boardCss, '.v2-feature--board .v2-board__card-kicker')).toContain('var(--v2-font-mono)');
    expect(ruleBody(boardCss, '.v2-feature--board .v2-board__owner-line')).toContain('color: var(--v2-accent-text)');
  });

  test('board card actions are the frame\'s 24px icon keys in a popover bar (D215 .hv)', () => {
    // Icon-only, so each key carries its old visible text as aria-label and title.
    expect(podBoard).toContain('aria-label={t(move.labelKey)}');
    expect(podBoard).toContain('title={t(move.labelKey)}');
    const key = ruleBody(boardCss, '.v2-feature--board .v2-board__card-actions .v2-board__key--icon');
    expect(key).toContain('width: 24px');
    expect(key).toContain('height: 24px');
    expect(ruleBody(boardCss, '.v2-feature--board .v2-board__card-actions')).toContain('box-shadow: var(--v2-shadow-pop)');
  });

  test('UI-STRUCT B3 uses ink for primary actions and mono counts without pills', () => {
    // S4: New task is the frame's ink key (.b-p), the fill gradient.
    expect(podBoard).toContain('v2-board__new v2-board__key v2-board__key--ink');
    const boardNew = ruleBody(boardCss, '.v2-feature--board .v2-board__key--ink');
    expect(boardNew).toContain('background: linear-gradient(180deg, var(--v2-fill-a), var(--v2-fill-b))');
    expect(boardNew).toContain('color: var(--v2-on-fill)');

    const columnCount = ruleBody(boardCss, '.v2-feature--board .v2-board__col-count');
    expect(columnCount).toContain('var(--v2-font-mono)');
    expect(columnCount).not.toContain('background:');
    expect(columnCount).not.toContain('border-radius:');
    expect(columnCount).not.toContain('padding:');

    // R05: Connect's primary act is the frame's ink key, the fill gradient
    // (--v2-fill-*) with on-fill text, the same key as BYO's submit.
    const connectCta = lastRuleBody(connectCss, '.v2-connect .v2-connect__cta');
    expect(connectCta).toContain('background: linear-gradient(180deg, var(--v2-fill-a), var(--v2-fill-b))');
    expect(connectCta).toContain('color: var(--v2-on-fill)');
  });

  test('the board craft-pass buttons use icon components instead of unicode glyphs', () => {
    // This is structural: accessible labels cannot prove a literal glyph has
    // left the JSX. The MUI imports and icon nodes are the implementation
    // contract for the two ruled board buttons.
    expect(podBoard).toContain("import AddIcon from '@mui/icons-material/Add'");
    expect(podBoard).toContain("import ArrowBackIcon from '@mui/icons-material/ArrowBack'");
    expect(podBoard).toContain('<ArrowBackIcon fontSize="small" aria-hidden="true" />');
    expect(podBoard).toContain('<AddIcon fontSize="small" aria-hidden="true" />');
    expect(podBoard).not.toContain('← {t(\'board.backToChat\')}');
    expect(podBoard).not.toContain('+ {t(\'board.newTask\')}');
  });

  test('the composer is one line with a 32px plus menu and a 32px ink Send, disabled until there is text (D215, TASK-734)', () => {
    expect(lastRuleBody(v2, '.v2-composer__row')).toContain('min-height: 52px');
    expect(ruleBody(v2, '.v2-composer')).toContain('border-radius: var(--v2-r-14, 14px)');
    // D223: plus and Send are the primitives' 32px ghost and primary icon keys,
    // which only draw because the shell loads primitives.css after v2.css.
    expect(read('../V2App.tsx')).toMatch(/import '\.\/v2\.css';\n[^\n]*\nimport '\.\/primitives\/primitives\.css';/);
    expect(composer).toContain('className="v2p-b v2p-b-g v2p-ib v2-composer__plus"');
    // The ghost hover has no :disabled guard, so the uploading plus restates rest.
    expect(ruleBody(v2, '.v2-root button.v2-composer__plus:disabled:hover')).toContain('background: transparent');
    expect(ruleBody(primitives, '.v2p-ib')).toContain('border-radius: var(--v2-r-8)');
    // The menu opens above the 32px plus, not over it.
    expect(ruleBody(v2, '.v2-composer__menu')).toContain('bottom: 40px');
    expect(lastRuleBody(v2, '.v2-root .v2-composer__field > textarea')).toContain('max-height: 112px');
    expect(lastRuleBody(v2, '.v2-root .v2-composer__field > textarea')).toContain('resize: none');
    expect(composer).toContain('className="v2p-b v2p-b-p v2p-ib v2-composer__send"');
    expect(ruleBody(primitives, '.v2p-b-p')).toContain('background: linear-gradient(180deg, var(--v2-fill-a), var(--v2-fill-b))');
    // A bespoke look on Send would outrank the primitive (0,2,1 over 0,1,0).
    expect(lastRuleBody(v2, '.v2-root button.v2-composer__send')).not.toContain('background');
    // S3c: Send is drawn at rest (D215) and disabled while the draft is empty;
    // only an in-flight send takes the dimmed progress look.
    expect(composer).toContain('disabled={sending || !hasText}');
    expect(composer).not.toContain('{hasText && (');
    expect(ruleBody(v2, '.v2-root .v2-composer--typing button.v2-composer__send:disabled')).toContain('opacity: 0.6');
    expect(ruleBody(v2, '.v2-root button.v2-composer__send:disabled')).not.toContain('opacity');
    // Ruling 7: the placeholder reads at 4.97:1 (dark 5.77:1), not --ph's 2.58:1.
    expect(ruleBody(v2, '.v2-root .v2-composer__field > textarea::placeholder')).toContain('var(--v2-text-muted)');
    expect(composer).toContain("role=\"menu\"");
    expect(composer).not.toContain('postsAs');
    expect(v2).not.toContain('.v2-composer__posts-as');
  });

  test('attachments: 156×104 thumbnails with a lightbox, text-badge chips, code collapsed past six lines', () => {
    expect(ruleBody(v2, '.v2-root button.v2-msg__thumb')).toContain('width: 156px');
    expect(ruleBody(v2, '.v2-root button.v2-msg__thumb')).toContain('height: 104px');
    expect(ruleBody(v2, '.v2-msg__chip-ext')).toContain('background: var(--v2-surface-tint)');
    expect(ruleBody(v2, '.v2-msg__chip-ext')).not.toContain('#');
    expect(v2).toContain('.v2-msg__collapse--closed pre');
    expect(ruleBody(v2, '.v2-lightbox')).toContain('rgba(16, 24, 40, 0.9)');
    expect(messageRow).not.toContain('FILE_EXT_COLORS');
    expect(messageRow).toContain('COLLAPSE_AFTER_LINES = 6');
    expect(messageRow).toContain('<V2Lightbox');
  });

  test('threading restyle (PR 2b): runtime tag, 20px reaction chips, two-line quote, thread chip, band, strip, white jump pill', () => {
    // D215: the runtime is plain mono joined to the time, "claude · 1:16 AM".
    expect(ruleBody(v2, '.v2-msg__tag')).toContain('font: 500 11.5px/16px var(--v2-font-mono)');
    expect(ruleBody(v2, '.v2-msg__tag')).not.toContain('background');
    expect(ruleBody(v2, '.v2-msg__tag + .v2-msg__time::before')).toContain("content: '· '");
    expect(ruleBody(v2, '.v2-thread .v2-msg__reaction')).toContain('height: 20px');
    expect(ruleBody(v2, '.v2-thread .v2-msg__quote')).toContain('border-left: 2px solid var(--v2-border)');
    expect(ruleBody(v2, '.v2-thread .v2-msg__quote-text')).toContain('-webkit-line-clamp: 2');
    expect(ruleBody(v2, '.v2-root .v2-thread button.v2-msg__thread-chip')).toContain('min-height: 28px');
    // S3b (#3178 / TASK-745): no band behind the root; the replies are the
    // D215 .thr card, with no rail.
    expect(v2).not.toContain('.v2-thread-block--open {');
    const thr = ruleBody(v2, '.v2-thread .v2-thread-replies');
    expect(thr).toContain('background: var(--v2-bg-subtle)');
    expect(thr).toContain('box-shadow: inset 0 0 0 1px var(--v2-border-soft)');
    expect(thr).toContain('border-radius: 10px');
    expect(thr).not.toContain('border-left');
    // S3a: the strip is the D215 .acts pop card (r9, 2px in, pop shadow).
    expect(ruleBody(v2, '.v2-thread .v2-msg__strip')).toContain('border-radius: 9px');
    expect(ruleBody(v2, '.v2-thread .v2-msg__strip')).toContain('box-shadow: var(--v2-shadow-pop)');
    expect(ruleBody(v2, '.v2-thread .v2-msg__strip')).toContain('padding: 2px');
    expect(ruleBody(v2, '.v2-root .v2-thread button.v2-msg__action')).toContain('width: 28px; height: 28px');
    expect(ruleBody(v2, '.v2-thread .v2-avatar--flat')).toContain('font: 650 12px/1 var(--v2-font)');
    expect(ruleBody(v2, '.v2-thread .v2-thread-replies .v2-msg .v2-avatar')).toContain('font-size: 12px');
    expect(ruleBody(v2, '.v2-thread .v2-thread-card__faces .v2-avatar')).toContain('font: 650 11px/1 var(--v2-font-mono)');
    expect(ruleBody(v2, '.v2-thread .v2-thread-card__faces .v2-avatar--flat')).toContain('font: 650 11px/1 var(--v2-font-mono)');
    expect(mediaBlockContaining(v2, '.v2-root .v2-thread button.v2-msg__action::after'))
      .toContain('.v2-root .v2-thread button.v2-msg__action { position: relative; width: 28px; height: 28px; }');
    expect(lastRuleBody(v2, '.v2-root button.v2-thread__jump')).toContain('border: 1px solid #dde0e6');
    expect(lastRuleBody(v2, '.v2-root button.v2-thread__jump')).toContain('border-radius: 14px');
    expect(messageRow).toContain('v2-msg__tag');
    expect(messageRow).toContain('MAX_REACTION_CHIPS = 6');
    expect(threadMessages).toContain('MAX_EXPANDED_REPLIES = 8');
    expect(threadMessages).toContain('v2-thread-replies__foot');
    // The revealed strip must be pinned to the body column: the row is a
    // 38px | 1fr grid and auto-placement would drop the body into the avatar
    // column (390 walk, one word per line).
    const revealed = ruleBody(v2, '.v2-thread .v2-msg--reveal .v2-msg__strip');
    expect(revealed).toContain('grid-column: 2');
    expect(revealed).toContain('grid-row: 2');
    // The reveal is gated on capability, so its placement is too — and the
    // query must MATCH `matchMedia('(hover: none)')` exactly: a comma'd
    // `(pointer: coarse)` or width term styles machines where the reveal never
    // fires (sprint-review 64468 + 64485). It must also come after the strip
    // rules it overrides, since they win on order at equal specificity.
    const strip = v2.indexOf('.v2-thread .v2-msg__strip {');
    const capability = v2.indexOf('@media (hover: none) {', strip);
    expect(capability).toBeGreaterThan(strip);
    expect(v2.slice(capability, capability + 600)).toContain('.v2-thread .v2-msg--reveal .v2-msg__strip');
    // ux-lead 64476: root inside the band at the text column; chip-only rest state;
    // mention wash; flat two-tone transcript avatars.
    expect(threadMessages).toContain('v2-thread-block__inner');
    expect(threadMessages).toContain('const collapsed = !openRoots.has(item.rootId)');
    expect(v2).not.toContain('.v2-thread-card__reply');
    // Thread mentions use the one chip rule; a 0,2,0 override here once beat it (D224).
    expect(v2).not.toContain('.v2-thread .v2-msg__mention');
    expect(ruleBody(v2, '.v2-thread .v2-avatar--flat-agent')).toContain('var(--v2-accent)');
    expect(ruleBody(v2, '.v2-thread .v2-avatar--flat-human')).toContain('background: #f2f4f7');
  });

  test('Your Team (direction C): three-column card grid, state-coloured marks, cobalt ring for needs-you, ink Hire, no green, old tiers gone', () => {
    const grid = ruleBody(teamCss, '.v2-team .v2-team__grid');
    expect(grid).toContain('grid-template-columns: repeat(3, minmax(0, 1fr))');
    expect(grid).toContain('gap: 12px');
    expect(ruleBody(teamCss, '.v2-team .v2-team-card--needsYou')).toContain('border: 2px solid var(--v2-accent)');
    expect(ruleBody(teamCss, '.v2-team .v2-team-card__mark--needsYou')).toContain('var(--v2-accent)');
    expect(ruleBody(teamCss, '.v2-team .v2-team-card__mark--working')).toContain('var(--v2-text-primary)');
    expect(ruleBody(teamCss, '.v2-team .v2-team-card__mark--idle')).toContain('var(--v2-border-soft)');
    // R06: Hire and Answer share the frame's ink key, the fill gradient
    // (--v2-fill-*) with on-fill text, the same key as BYO's submit and
    // Connect's CTA; Talk (and Bring your own) is the bordered plain key.
    const ink = selectorRuleBody(teamCss, '\n.v2-team .v2-team__hire, .v2-team .v2-team-card__answer {');
    expect(ink).toContain('background: linear-gradient(180deg, var(--v2-fill-a), var(--v2-fill-b))');
    expect(ink).toContain('color: var(--v2-on-fill)');
    const plain = selectorRuleBody(teamCss, '\n.v2-team .v2-team__byo, .v2-team .v2-team-card__talk {');
    expect(plain).toContain('border: 1px solid var(--v2-key-edge)');
    expect(plain).not.toContain('var(--v2-fill-');
    expect(ruleBody(teamCss, '.v2-team .v2-team-card__status')).toContain('var(--v2-font-mono)');
    // ux-lead 66246: the ask wraps, the command wraps at mono 14, the name is display-18,
    // the mark is 600, and the title stacks over its meta on a phone.
    expect(ruleBody(teamCss, '.v2-team .v2-team-card__status--needsYou')).toContain('white-space: normal');
    expect(ruleBody(teamCss, '.v2-team .v2-team-card__command')).toContain('white-space: pre-wrap');
    expect(ruleBody(teamCss, '.v2-team .v2-team-card__command')).toContain('14px/20px');
    expect(ruleBody(teamCss, '.v2-team .v2-team-card__name')).toContain('font: 700 18px/1.2 var(--v2-font-display)');
    expect(ruleBody(teamCss, '.v2-team .v2-team-card__mark')).toContain('font: 600 12px/1');
    const teamAvatar = ruleBody(teamCss, '.v2-team .v2-team-card__mark .v2-avatar');
    expect(teamAvatar).toContain('width: 100%');
    expect(teamAvatar).toContain('height: 100%');
    expect(teamAvatar).toContain('border-radius: inherit');
    // Read the rule inside the team's phone block — a `[\s\S]*?` regex across
    // the sheet passed with the rule deleted (sprint-review at 58fb4147).
    const teamPhone = teamPhoneBlock(teamCss);
    expect(ruleBody(teamCss, '.v2-team .v2-team__heading', { within: teamPhone })).toContain('flex-direction: column');
    expect(ruleBody(teamCss, '.v2-team .v2-team__grid', { within: teamPhone })).toContain('repeat(1, minmax(0, 1fr))');
    // The retired surfaces: feature rows, standard cards with icon buttons, quiet rows, green dot.
    for (const css of [v2, teamCss]) {
      expect(css).not.toContain('.v2-team-feature ');
      expect(css).not.toContain('.v2-team-quiet');
      expect(css).not.toContain('v2-team-feature__dot');
    }
    expect(teamCss).toMatch(/@media \(max-width: 760px\)[\s\S]*?\.v2-team__grid \{[\s\S]*?repeat\(1, minmax\(0, 1fr\)\)/);
  });

  test('history: a mono edge line that loads on scroll and a Jump-to-latest pill', () => {
    expect(threadMessages).toContain('v2-thread__edge');
    expect(threadMessages).not.toContain('v2-chat__older-btn');
    expect(thread).toContain('new IntersectionObserver');
    expect(thread).toContain('atBottomRef');
    // Background arrivals must respect the reader's position even when they
    // share the current user's author id. Arrival counting is separate from
    // the explicit follow instruction returned by this composer's send; the
    // follow-version nudge covers socket-before-POST ordering without letting
    // a confirmation render increment the Jump pill.
    expect(thread).toContain('sentMessageIdRef');
    expect(thread).toContain('sendFollowVersion');
    expect(thread).toContain('if (!sendFollowVersion || !sentMessageIdRef.current) return;');
    expect(thread).toContain('if (atBottomRef.current)');
    expect(thread).toContain('}, [newestMessageId]);');
    expect(thread).toContain('}, [sendFollowVersion]);');
    expect(thread).not.toContain('newestIsMine');
    // ux-lead gate on #1579: the pill is a 28px r14 white chip on #dde0e6, sans
    // 600 13px — the same family as the aim chip, not a 999px capsule.
    // The wrap sticks to the scroller's bottom edge with real height; the
    // pill centres by flow. An absolute pill inside a 0-height last child
    // sat ~1100px below the viewport (ux-lead gate on #1579). Rect
    // containment is a browser-tier check (setupTests stubs
    // getBoundingClientRect to zeros), so it lives in the walk, not here.
    const wrap = ruleBody(v2, '.v2-thread__jump-wrap');
    expect(wrap).toContain('position: sticky');
    expect(wrap).toContain('bottom: 12px');
    expect(wrap).not.toContain('height: 0');
    const jump = ruleBody(v2, '.v2-root button.v2-thread__jump');
    expect(jump).not.toContain('position: absolute');
    expect(jump).toContain('height: 28px');
    expect(jump).toContain('border-radius: 14px');
    expect(jump).toContain('border: 1px solid #dde0e6');
    expect(jump).toContain('font: 600 13px/26px var(--v2-font)');
    expect(lastRuleBody(v2, '.v2-thread__edge-line')).toContain('var(--v2-font-mono)');
  });

  test('managed history prepends disable native anchoring while idle media keeps native anchoring', () => {
    const history = ruleBody(v2, '.v2-chat__messages[data-history-anchor="active"]');
    expect(history).toContain('overflow-anchor: none');
    expect(ruleBody(v2, '.v2-chat__messages')).not.toContain('overflow-anchor');
    expect(thread).toContain('getBoundingClientRect');
    expect(thread).toContain('rowOffset');
    expect(thread).toContain("el.dataset.historyAnchor = 'active'");
    expect(thread).toContain('delete el.dataset.historyAnchor');
  });

  test('the pod list opts out of native anchoring, because the minute poll re-sorts it under the reader', () => {
    // ux-lead gate on #1989: with Everything open and scrolled, a message to a
    // pod in view moves that row to the top, native anchoring drags the list
    // ~14 rows and 4 of 17 rows stayed in view. Opting the scroller out holds
    // 16 of 17. Same property the chat transcript uses, for the opposite
    // reason — see the note on the declaration in v2.css.
    const list = lastRuleBody(v2, '.v2-pods__list');
    // The rule being reset must still exist, or a green here means nothing.
    expect(list).toContain('overflow-y: auto');
    expect(list).toContain('overflow-anchor: none');
    expect(podsSidebar).toContain('className="v2-pods__list"');
    // `.v2-pods__list` is declared twice (from #251 and #1578 "sidebar at
    // scale"), both top-level, so the LATER block wins every conflicting
    // declaration and is the effective rule — hence `lastRuleBody` here, which
    // reads it, rather than `ruleBody`, which reads the superseded one.
    //
    // Do NOT add `expect(list).not.toBe(ruleBody(...))` to pin that choice. It
    // cannot fail: `lastRuleBody` slices from the leading newline and `ruleBody`
    // from `lineStart + 1`, so the two differ by whitespace whatever the sheet
    // contains (measured — deleting the superseded block outright leaves this
    // suite 153/153 green). Trimming the compare to make it bite is worse: it
    // then reds on that very de-dup, which is harmless. The two `toContain`s
    // above are what carry the property, and they fail in both hazard
    // directions — declaration missing from the effective block, or the
    // effective block gone so this falls through to the old one.
  });

  test('history recovery is positioned against the chat viewport, outside the scroller', () => {
    const transcript = ruleBody(v2, '.v2-thread__transcript');
    expect(transcript).toContain('position: relative');
    expect(transcript).toContain('flex: 1');
    expect(transcript).toContain('min-height: 0');
    expect(thread).toContain('<div className="v2-thread__transcript">');
    expect(thread).toContain('<V2ThreadHistoryStatus');

    const status = ruleBody(v2, '.v2-thread__history-status--viewport');
    expect(status).toContain('position: absolute');
    expect(status).toContain('top: 8px');
    expect(status).toContain('left: 24px');
    expect(status).toContain('right: 24px');
    expect(status).toContain('pointer-events: none');
    expect(status).not.toContain('box-shadow');
  });

  test('the pod header is 64px: display 18/700 name, inline description, board chip and member faces (D215, TASK-734)', () => {
    // D215 brings the display face back to the pod title (walk-1 ruling (b)
    // had moved it to sans 15/600); the working count stays in the inspector.
    expect(podChat).toContain('className="v2-thread__header v2-pod-header"');
    expect(podChat).toContain('podChat.header.boardOpen');
    expect(podChat).toContain('v2-thread__inspector-toggle');
    expect(podChat).toContain('v2-pod-header__stack');
    expect(podChat).not.toContain('podChat.header.agentsWorking');
    expect(ruleBody(v2, '.v2-thread__header')).toContain('min-height: 64px');
    expect(ruleBody(v2, '.v2-thread__header')).toContain('border-bottom: 1px solid var(--v2-border-soft)');
    expect(ruleBody(v2, '.v2-thread__title h1')).toContain('font: 700 18px/24px var(--v2-font-display)');
    // Faces overlap by 6px on a 2px surface ring, the artboard's stack.
    expect(ruleBody(v2, '.v2-thread .v2-pod-header__stack .v2-avatar + .v2-avatar')).toContain('margin-left: -6px');
    expect(ruleBody(v2, '.v2-pod-header__meta')).toContain('font: 400 11px/16px var(--v2-font-mono)');
    // Both metas carry the base class; the compact one must out-rank the base
    // `display: flex` or 1440 shows two metas side by side (ux-lead, 2026-09-06).
    const baseMeta = v2.indexOf('.v2-pod-header__meta {');
    const compactMeta = v2.indexOf('.v2-pod-header__meta.v2-pod-header__meta--compact { display: none; }');
    expect(baseMeta).toBeGreaterThan(-1);
    expect(compactMeta).toBeGreaterThan(-1);
    expect(ruleBody(v2, '.v2-pod-header__meta')).toContain('display: flex');
    expect(compactMeta).toBeGreaterThan(baseMeta);
    // TASK-647 item 3: the phone line keeps the board link, with a 44px hit
    // area drawn as a pseudo-element so the 28px meta row does not grow.
    expect(ruleBody(v2, 'button.v2-pod-header__board--compact::before')).toContain('inset: -14px -6px');
    expect(ruleBody(v2, '.v2-thread__title-line > h1')).toContain('max-width: calc(100% - 36px)');
    expect(v2).not.toContain('.v2-thread__working');
  });

  test('the phone workspace is an edge-to-edge thread with a labelled tab bar carrying one count', () => {
    expect(v2).toContain('.v2-pane--rail { display: none; }');
    expect(v2).toContain('.v2-mobile-tabs__label');
    expect(mobileTabs).toContain('needsYouCount');
    expect(mobileTabs).toContain("path: '/v2/activity'");
    expect(mobileTabs).toContain("path: '/v2/settings'");
    expect(mobileTabs).not.toContain('onOpenInspector');
    expect(v2Layout).toContain('<V2MobileTabs');
  });

  test('workspace thread rows retain the artboard grammar at desktop and phone widths', () => {
    const title = ruleBody(v2, '.v2-thread__title h1');
    const avatarRule = ruleBody(v2, '.v2-thread .v2-avatar');
    const author = selectorRuleBody(v2, '.v2-thread .v2-msg__author');
    const time = ruleBody(v2, '.v2-thread .v2-msg__time');
    const actions = ruleBody(v2, '.v2-thread .v2-msg__strip');
    // D215 (TASK-734): display title, 36px faces at radius 9 on a 1px ring,
    // and the time in the 11.5 mono the runtime label shares.
    expect(title).toContain('var(--v2-font-display)');
    expect(avatarRule).toContain('width: 36px');
    expect(avatarRule).toContain('border-radius: var(--v2-r-9, 9px)');
    expect(avatarRule).toContain('border: 0');
    expect(avatarRule).toContain('box-shadow: 0 0 0 1px var(--v2-av-ring');
    expect(author).toContain('font-size: 14px');
    expect(author).toContain('font-weight: 600');
    expect(time).toContain('font: 500 11.5px/16px var(--v2-font-mono)');
    // S3a: the hover actions are the D215 .acts pop card.
    expect(actions).toContain('border-radius: 9px');
    expect(actions).toContain('box-shadow: var(--v2-shadow-pop)');
    // These scoped rules only take effect when the chat mounts the thread
    // surface class; without it the legacy 30px circular avatar rules win.
    expect(thread).toContain('className="v2-chat v2-thread"');

    const phoneStart = v2.lastIndexOf(
      '@media (max-width: 760px)',
      v2.lastIndexOf('/* The workspace is edge-to-edge on a phone'),
    );
    const phone = v2.slice(phoneStart);
    expect(phone).toContain('.v2-decision-card__options { align-items: stretch; flex-direction: column; }');
    expect(phone).toContain('.v2-root button.v2-decision-card__choice { width: 100%; min-height: 44px; font-size: 15px; }');
    expect(phone).toContain('.v2-root button.v2-thread__back');
    expect(phone).toContain('border: 1px solid var(--v2-border)');
  });

  test('the phone list page hides the rail and the desktop sidebar column, never both list and pod at once', () => {
    // The list is a route state, not an overlay: V2Layout returns early with
    // the page variant and no thread, so nothing can sit under an inert sheet.
    const listBranch = v2Layout.slice(
      v2Layout.indexOf('if (phone && !selectedPodId) {'),
      v2Layout.indexOf('// The inspector is a separate column'),
    );
    expect(listBranch).toContain('variant="page"');
    expect(listBranch).not.toContain('<V2Thread');
    expect(listBranch).not.toContain('<V2NavRail');
    expect(v2Layout).toContain('{!phone && (');
  });

  test('all phone shells collapse to the main track when the rail is hidden', () => {
    const phoneStart = v2.lastIndexOf(
      '@media (max-width: 760px)',
      v2.lastIndexOf('/* The workspace is edge-to-edge on a phone'),
    );
    const phone = v2.slice(phoneStart);
    expect(phone).toMatch(/\.v2-shell:not\(.v2-shell--feature-wide\),\s*\.v2-shell--feature-wide\s*\{[^}]*?grid-template-columns: minmax\(0, 1fr\);/);
    expect(phone).toContain('.v2-pane--rail { display: none; }');
  });

  test('Activity cards have shrinkable desktop and mobile layout guards', () => {
    // The recap is a feature-wide page, but it is still reachable at 390px.
    // The zero-min grid tracks are the load-bearing no-horizontal-overflow
    // rule; jsdom cannot observe the scrollbar they prevent.
    expect(ruleBody(v2, '.v2-activity__queue-row'))
      .toContain('28px minmax(0, 1fr) auto');
    expect(v2).toMatch(/@media \(max-width: 640px\)[\s\S]*?\.v2-activity__queue-row \{[\s\S]*?28px minmax\(0, 1fr\)/);
    // The agent grid and board rows this also pinned are gone from the page,
    // and their rules with them (TASK-758).
  });

  test('Activity queue actions distinguish an action from the thread handoff', () => {
    expect(ruleBody(v2, '.v2-root .v2-activity__queue-actions button')).toContain('background: var(--v2-ink)');
    expect(ruleBody(v2, '.v2-root .v2-activity__queue-actions button.v2-activity__queue-action--secondary')).toContain('background: var(--v2-surface-hover)');
    expect(ruleBody(v2, '.v2-root .v2-activity__queue-actions button.v2-activity__queue-action--thread')).toContain('background: transparent');
    const bordered = ruleBody(v2, '.v2-root .v2-activity__queue-actions button.v2-activity__queue-action--bordered');
    expect(bordered).toContain('border: 1px solid var(--v2-border)');
    expect(bordered).toContain('background: var(--v2-surface)');
  });

  test('DecisionRequest options remain 44px touch targets when they wrap at 390px', () => {
    // Options are agent-authored data, not compact task metadata. Keep the
    // primary state and the free-text escape hatch visible in the CSS
    // source because jsdom has no layout engine to catch a narrow regression.
    expect(ruleBody(v2, '.v2-root .v2-activity__queue-actions button.v2-activity__option--primary'))
      .toContain('background: var(--v2-accent)');
    expect(ruleBody(v2, '.v2-activity__decision-other')).toContain('flex-basis: 100%');
    expect(v2).toMatch(/@media \(max-width: 640px\)[\s\S]*?\.v2-root \.v2-activity__queue-actions button \{ min-height: 44px; \}/);
  });

  test('starter prompts wrap within the mobile chat pane', () => {
    // On the edge-to-edge phone thread, both the row and each chip need
    // explicit shrink/wrap rules or the longest prompt creates horizontal
    // overflow and pushes the composer action off-screen.
    const row = ruleBody(v2, '.v2-chat__starter-prompts');
    const chip = ruleBody(v2, '.v2-root button.v2-chat__starter-prompt');
    expect(row).toContain('flex-wrap: wrap');
    // Full pane width (rule 2 v5) while keeping the 390px shrink this pin
    // exists for.
    expect(row).toContain('max-width: 100%');
    expect(chip).toContain('max-width: 100%');
    expect(chip).toContain('white-space: normal');
  });

  test('the new-pod starter panel shrinks and stacks inside the mobile chat pane', () => {
    const panel = ruleBody(v2, '.v2-chat__new-pod');
    const actions = ruleBody(v2, '.v2-chat__new-pod-actions');
    const hosted = ruleBody(v2, '.v2-root button.v2-chat__new-pod-action--hosted');
    expect(panel).toContain('width: min(760px, 100%)');
    expect(actions).toContain('repeat(3, minmax(0, 1fr))');
    expect(hosted).toContain('background: var(--v2-ink)');
    expect(v2).toContain('.v2-chat__new-pod-actions {\n    grid-template-columns: minmax(0, 1fr)');
  });

  test('invite management controls collapse to one column on phones', () => {
    // The modal is wider than the mobile shell and carries two selects plus a
    // URL/copy row. At <=480px both must wrap or the link input pushes the
    // Copy action beyond the viewport.
    expect(ruleBody(v2, '.v2-invite-options')).toContain('repeat(2, minmax(0, 1fr))');
    expect(v2).toContain('.v2-invite-options {\n    grid-template-columns: minmax(0, 1fr)');
    expect(v2).toContain('.v2-invite-link-row {\n    flex-wrap: wrap');
    expect(v2).toContain('.v2-root .v2-invite-link-row button.v2-invite-card__cta,');
  });

  test('landing trusted-by marquee cannot widen the page', () => {
    // The rolling logo track is INTENTIONALLY wider than the viewport (two
    // identical sets for a seamless loop). `overflow: hidden` on the marquee
    // wrapper is the load-bearing guard — without it the landing page grows
    // a horizontal scrollbar on every device (the mobile-overflow class).
    const marquee = ruleBody(landing, '.v2-landing__trusted-marquee');
    expect(marquee).toContain('overflow: hidden');
    // The track must scroll by exactly half its width (two identical sets),
    // or the loop visibly jumps.
    expect(landing).toContain('translateX(-50%)');
  });

  test('landing trusted-by marquee falls back to a static wrap under reduced motion', () => {
    // prefers-reduced-motion users get the old wrapping strip: animation off,
    // wrap on, duplicate set hidden (it exists only for the seamless loop).
    // Read from the fallback's OWN block, brace-matched: the base marquee rule is
    // above it, so a whole-sheet first-match reader returns that body instead.
    // Assert the scope is non-empty first — a
    // scope that can silently be empty reads as a pass everywhere it is used.
    const reduced = reducedMotionBlock(landing, '.v2-landing__trusted-track');
    expect(reduced).not.toBe('');
    expect(reduced).toContain('animation: none');
    expect(reduced).toContain(".v2-landing__trusted-set[aria-hidden='true']");
    // The SET has to be the element that wraps. `flex-wrap: wrap` on the TRACK
    // was the whole assertion here until row B, and it was green while 3 / 4 /
    // 7 / 8 of the 11 logos were clipped at 1440 / 1200 / 760 / 390: the track's
    // only visible child is one nowrap set, so the wrap has to be declared on
    // the child that overflows (ux-lead's #2019 non-blocking finding). Pinned by
    // the rule's OWN selector, because a substring check cannot say which
    // element carries the declaration — which is exactly how this stayed green.
    const wrapped = selectorRuleBody(reduced, '.v2-landing__trusted-marquee .v2-landing__trusted-set {');
    expect(wrapped).toContain('flex-wrap: wrap');
    expect(wrapped).toContain('justify-content: center');
    // ...and the track must NOT carry it. That declaration wrapped nothing (the
    // track's only visible child is one nowrap set) and it is what kept the old
    // substring pin green through the whole defect, so its absence is asserted
    // rather than assumed: re-introducing it is a revert of this fix. Qualified on
    // the DECLARATION, not the bare word: the rule's own comment says "flex-wrap"
    // while explaining why it is absent, and a substring pin on the word would
    // be tripped by the sentence that documents it.
    const track = selectorRuleBody(reduced, '.v2-landing__trusted-track {');
    expect(track).not.toMatch(/flex-wrap\s*:/);
    // The mask would eat the first logo at 390, where its fade is 31px wide.
    // Both declarations are pinned LINE-ANCHORED, because `'mask-image: none'` is
    // a substring of `-webkit-mask-image: none;` — the arm that deletes the
    // unprefixed line came back green until this was qualified, which is the same
    // defect class as the pin above, one declaration over.
    const maskOff = selectorRuleBody(reduced, '.v2-landing__trusted-marquee {');
    expect(maskOff).toMatch(/^\s*mask-image:\s*none;/m);
    expect(maskOff).toMatch(/^\s*-webkit-mask-image:\s*none;/m);
  });

  test('landing trusted-by logos render as one grey ink, on hover too', () => {
    // OROZ ships white artwork and Fluxr a white wordmark. `grayscale(1)`
    // alone left both white on the light strip — present in the DOM, invisible
    // on the page. `brightness(0)` maps every opaque pixel to black, so each
    // logo reads as its silhouette and the opacity sets the grey. Measured in a
    // real browser at 1440 and 390: all 24 logos non-blank.
    const logo = selectorRuleBody(landing, '.v2-landing__trusted-logo {');
    expect(logo).toMatch(/filter:\s*grayscale\(1\)\s+brightness\(0\)\s*;/);
    expect(logo).toMatch(/opacity:\s*0\.6\s*;/);
    // Hover lifts the opacity only. Restoring the source colours on hover
    // (`grayscale(0)`, the old rule) makes the white files vanish under the
    // pointer.
    const hover = selectorRuleBody(landing, '.v2-landing__trusted-logo:hover {');
    expect(hover).toMatch(/opacity:\s*1\s*;/);
    expect(hover).not.toMatch(/filter\s*:/);
  });

  test('landing adapter code scrolls inside its card instead of widening the page', () => {
    // Preformatted adapter commands have a wide min-content size. Without a
    // zero-width grid minimum + shrinkable card, the mobile landing page grows
    // wider than the viewport even though the <pre> itself scrolls.
    expect(ruleBody(landing, '.v2-landing__adapters')).toContain('minmax(0, 1fr)');
    expect(ruleBody(landing, '.v2-landing__adapter')).toContain('min-width: 0');
  });

  test('the zh hero title suffix cannot be split across lines', () => {
    // TASK-211. The zh hero reads 「与你的___对话」: the rotator swaps the object
    // and 对话 trails it. At 390px with the "Claude Code" term the suffix
    // straddled the wrap — the h1's content box ran 24 → 366, 对 fitted
    // (348.5), and 话 is 44.3px wide and would have ended 26.8px past the edge,
    // so 话 sat alone on line 3 (measured live; at 320 the 整个团队 term did the
    // same). `white-space: nowrap` is what produces the measured fix, so that is
    // what is pinned here — jsdom has no line boxes, and the browser is the gate.
    // The companion assertion that the suffix is rendered as its own element
    // (so this rule has something to bind to) lives in
    // landingHeroContent.test.tsx; a declaration pin alone would survive the
    // suffix being inlined as bare text.
    expect(ruleBody(landing, '.v2-landing__title-suffix')).toContain('white-space: nowrap');
  });

  test('the zh hero suffix takes its own line on a phone', () => {
    // TASK-213. Even with the suffix unbreakable (the test above), the zh h1
    // gains a line whenever a term is long enough to push 对话 onto a third
    // line: at 320–414 it measures 94.6px under three terms and 140.6px under
    // the fourth, so the lede, the CTAs and everything below move 46px once per
    // rotation cycle. Option 1 was chosen: the suffix
    // is a block at ≤680, which makes the height the same under every term.
    // Scoped with `mediaAt` rather than a whole-sheet read or an `indexOf`: the
    // sheet has one (max-width: 680px) block today, and the helper is what makes
    // a later one unable to satisfy this assertion by accident — `mediaAt`
    // returns '' when the at-rule is absent, so a dropped block reds rather than
    // silently matching some other rule. The declaration pin binds to the
    // browser gate in ux-lead's sweep; `margin-left: 0` is asserted separately
    // from `display: block` because it is what puts 对 on the column's left
    // edge (the base rule's .18em indent would otherwise move with it).
    const phone = mediaAt(landing, '@media (max-width: 680px) {');
    expect(phone).not.toBe('');
    expect(selectorRuleBody(phone, '.v2-landing__title-suffix')).toContain('display: block');
    expect(selectorRuleBody(phone, '.v2-landing__title-suffix')).toContain('margin-left: 0');
  });

  test('the phone hero rotator wraps and balances, and zh terms break only at the ZWSP', () => {
    // CodeRabbit (Minor) on #2883: presence pins for the ≤760 rotator rules. jsdom
    // has no line boxes, so these only guard against the declarations being dropped.
    // The block is placed last in the sheet and wins by order over the ≤680 rules.
    expect(landing).toContain('.v2-landing__rotator { max-width: 100%; text-wrap: balance; }');
    // The sizer stacks every term in one grid cell, so the h1 holds one height
    // without a min-height reservation.
    expect(landing).toContain('.v2-landing__rotator-sizer {\n  display: grid;');
    expect(landing).toContain('.v2-landing__rotator-sizer > span {\n  grid-area: 1 / 1;');
    expect(landing).not.toContain('min-height: calc(72px + 0.06em)');
    expect(landing).toContain('.v2-landing__rotator-term { white-space: normal; }');
    expect(landing).toMatch(/:lang\(zh\) \.v2-landing__rotator \{ word-break: keep-all; \}/);
  });

  test('the zh hero suffix takes its own line from 761 to 1359 px', () => {
    // UX-GATE HOLD on 18bf0ce9. Between 761 and 1339 px the zh suffix shared line
    // 2 with 队友的智能体 and wrapped for the other two terms, so the h1 changed
    // height on every rotation (173↔257 at 1200). The band sits between TASK-213's
    // phone rule (≤680) and the desktop title, so this is its own block. jsdom has
    // no line boxes; the pin binds to ux-lead's zh sweep at 761/900/1060/1200/1300/
    // 1359/1360, and `mediaAt` returns '' if the block is dropped.
    const band = mediaAt(landing, '@media (min-width: 761px) and (max-width: 1359px) {');
    expect(band).not.toBe('');
    expect(selectorRuleBody(band, '.v2-landing__title-suffix')).toContain('display: block');
    expect(selectorRuleBody(band, '.v2-landing__title-suffix')).toContain('margin-left: 0');
  });

  test('the hero option 1 suffix takes its own line at every width', () => {
    // Option 1 is "Bring / <term> / into one pod." Inline, the widest term pushed
    // the suffix to a third line at 1440 and the h1 jumped ~84px on that term
    // (measured 173 vs 257 on the 1440 sweep). The modifier class is set only for
    // option 1, so the rule is unconditional and sits after the base suffix rule.
    expect(landing).toContain('.v2-landing__title-suffix--own-line { display: block; margin-left: 0; }');
    expect(landing.indexOf('.v2-landing__title-suffix--own-line')).toBeGreaterThan(
      landing.indexOf('.v2-landing__title-suffix {'),
    );
  });

  test('reaction chips baseline-align emoji ink with the count (not box-centering)', () => {
    // align-items: center centers the spans' layout boxes, but Apple Color
    // Emoji ink extends below the baseline while digit ink does not, so the
    // count visibly rides high on desktop (2026-08-05, HQ screenshot).
    // Baseline alignment + a 22px emoji line box (chip inner height, which is
    // the only thing vertically centering the pair once baseline is on) is
    // the fix; both halves are load-bearing and invisible to jsdom.
    expect(ruleBody(v2, '.v2-root button.v2-msg__reaction')).toContain('align-items: baseline');
    expect(ruleBody(v2, '.v2-msg__reaction-emoji')).toContain('line-height: 22px');
  });

  test('message actions live in ONE hover cluster, and its picker opens downward', () => {
    // 2026-08-23 (placement rulings): Reply, Thread, and the reaction
    // trigger share a floating pill at the row's top-right — no inline head
    // buttons (layout shift), no orphaned "+" in an empty reactions band
    // (the 2026-08-13 phantom-band bug cannot recur because a chip-less row
    // no longer renders at all). The picker anchor override is load-bearing:
    // the base picker opens UPWARD (bottom: 100%) for the old in-row anchor;
    // from the cluster at the message's top edge it must open downward or it
    // clips under the previous message.
    const cluster = ruleBody(v2, '.v2-msg__actions');
    expect(cluster).toContain('position: absolute');
    expect(v2).toContain('.v2-msg:hover .v2-msg__actions');
    const pickerInCluster = ruleBody(v2, '.v2-msg__actions .v2-msg__reaction-picker');
    expect(pickerInCluster).toContain('top: calc(100% + 6px)');
    expect(pickerInCluster).toContain('bottom: auto');
    // Touch keeps the 44px floor with the cluster always visible.
    expect(v2).toContain('.v2-root button.v2-msg__action');
  });

  test('create-pod join choice uses radios, not the reset-prone option buttons', () => {
    // Join policy is now chosen at creation, but public visibility remains a
    // later act. The old option buttons lost to the global button reset (#870).
    expect(v2).not.toMatch(/\.v2-pods__create-option[^\n]*\{/);
    // S3c (D223): the pod-settings half of this shared rule moved to
    // chat/chat-inspector.css; each half keeps the flex layout.
    expect(ruleBody(v2, '.v2-pods__join-policy')).toContain('display: flex');
    expect(ruleBody(v2, '.v2-pod-join-settings')).toContain('display: flex');
  });

  test('the approval card visually outranks the action over the agent prose', () => {
    // The consent fix is render ORDER plus visual rank. The order lives in
    // V2ApprovalCard and a render test pins it; the rank lives only here.
    // If the pitch ever styles up to match the action, the two lines read as
    // equals again and a human re-consents to prose — the exact defect,
    // silently restored, with the render test still green.
    expect(ruleBody(v2, '.v2-approval__action')).toContain('font-weight: 600');
    const pitch = ruleBody(v2, '.v2-approval__pitch');
    expect(pitch).toContain('border-left');
    expect(pitch).toMatch(/font-size: 13px/);
  });

  test('approval consent controls are 44px touch targets on a phone', () => {
    const phone = blockContaining(v2, '@media (max-width: 480px)', '.v2-approval__btn');
    expect(ruleBody(v2, '.v2-root button.v2-approval__btn', { within: phone })).toContain('min-height: 44px');
    expect(ruleBody(v2, '.v2-approval__exact summary', { within: phone })).toContain('min-height: 44px');
  });

  test('approval argument blocks scroll within a bounded height', () => {
    const block = ruleBody(v2, '.v2-approval__arg-value--block');
    expect(block).toContain('max-height: 12em');
    expect(block).toContain('overflow-y: auto');
  });

  test('the hosted-to-BYO handoff preserves the server command and has a copy action', () => {
    // The payload is the source of truth: the renderer must branch on the
    // structured handoff kind, and the pre block must preserve line breaks so
    // the copied bytes match the command shown in Connect.
    expect(messageRow).toContain("message.payload?.kind === 'byo-handoff'");
    expect(ruleBody(v2, '.v2-byo-handoff__command')).toContain('white-space: pre-wrap');
    expect(ruleBody(v2, '.v2-root button.v2-byo-handoff__copy')).toContain('cursor: pointer');
  });

  test('retired chat selectors stay deleted', () => {
    for (const selector of [
      '.v2-chat__btn--accent',
      '.v2-chat__state-dot',
      '.v2-chat__system-link',
    ]) {
      expect(v2).not.toContain(selector);
    }
  });

  test('retired legacy feature routes and embedded styles stay deleted', () => {
    // TASK-123 removed six legacy V2FeaturePage wrappers. The pod board and
    // community remain separate, supported surfaces; this guard names only
    // the archived routes so a future removal sweep cannot widen its scope.
    const retiredRoutes = ['dashboard', 'feed', 'thread/:id', 'skills', 'digest', 'analytics'];
    expect(retiredRoutes).not.toHaveLength(0);
    for (const route of retiredRoutes) {
      expect(v2App).not.toContain(`path="${route}"`);
    }

    for (const legacyRedirect of [
      "pathname === '/feed'",
      "pathname.startsWith('/thread/')",
      "pathname === '/dashboard'",
      "pathname === '/digest'",
      "pathname === '/skills'",
    ]) {
      expect(app).not.toContain(legacyRedirect);
    }

    expect(v2).not.toContain('post-feed-container');
    expect(v2).not.toContain('v2-skills-catalog');
  });

  test('E2E specs do not reference a retired legacy feature route', () => {
    const e2eDirectory = path.join(__dirname, '../../../../e2e');
    const specs = fs.readdirSync(e2eDirectory).filter((file) => file.endsWith('.spec.ts'));
    const retiredRoute = /(?:\/v2)?\/(?:feed|dashboard|digest|analytics|skills)(?=\/|[?#'"`\s]|$)|\/thread\//;

    expect(specs).not.toHaveLength(0);
    for (const spec of specs) {
      expect(fs.readFileSync(path.join(e2eDirectory, spec), 'utf8')).not.toMatch(retiredRoute);
    }
  });

  describe('Signal chat + inspector color contract (TASK-124)', () => {
    // The composer's send and mode buttons left with the old composer (TASK-758).
    const filledControls = [
      '.v2-root button.v2-first-run__hello',
      '.v2-syscard__cta',
      '.v2-root button.v2-approval__btn--approve',
    ];

    test('every ordinary filled control uses ink, never cobalt', () => {
      for (const selector of filledControls) {
        const rule = selectorRuleBody(v2, selector);
        expect(rule).toContain('var(--v2-ink)');
        expect(rule).not.toContain('var(--v2-accent)');
      }
    });

    test('the pending human decision is the sole cobalt-filled action exception: one primary choice, bordered alternatives, and a text-only Other action', () => {
      const card = ruleBody(v2, '.v2-decision-card');
      const primary = selectorRuleBody(v2, '.v2-root button.v2-decision-card__choice--primary');
      const ordinaryChoice = selectorRuleBody(v2, '.v2-root button.v2-decision-card__choice,');
      const other = ruleBody(v2, '.v2-root button.v2-decision-card__other');
      expect(card).toContain('box-shadow: 0 0 0 2px var(--v2-accent)');
      expect(primary).toContain('background: var(--v2-accent)');
      expect(primary).not.toContain('var(--v2-ink)');
      expect(ordinaryChoice).toContain('border: 1px solid var(--v2-border)');
      expect(ordinaryChoice).not.toContain('background: var(--v2-accent)');
      expect(other).toContain('color: var(--v2-accent-text)');
      expect(other).toContain('border: 0');
      expect(other).not.toContain('background: var(--v2-accent)');
    });

    test('workspace cobalt backgrounds are a reviewed role allowlist: two blocks and five marks', () => {
      // A class used by the route that gains an accent background joins this
      // set automatically, so a seventh/extra fill fails instead of hiding in
      // stale stylesheet rules. Inspector state classes are generated from the
      // state kind, hence the two explicit additions below.
      const workspaceSource = [
        navRail,
        podsSidebar,
        thread,
        threadCard,
        workspaceInspector,
        decisionCard,
        composer,
        messageRow,
      ].join('\n');
      const activeClasses = new Set(Array.from(workspaceSource.matchAll(/\bv2-[\w-]+/g), ([className]) => className));
      activeClasses.add('v2-workspace-inspector__state--needs-you');
      activeClasses.add('v2-workspace-inspector__state--working');

      const cobalt = activeAccentBackgroundSelectors(v2, activeClasses);
      // Direction C removed the sidebar channel rows (walk-1 miss 8): the
      // live-channel dot is no longer a cobalt background in the shell.
      expect(cobalt).toEqual([
        // S3b: D215 .presence carries a 7px cobalt dot (.dot--pulse).
        '.v2-chat__typing-dot',
        '.v2-rail__brand-icon',
        // D223 (TASK-735): the rail's needs-you count is the artboard's filled
        // cobalt badge.
        '.v2-rail__item-icon .MuiBadge-badge',
        '.v2-root button.v2-decision-card__choice--primary',
        // Direction C (walk-3 miss 62, ux-lead 64476 (1)): an agent's transcript
        // avatar is a flat cobalt square with white initials — the mark that
        // says "agent" on a row. A photo never gets the class.
        '.v2-thread .v2-avatar--flat-agent',
        '.v2-thread-card__dot',
        '.v2-workspace-inspector__state--needs-you',
        '.v2-workspace-inspector__state--working',
      ]);
    });

    test('a ruled in-thread decision drops back to a muted transcript label, not a second card', () => {
      expect(thread).toContain('settledDecisionByMessageId');
      expect(threadMessages).toContain('isDecisionRuling={Boolean(settledRuling)}');
      expect(messageRow).toContain("t('activity.decision.ruledShort')");
      const ruled = ruleBody(v2, '.v2-msg__ruled');
      expect(ruled).toContain('color: var(--v2-text-muted)');
      expect(ruled).toContain('var(--v2-font-mono)');
    });

    test('Activity hydrates settled decisions from the durable history projection', () => {
      expect(activityPage).toContain("'/api/activity/decision-history'");
      expect(activityPage).toContain('settledHistory');
      expect(activityPage).toContain('setSettledQueueDecisions');
      expect(activityPage).toContain('const loadMoreHistory = async () =>');
      expect(activityPage).toContain('const loadedExtent = Math.max(historyItems.length, previousHistoryExtent)');
      expect(activityPage).toContain('historyOffsetRef.current = loadedExtent');
      expect(activityPage).toContain('historyCount - existingIds.size');
      expect(activityPage).toContain('showMoreSettled');
      expect(activityPage).toContain('offset: 0');
    });

    test('chat and workspace-inspector surfaces do not paint with accent-soft', () => {
      const prefixes = [
        '.v2-chat',
        '.v2-msg',
        '.v2-workspace-inspector',
        '.v2-approval',
        '.v2-syscard',
        '.v2-thread-card',
      ];
      const offenders = v2.split('}').filter((block) => {
        const open = block.indexOf('{');
        if (open === -1 || !block.includes('var(--v2-accent-soft)')) return false;
        const selector = block.slice(0, open).replace(/\/\*[\s\S]*?\*\//g, '');
        return prefixes.some((prefix) => selector.includes(prefix));
      });

      expect(offenders).toEqual([]);
    });

    test('hover under chat and workspace inspector changes fill only, never accent color, border, or shadow', () => {
      const prefixes = [
        '.v2-chat',
        '.v2-msg',
        '.v2-workspace-inspector',
        '.v2-approval',
        '.v2-syscard',
        '.v2-thread-card',
      ];
      const accentHoverDeclarations = v2.split('}').flatMap((block) => {
        const open = block.indexOf('{');
        if (open === -1) return [];
        const selector = block.slice(0, open).replace(/\/\*[\s\S]*?\*\//g, '');
        const body = block.slice(open + 1);
        if (!selector.includes(':hover') || !prefixes.some((prefix) => selector.includes(prefix))) return [];
        return body.split(';').map((declaration) => declaration.trim()).filter((declaration) => (
          /^(color|border-color|box-shadow):/.test(declaration) && declaration.includes('var(--v2-accent')
        ));
      });

      expect(accentHoverDeclarations).toEqual([]);
    });

    test('the allowed cobalt marks remain explicit', () => {
      for (const selector of [
        '.v2-thread-card__dot',
        '.v2-thread-card--addressed .v2-thread-card__count',
        '.v2-msg__mention',
        '.v2-msg__content a',
        '.v2-workspace-inspector__state--needs-you',
        '.v2-root button.v2-approval__result-link',
        '.v2-root button.v2-chat__new-pod-copy',
        '.v2-root .v2-chat__new-pod-error button',
      ]) {
        expect(selectorRuleBody(v2, selector)).toContain('var(--v2-accent');
      }
    });
  });

  test('an uploaded avatar photo is not overlaid by the initials-plate highlight', () => {
    // .v2-avatar carries an inset highlight so a seeded gradient reads as a lit
    // sphere rather than a flat disc. That shading is correct behind INITIALS
    // and wrong on top of a person's photo, where it lands as a bright band
    // across the image. The `:has(img)` override removes it for the photo case.
    //
    // jsdom cannot see this — it has no compositing — so a render test would
    // pass with the highlight sitting on every uploaded face. Guarding the
    // rule's presence is the same stand-in used for the invariants above.
    const base = ruleBody(v2, '.v2-avatar');
    expect(base).toContain('inset');

    const photo = ruleBody(v2, '.v2-avatar:has(img)');
    expect(photo).toContain('box-shadow');
    expect(photo).toContain('none');
  });

  test('the thread rail geometry survives, because jsdom cannot see it', () => {
    // @ux-lead's brief fixes the rail at 28px with replies 40px off it, and
    // 24px at 390. jsdom has no layout engine, so a render test cannot tell a
    // correct rail from a missing one — the card and replies still appear,
    // just unindented and with no rule. This pins the three numbers that a
    // reader would otherwise have to take from a comment.
    // REV 3 (2026-08-23): the whole thread block is indented to the
    // message TEXT column like an attachment (margin-left 50px, pinned in
    // the column test above), so the rail sits AT the block edge — margin 0
    // — and card, rail, and message text share one line. Rev 2's
    // avatar-centre axis (margin 14 → x = 15) is superseded: the block no
    // longer starts at the avatar edge, so there is no avatar to aim at.
    // S3b (#3178 / TASK-745, D215 .thr): the rail is gone. The replies are a
    // card at the block's text-column edge, and each reply is the frame's
    // 24px / 10px row. jsdom cannot see any of this, so pin the numbers.
    const card = ruleBody(v2, '.v2-thread .v2-thread-replies');
    expect(card).toContain('padding: 10px 12px 8px');
    expect(card).toContain('gap: 8px');
    expect(ruleBody(v2, '.v2-thread-replies')).not.toContain('border-left');
    const railRow = ruleBody(v2, '.v2-thread .v2-thread-replies .v2-msg');
    expect(railRow).toContain('grid-template-columns: 24px minmax(0, 1fr)');
    expect(railRow).toContain('gap: 10px');
    expect(ruleBody(v2, '.v2-thread .v2-thread-replies .v2-msg__content')).toContain('font-size: 13.5px');
    // Ruling 9: the old unscoped reply-row overrides are deleted, not out-ranked.
    expect(v2).not.toMatch(/\n\.v2-thread-replies \.v2-msg(?:__head|__author|__time|--grouped)? \{/);

    // 390: D215 .app.m .thr — 40px indent, tighter card padding.
    const phone = mediaBlockContaining(v2, '.v2-thread .v2-thread-replies {');
    expect(ruleBody(v2, '.v2-thread .v2-thread-replies', { within: phone })).toContain('padding: 8px 10px 8px');
  });

  test('the thread card has no shadow and no accent at rest', () => {
    // Two separate brief constraints that both fail silently: a shadow reads
    // as "slightly wrong depth" and an accent at rest destroys the ONE signal
    // the card has for being addressed.
    // Selector carries the `.v2-root button.` prefix ON PURPOSE: the global
    // The prefixed selector keeps the card's visual treatment explicit while
    // the global reset remains a low-specificity default.
    const card = ruleBody(v2, '.v2-root button.v2-thread-card__main');
    expect(card).toContain('box-shadow: none');
    expect(card).toContain('min-height: 44px');
    expect(card).toContain('color: #4b5563');
    expect(card).not.toContain('var(--v2-accent)');

    // Accent is reachable only through the addressed modifier.
    const addressed = ruleBody(v2, '.v2-thread-card--addressed .v2-thread-card__count');
    expect(addressed).toContain('var(--v2-accent)');
  });

  test('message actions retain 44px targets and become visible on touch layouts', () => {
    // TASK-052 intent, third mechanism: the hover cluster carries
    // Reply/Thread/React. Desktop reveals it on hover; a 390px touch
    // surface cannot depend on hover, so both touch blocks (pointer:coarse
    // and max-width:640px) force it visible with 44px targets.
    // Tap-reveal, not always-on: the touch blocks must gate visibility on
    // .v2-msg--reveal (set by the bubble's tap handler) — an ungated
    // `.v2-msg__actions { opacity: 1 }` here would put chrome over every
    // message by default (reported 2026-08-23).
    expect(v2).toMatch(/@media \(max-width: 640px\)[\s\S]*?\.v2-msg--reveal \.v2-msg__actions[\s\S]*?opacity: 1/);
    // S3a: D215 draws 28px keys, so touch keeps a 44px HIT AREA (28 + 2 x 8)
    // rather than a 44px key, on coarse pointers and on phone widths.
    const coarse = blockContaining(v2, '@media (hover: none), (pointer: coarse)', '.v2-root .v2-thread button.v2-msg__action::after');
    expect(coarse).toContain(".v2-root .v2-thread button.v2-msg__action::after { content: ''; position: absolute; inset: -8px; }");
    expect(mediaBlockContaining(v2, '.v2-root .v2-thread button.v2-msg__action::after'))
      .toContain(".v2-root .v2-thread button.v2-msg__action::after { content: ''; position: absolute; inset: -8px; }");
    // Reply in thread / Follow / Collapse moved from the chip to the band's
    // foot (ux-lead 64476 (3)) — the 44px floor moved with them.
    expect(v2).toMatch(/@media \(max-width: 640px\)[\s\S]*?\.v2-thread-replies__foot button[\s\S]*?min-height: 44px/);
    expect(v2).toMatch(/@media \(max-width: 640px\)[\s\S]*?\.v2-thread-card\s*\{[\s\S]*?flex-wrap: wrap/);
  });

  test('reduced motion actually reaches the thread transitions', () => {
    // The 300ms layout transition is a brief requirement AND a reduced-motion
    // hazard. Easy to add the transition and forget the opt-out; nothing in a
    // render test notices, and the people it affects are not the ones testing.
    expect(v2).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.v2-thread-replies[\s\S]*?transition: none/,
    );
  });
  test('zh-CN: every negative-tracking title is reset under :lang(zh) — CJK never takes negative letter-spacing (TASK-055)', () => {
    // Every selector in v2.css that declares negative letter-spacing must be
    // listed in the :lang(zh) reset block. Measured in a real browser: CJK
    // glyphs have no side bearings, so -0.025em on a 20px title crushes strokes.
    // The selector list may span lines (`a,\nb,\nc {`) — capture the whole
    // list, then split on commas, or a multi-line list is checked by its last
    // line only (sprint-review's gate on #1253: h1–h5 slipped past h6).
    const negative = [...v2.matchAll(/\n((?:[^\n{}]+,\n)*[^\n{}]+) \{[^}]*letter-spacing:\s*-[^;]+;/g)]
      .flatMap((m) => m[1].split(',').map((sel) => sel.trim()))
      .filter(Boolean);
    expect(negative.length).toBeGreaterThan(0);
    const resetStart = v2.indexOf('.v2-root:lang(zh) .v2-rail__brand');
    expect(resetStart).toBeGreaterThan(-1);
    expect(v2.slice(resetStart, v2.indexOf('}', resetStart))).toContain('letter-spacing: 0');
    // A surface lifted out of v2.css (D223) carries its own resets, so read
    // every `:lang(zh)` rule that zeroes letter-spacing, not only the shared list.
    const resetBlock = [...v2.matchAll(/([^{}]*)\{([^{}]*)\}/g)]
      .filter(([, sels, body]) => sels.includes(':lang(zh)') && /letter-spacing:\s*0\b/.test(body))
      .map(([, sels]) => sels).join('\n');
    for (const sel of negative) {
      const bare = sel.replace(/^\.v2-root /, '');
      expect(resetBlock).toContain(`.v2-root:lang(zh) ${bare}`);
    }
  });

  test('zh-CN: the mono labels that carry the Pod noun are not lowercased (TASK-164)', () => {
    // The two rules this resets BOTH still lowercase — assert them first, so
    // the reset cannot pass by guarding a rule that no longer exists.
    expect(ruleBody(v2, '.v2-connector-gates__title')).toContain('text-transform: lowercase');
    expect(ruleBody(v2, '.v2-tools__field > span:first-child, .v2-tools__field > legend')).toContain('text-transform: lowercase');
    const start = v2.indexOf('.v2-root:lang(zh) .v2-connector-gates__title');
    expect(start).toBeGreaterThan(-1);
    const block = v2.slice(start, v2.indexOf('}', start));
    expect(block).toContain('.v2-root:lang(zh) .v2-tools__field > span:first-child');
    expect(block).toContain('text-transform: none');
  });

  test('zh-CN: body copy takes line-height 1.6 and a 12px floor under :lang(zh) (TASK-055)', () => {
    // Measured in a real browser: .v2-msg__content rendered Chinese at 1.55.
    // CJK glyphs fill the em box, so Latin leading leaves no white between
    // lines and 11px is below legibility. (The old composer hint this also
    // named is gone from the composer, and its rule with it: TASK-758.)
    // Each selector's zh rule, wherever its surface file put it: the D223
    // lifts split the shared :lang(zh) lists by surface.
    const zhBlock = (sel: string): string => {
      const at = v2.search(new RegExp(`\\.v2-root:lang\\(zh\\) ${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=[,\\s{])`));
      expect(at).toBeGreaterThan(-1);
      return v2.slice(at, v2.indexOf('}', at));
    };
    expect(zhBlock('.v2-msg__content')).toContain('line-height: 1.6');
    expect(ruleBody(v2, '.v2-root:lang(zh) .v2-workspace-inspector__empty')).toContain('line-height: 1.6');
    for (const sel of ['.v2-workspace-inspector__actor', '.v2-workspace-inspector__task-meta']) {
      expect(zhBlock(sel)).toContain('font-size: 12px');
    }
  });

  // Connectors v2 (spec §5): platform tint tokens must exist in BOTH
  // token files (the same-PR rule), and the tile class must consume them.
  it('chat message text has NO measure cap (craft finding 6 overruled, 2026-09-01)', () => {
    // #1367 pinned a 75ch cap here as the audit's P0. It was overruled —
    // third full-width ruling; worst case was a large screen with the
    // sidebar collapsed. The rule-2 v6 assertion above owns the ban; this
    // test flips to the same polarity so the two can never disagree.
    const block = v2.match(/\.v2-msg__content \{[^}]*\}/);
    expect(block).not.toBeNull();
    expect(block![0]).not.toMatch(/max-width:\s*\d+ch/);
  });

  it('the long-prose fold fades by masking the prose, not by painting a surface colour (#3055 design HOLD)', () => {
    // A white ::after gradient shows as a white band on a hovered row. The mask keeps the row's own surface.
    const block = v2.match(/\.v2-msg__prose--closed \{[^}]*\}/);
    expect(block).not.toBeNull();
    expect(block![0]).toMatch(/mask-image:\s*linear-gradient/);
    expect(v2).not.toMatch(/\.v2-msg__prose--closed::after/);
  });

  it('the long-prose fold keeps both its 132px height and overflow clip', () => {
    // The fold sizes between 132px and auto (motion pass), so the six-line cap is a
    // block-size rather than a max-height; it must still be 132px and still clip.
    const block = v2.match(/\.v2-msg__prose--closed \{[^}]*\}/);
    expect(block).not.toBeNull();
    expect(block![0]).toMatch(/block-size:\s*132px/);
    expect(block![0]).toMatch(/overflow:\s*clip/);
  });

  it('the BEND-1 feature type step exists in v2.css and tokens.css together', () => {
    const ds = fs.readFileSync(path.join(__dirname, '../../../design-system/tokens.css'), 'utf8');
    expect(v2).toContain('--v2-fs-feature: 17px');
    expect(ds).toContain('--c-fs-feature: 17px');
    // Its one consumer, the empty team's title, left v2.css with the Your team
    // lift (R06); the step is still defined here and used there.
    expect(read('../components/V2YourTeamPage.css')).toContain('font: 700 var(--v2-fs-feature)/1.2');
  });

  it('v2.css braces balance — an unclosed block silently swallows every later rule', () => {
    // Shipped 2026-08-30: a doubled selector anchor ('.v2-team__tabs {.v2-team__tabs {')
    // left one brace unclosed; the build tolerated it, the browser dropped
    // every rule after line ~4023 (header CTAs unstyled, avatar sizing gone).
    // jsdom can't see the breakage; brace balance is the cheap structural pin.
    const opens = (v2.match(/\{/g) || []).length;
    const closes = (v2.match(/\}/g) || []).length;
    expect(opens).toBe(closes);
    expect(v2).not.toMatch(/\{[^\n}]*\{/); // two opens on one line = doubled anchor
  });

  it('team card on a phone: one column, so the name column never one-chars (spec §5, #568 class, re-pinned on direction C)', () => {
    // The featured row is gone; the same guarantee on the card grid is one
    // column at ≤760 and a card head whose name column can shrink.
    expect(ruleBody(teamCss, '.v2-team .v2-team__grid', { within: teamPhoneBlock(teamCss) })).toContain('repeat(1, minmax(0, 1fr))');
    expect(ruleBody(teamCss, '.v2-team .v2-team-card__title')).toContain('min-width: 0');
  });

  it('platform tint tokens stay in v2.css and tokens.css, while Signal rows use the cobalt mark', () => {
    const ds = fs.readFileSync(path.join(__dirname, '../../../design-system/tokens.css'), 'utf8');
    for (const pf of ['telegram', 'slack', 'discord', 'whatsapp']) {
      expect(v2).toContain(`--v2-platform-${pf}-soft`);
      expect(ds).toContain(`--c-platform-${pf}-soft`);
    }
    expect(ruleBody(v2, '.v2-connector-row__dot--live')).toContain('var(--v2-ink)');
    expect(v2).not.toContain('.v2-connector__tile--telegram');
  });

  it('nothing in v2.css hides the connector row\'s reason, at 390 or anywhere', () => {
    // Show is the default. This rule used to hide __detail for every state except
    // two enumerated ones, so the not-yet row that IS available
    // (ToolPanels) lost "install the GitHub App first" /
    // "read, or read and write" and a stranger saw a "not granted" kicker with
    // nothing under it. The two reason strings are already render-asserted in
    // ConnectorsPage.tools.test.tsx — this is the half jsdom cannot see.
    // If one row ever needs the detail hidden on phones, add that selector to the
    // list below on purpose rather than re-introducing an exception chain.
    const NAMED_DETAIL_HIDE_CASES: string[] = [];
    // Scope is the whole sheet, deliberately rather than by accident. Three
    // rounds of this guard each picked the wrong media set — unbounded, then
    // 760-only, then every `max-width >= 390` — because a 390 phone matches
    // `max-width` blocks *and* `@media (hover: none)` / `(pointer: coarse)`.
    // The claim is not about a viewport: no rule in this sheet may
    // hide the reason, and NAMED_DETAIL_HIDE_CASES is the deliberate exception
    // list. So this reads the whole file and no media-picking predicate is left
    // to get wrong.
    //
    // Controls first, so an empty or mis-typed scan cannot make the assertion
    // below vacuous: the sheet was read, it carries the class, and it carries the
    // not-yet row's details wrapper.
    expect(v2).toContain('.v2-connector-row__detail');
    // Every hiding mechanism a declaration can use, not just the one that
    // caused this. `display:none` was the defect; `visibility:hidden` is the
    // same loss through a different property, and neither hides the rule from a
    // reader who greps for the class.
    //
    // The class test below is a substring on purpose:
    // `.v2-connector-row__detail` also matches `.v2-connector-row__details`, the
    // wrapper the reason sits inside, and hiding that wrapper loses the reason
    // just as completely. Do not tighten it to an exact-selector match.
    const hidingRules = v2
      .split('}')
      .filter((rule) => rule.includes('.v2-connector-row__detail') && /(display:\s*none|visibility:\s*hidden)/.test(rule))
      .filter((rule) => !NAMED_DETAIL_HIDE_CASES.some((named) => rule.includes(named)));
    expect(hidingRules).toEqual([]);
  });

  it('Signal connectors pin the drawer row, aside, colour grammar, and phone collapse', () => {
    // TASK-162 (1): the ink hover must NOT claim a secondary action, or a hovered
    // gear is ink behind an ink glyph. Asserted on the SELECTOR rather than on a
    // computed style: jsdom resolves no :hover rules at all, so the cascade this
    // bug lived in cannot be measured in-suite, only the shape that fixes it can.
    const inkHoverChunks = [...v2.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter(([, , body]) => body.includes('var(--v2-ink-hover)'))
      .flatMap(([, selector]) => selector.split(','))
      .map((selector) => selector.trim())
      .filter((selector) => selector.includes('.v2-connector-row__action:hover'));
    // Split per SELECTOR, not per rule: both variants share one declaration block.
    expect(inkHoverChunks).toHaveLength(2);
    expect(inkHoverChunks.find((selector) => selector.includes('button.v2-connector-row__action:hover'))).toContain(':not(:disabled)');
    for (const selector of inkHoverChunks) {
      expect(selector).toContain(':not(.v2-connector-row__action--secondary)');
    }
    // Rule 3: the kicker is mono 11; the mode word is hidden until 760; the gear is 32.
    expect(ruleBody(v2, '.v2-connector-row__kicker')).toContain('var(--v2-font-mono)');
    expect(ruleBody(v2, '.v2-connector-row__kicker')).toContain('font-size: 11px');
    expect(ruleBody(v2, '.v2-connector-row__kicker-mode')).toContain('display: none');
    expect(ruleBody(v2, '.v2-root button.v2-connector-row__action--icon')).toContain('width: 32px');
    // TASK-140: the aside's Revoke carries `--secondary` as well as `--icon`, and
    // `--secondary` sets `min-height: 36px`. min-height beats height, so the
    // composed rule must pin min-height too or the box measures 32x36.
    const asideIcon = ruleBody(v2, '.v2-root button.v2-connector-aside__secondary.v2-connector-aside__icon');
    expect(asideIcon).toContain('width: 32px');
    expect(asideIcon).toContain('height: 32px');
    expect(asideIcon).toContain('min-height: 32px');
    expect(v2).toContain('.v2-root button.v2-connector-aside__secondary.v2-connector-aside__icon { width: 44px; height: 44px; min-height: 44px; }');
    // A hosted connection's name sits in the aside's flex row beside its own
    // Disconnect. The note class's `margin-top: 12px !important` dropped it
    // about 6px below the button's centre, so this label carries no margin.
    expect(ruleBody(v2, '.v2-connector-aside__conn')).toContain('font-size: 12px');
    expect(ruleBody(v2, '.v2-connector-aside__conn')).not.toContain('margin');
    expect(ruleBody(v2, '.v2-connector-row__details')).toContain('padding-right: 8px');
    expect(ruleBody(v2, '.v2-page-head__meta')).toContain('var(--v2-font-mono)');
    expect(ruleBody(v2, '.v2-connector-row__glyph')).toContain('width: 20px');
    expect(ruleBody(v2, '.v2-connector-row__glyph')).toContain('color: inherit');
    expect(ruleBody(v2, '.v2-connector-row__detail')).not.toContain('text-overflow');
    expect(ruleBody(v2, '.v2-connector-row__detail')).not.toContain('nowrap');
    // Line 1 and the gate's pod name wrap too; the 390 clips were the defect (64144).
    expect(ruleBody(v2, '.v2-connector-row__details strong')).not.toContain('text-overflow');
    expect(ruleBody(v2, '.v2-connector-row__details strong')).not.toContain('nowrap');
    expect(ruleBody(v2, '.v2-connector-gate__pod')).not.toContain('text-overflow');
    expect(ruleBody(v2, '.v2-connector-gate__pod')).not.toContain('nowrap');
    expect(ruleBody(v2, '.v2-connector-row__details strong')).toContain('overflow-wrap: anywhere');
    expect(ruleBody(v2, '.v2-connector-gate__pod')).toContain('overflow-wrap: anywhere');
    // The state dot is a mark: ink filled / hollow / grey, never cobalt, never a status colour.
    expect(ruleBody(v2, '.v2-connector-row__dot--live')).toContain('var(--v2-ink)');
    expect(ruleBody(v2, '.v2-connector-row__dot--live')).not.toContain('var(--v2-accent)');
    expect(ruleBody(v2, '.v2-connector-gate__mark')).toContain('width: 4px');
    expect(ruleBody(v2, '.v2-connector-gate__mark')).toContain('var(--v2-ink)');
    expect(ruleBody(v2, '.v2-connector-gate__switch')).toContain('accent-color: var(--v2-ink)');
    expect(ruleBody(v2, '.v2-connector-gate__switch')).not.toContain('border-radius');
    expect(ruleBody(v2, '.v2-connector-gate__tag')).toContain('var(--v2-font-mono)');
    const connectorCss = v2.slice(v2.indexOf('/* ── Connectors'), v2.indexOf('/* Activity queue'));
    expect(connectorCss.length).toBeGreaterThan(1000);
    expect(connectorCss).not.toContain('var(--v2-success)');
    expect(connectorCss).not.toContain('var(--v2-warning)');
    expect(connectorCss).not.toContain('var(--v2-danger)');
    // Tools: a trail line is muted mono, an outcome is a word, never a coloured one.
    expect(ruleBody(v2, '.v2-tools__trail-line')).toContain('var(--v2-text-muted)');
    expect(ruleBody(v2, '.v2-tools__trail-line')).toContain('var(--v2-font-mono)');
    expect(ruleBody(v2, '.v2-tools__count strong')).toContain('font-size: 22px');
    expect(ruleBody(v2, '.v2-tools__count span')).toContain('font-size: 11px');
    expect(connectorCss).not.toMatch(/\.v2-tools \{[^}]*flex: none/);
    // The phone block keeps the row's reason rather than carrying an exception chain.
    expect(connectorCss).not.toContain('v2-connector-row--dead):not(.v2-connector-row--not-enabled) .v2-connector-row__detail');
  });

  describe('connectors.css (tile grid, popover, drawer)', () => {
    const cx = fs.readFileSync(path.join(__dirname, '../connectors/connectors.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    // The text of every `@media (max-width: N)` block, brace-balanced, joined.
    const mediaBlock = (px: number): string => {
      const marker = `@media (max-width: ${px}px)`;
      const blocks: string[] = [];
      for (let from = cx.indexOf(marker); from > -1; from = cx.indexOf(marker, from + 1)) {
        const open = cx.indexOf('{', from);
        let depth = 0;
        for (let i = open; i < cx.length; i += 1) {
          if (cx[i] === '{') depth += 1;
          if (cx[i] === '}') { depth -= 1; if (depth === 0) { blocks.push(cx.slice(open + 1, i)); break; } }
        }
      }
      expect(blocks.length).toBeGreaterThan(0);
      return blocks.join('\n');
    };
    const baseBody = (selector: string): string => {
      const outside = cx.replace(/@media[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '');
      const m = outside.match(new RegExp(`(?:^|\\})\\s*${selector.replace(/[.\\-]/g, '\\$&')}\\s*\\{([^}]*)\\}`));
      return m ? m[1] : '';
    };

    it('the page body hands the full height to the tile grid with no padding', () => {
      expect(cx).toMatch(/\.v2-feature--connectors > \.v2-feature__body \{[^}]*padding: 0;/);
    });

    it('the phone page is a 52px head, then a 12px-padded body of 104px tiles', () => {
      expect(mediaBlock(640)).toMatch(/\.v2-cx-head \{[^}]*height: 52px/);
      expect(mediaBlock(640)).toMatch(/\.v2-cx-body \{[^}]*padding: 12px/);
      expect(mediaBlock(640)).toMatch(/\.v2-cx-tile \{[^}]*height: 104px/);
    });

    it('the grid is six columns, three on a phone', () => {
      expect(baseBody('.v2-cx-grid')).toContain('grid-template-columns: repeat(6, minmax(0, 1fr))');
      expect(mediaBlock(640)).toMatch(/\.v2-cx-grid \{[^}]*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/);
    });

    it('the popover becomes a sheet above the tab bar at 760', () => {
      const pop = mediaBlock(760).match(/\.v2-cx-pop \{([^}]*)\}/)?.[1] ?? '';
      expect(pop).toContain('position: fixed');
      expect(pop).toMatch(/bottom: calc\(84px/);
      expect(pop).toContain('top: auto !important');
      // the popover's inline top and left must lose to the sheet, or it floats off-screen
      expect(pop).toContain('left: 12px !important');
      expect(pop).toMatch(/max-height: calc\(100vh/);
    });

    it('colours come from the Signal tokens, so dark and auto themes follow the shell', () => {
      expect(cx).toContain('--cx-key-a: var(--v2-key-a)');
      expect(cx).toContain('--cx-pop-shadow: var(--v2-shadow-pop)');
      expect(cx).not.toContain("data-theme='dark'");
    });

    it('the drawer is fixed over the page at 760, clear of the tab bar', () => {
      const drawer = mediaBlock(760).match(/\.v2-cx-drawer \{([^}]*)\}/)?.[1] ?? '';
      expect(drawer).toContain('position: fixed');
      expect(drawer).toMatch(/inset: 0 0 calc\(72px/);
      expect(baseBody('.v2-cx-drawer')).toContain('position: absolute');
    });
  });

  it('connector refusal links keep the in-text link treatment in the parsed stylesheet', () => {
    const style = document.createElement('style');
    style.textContent = v2;
    document.head.appendChild(style);

    try {
      const sheet = style.sheet;
      expect(sheet).not.toBeNull();
      const rules = Array.from(sheet!.cssRules);

      // This covers links in any refusal slot. Parsing before these assertions
      // catches malformed CSS without pinning unrelated stylesheet size/tail.

      const styleRules = rules.filter((rule) => rule.type === CSSRule.STYLE_RULE) as CSSStyleRule[];
      const linkRules = styleRules.filter((rule) => {
        const selectors = rule.selectorText.split(',').map((selector) => selector.trim());
        return selectors.includes('.v2-connector-row__refusal a')
          && selectors.includes('.v2-connector-aside__refusal a');
      });
      expect(linkRules).toHaveLength(1);
      expect(linkRules[0].selectorText.split(',').map((selector) => selector.trim())).toEqual([
        '.v2-connector-row__refusal a',
        '.v2-connector-aside__refusal a',
      ]);
      expect(linkRules[0].style.getPropertyValue('color')).toBe('var(--v2-accent-text)');
      expect(linkRules[0].style.getPropertyValue('text-decoration')).toBe('underline');

      const resetIndex = styleRules.findIndex((rule) => rule.selectorText === '.v2-root a');
      const linkIndex = styleRules.indexOf(linkRules[0]);
      expect(linkIndex).toBeGreaterThan(resetIndex);
    } finally {
      style.remove();
    }
  });

  describe('TASK-122 Phase A — the ruled restyle (spec on TASK-122)', () => {
    const v2Root = ruleBody(v2, '.v2-root');

    test('the tint step exists in both token files and the content pane is the inset card', () => {
      expect(cssVariable(v2Root, '--v2-shell-bg')).toBe('#eef0f4');
      expect(cssVariable(tokens, '--c-shell-bg')).toBe('#eef0f4');
      expect(cssVariable(v2Root, '--v2-content-radius')).toBe('6px');
      expect(cssVariable(tokens, '--c-content-radius')).toBe('6px');
      expect(ruleBody(v2, '.v2-shell')).toContain('var(--v2-shell-bg)');
      const main = ruleBody(v2, '.v2-pane--main');
      expect(main).toContain('border: 1px solid var(--v2-border)');
      expect(main).toContain('border-radius: var(--v2-content-radius)');
      // The banner variant must out-specify `.v2-authenticated-shell__content .v2-pane { height: 100% }`.
      expect(ruleBody(v2, '.v2-authenticated-shell .v2-pane--main')).toContain('height: calc(100% - 16px)');
      // Phones: the card goes flush — both selectors, or the banner variant keeps the desktop height.
      expect(v2).toMatch(/@media \(max-width: 760px\) \{[\s\S]*?\.v2-pane--main,\n\s*\.v2-authenticated-shell \.v2-pane--main \{[\s\S]*?border-radius: 0/);
      expect(ruleBody(v2, '.v2-feature')).toContain('background: var(--v2-surface)');
    });

    test('the radius ladder is 4 / 4 / 6 in both files (Signal: hard edges)', () => {
      for (const [v2Name, dsName, value] of [
        ['--v2-radius-sm', '--c-radius-sm', '4px'],
        ['--v2-radius', '--c-radius', '4px'],
        ['--v2-radius-lg', '--c-radius-lg', '6px'],
      ]) {
        expect(cssVariable(v2Root, v2Name)).toBe(value);
        expect(cssVariable(tokens, dsName)).toBe(value);
      }
    });

    test('Needs-you rows: open asks sit on a 1px neutral border, no shadow, no dividers (66390; ring moved to focus, TASK-748)', () => {
      const row = ruleBody(v2, '.v2-activity__queue-row');
      expect(row).toContain('border: 1px solid var(--v2-border)');
      expect(row).toContain('border-radius: var(--v2-radius)');
      expect(v2).not.toContain('.v2-activity__queue-row + .v2-activity__queue-row');
      const hover = ruleBody(v2, '.v2-activity__queue-row:hover');
      const declarations = hover.slice(hover.indexOf('{') + 1).split(';').map((d) => d.trim()).filter(Boolean);
      expect(declarations.length).toBeGreaterThan(0);
      for (const declaration of declarations) expect(declaration).toMatch(/^background/);
      // A pending decision or approval wears the same neutral border as every other ask — never a lift.
      const pending = ruleBody(v2, '.v2-activity__queue-row--decision,\n.v2-activity__queue-row--approval');
      expect(pending).toContain('border-color: var(--v2-border)');
      expect(pending).toContain('box-shadow: none');
      expect(cssVariable(v2Root, '--v2-shadow-pending')).toBe(cssVariable(tokens, '--c-shadow-pending'));
      // A ruled decision settles to a flat bordered row.
      const settled = ruleBody(v2, '.v2-activity__queue-row--settled');
      expect(settled).toContain('border: 1px solid var(--v2-border)');
      expect(settled).toContain('box-shadow: none');
      expect(activityPage).toContain("' v2-activity__queue-row--settled'");
    });

    test('Needs you never folds; one count; toggles are tint-selected; kicker and marks per 66389/66390', () => {
      // Pages after the first load themselves — the only queue control left is Retry/Loading.
      expect(activityPage).toContain('void loadMoreQueue(true);');
      // The remaining arm stays as the way back if auto-load ever stops short (sprint-review 66398).
      expect(activityPage).toContain('(queueMoreError || (queueHydrated && queueRemaining > 0 && !queueLoadingMore && !queueAutoPending)) && (');
      // Both arms plus the disabled bind, pinned together (ux-lead 66411): dropping the
      // loading arm or the bind would make the control actionable mid-load.
      expect(activityPage).toContain('disabled={queueLoadingMore}');
      // The stall detector clears the expectation when nothing fetches the next page (sprint-review 66417).
      expect(activityPage).toContain('globalThis.window.setTimeout(() => setQueueAutoPending(false), 1500)');
      expect(activityPage).toContain('item.actorUserId\n      ? agentUserIds.has(item.actorUserId)');
      // Oldest waiting first.
      expect(activityPage).toContain('new Date(a.timestamp || 0).getTime() - new Date(b.timestamp || 0).getTime()');
      // The section count is mono text beside the heading, not an ink pill.
      const count = ruleBody(v2, '.v2-activity__count');
      expect(count).toContain('var(--v2-font-mono)');
      expect(count).not.toContain('var(--v2-ink)');
      // Selected segment: tint ground + ink text inside the bordered group. Ink fill is for acts.
      expect(ruleBody(v2, '.v2-root button.v2-activity__window-button--active')).toContain('background: var(--v2-surface-hover)');
      expect(ruleBody(v2, '.v2-root button.v2-activity__window-button--active')).toContain('box-shadow: none');
      expect(ruleBody(v2, '.v2-root button.v2-activity__scope-button--active')).toContain('background: var(--v2-surface-hover)');
      expect(ruleBody(v2, '.v2-root button.v2-activity__scope-button--active')).not.toContain('var(--v2-ink)');
      // Card kicker: kind · pod (lowercase) · time, in mono 500, lowercase — and the LAST rule says so.
      expect(activityPage).toContain('shortPodName(item.podName)');
      expect(lastRuleBody(v2, '.v2-activity__queue-kind')).toContain('500 11px/16px var(--v2-font-mono)');
      expect(lastRuleBody(v2, '.v2-activity__queue-kind')).toContain('text-transform: lowercase');
      // Open asks sit on a 1px neutral border (slop tell 2); the cobalt ring belongs to the focused row only.
      expect(lastRuleBody(v2, '.v2-activity__queue-row')).toContain('border: 1px solid var(--v2-border)');
      expect(lastRuleBody(v2, '.v2-activity__queue-row')).not.toContain('var(--v2-accent)');
      expect(lastRuleBody(v2, '.v2-activity__queue-row--approval')).toContain('border-color: var(--v2-border)');
      expect(v2).toContain('.v2-activity__queue-row--approval:focus-within { border-color: var(--v2-accent); box-shadow: 0 0 0 1px var(--v2-accent); }');
      expect(lastRuleBody(v2, '.v2-activity__queue-row--decision')).toContain('box-shadow: none');
      expect(v2).toContain('.v2-activity__queue-row--settled,\n.v2-activity__queue-row--onboarding { padding: 12px; border: 1px solid var(--v2-border); }');
      // Day zero (66658/66666): Get started is its own card above Needs you; a step is not an ask.
      expect(activityPage).toContain('className="v2-activity__start" aria-labelledby="activity-get-started"');
      expect(activityPage).not.toContain('v2-activity__queue-row--onboarding');
      expect(activityPage).toContain("{!startSteps.includes('hire') && (");
      expect(ruleBody(v2, '.v2-activity__start-num')).toContain('background: var(--v2-ink)');
      expect(ruleBody(v2, '.v2-root .v2-activity__start-act button')).toContain('min-height: 32px');
      expect(v2).toMatch(/@media \(max-width: 760px\) \{[\s\S]*?\.v2-root \.v2-activity__start-act button \{ width: 100%; min-height: 44px; \}/);
      // One segment grammar (66400 fix 6): both groups bordered, active = tint + ink 600, inactive = white + secondary.
      expect(lastRuleBody(v2, '.v2-activity__scope')).toContain('border: 1px solid var(--v2-border)');
      expect(lastRuleBody(v2, '.v2-activity__scope')).toContain('background: var(--v2-surface)');
      expect(lastRuleBody(v2, '.v2-root button.v2-activity__scope-button')).toContain('border: 0');
      expect(lastRuleBody(v2, '.v2-activity__window')).toContain('background: var(--v2-surface)');
      // 0-state (66400 fix 5): a dashed panel with the sentence, not plain text.
      expect(lastRuleBody(v2, '.v2-activity__empty--plain')).toContain('border: 1px dashed var(--v2-border)');
      expect(activityPage).toContain("t('activity.needsYou.emptyLast', { age: relativeTime(lastAnsweredAt) })");
      // One seat, one mark: agent cobalt, human tint.
      expect(ruleBody(v2, '.v2-activity__queue-row .v2-activity__queue-mark--agent')).toContain('background: var(--v2-accent)');
      expect(ruleBody(v2, '.v2-activity__queue-row .v2-activity__queue-mark--human')).toContain('background: var(--v2-surface-hover)');
      // Direction A: the mark holds a 16px glyph; a secondary act is a 32px square
      // (44 under 760), never a word — and never a menu.
      expect(lastRuleBody(v2, '.v2-root .v2-activity__queue-mark svg')).toContain('width: 16px');
      expect(lastRuleBody(v2, '.v2-root .v2-activity__queue-actions button.v2-activity__queue-action--icon svg')).toContain('width: 16px');
      const iconAct = lastRuleBody(v2, '.v2-root .v2-activity__queue-actions button.v2-activity__queue-action--icon');
      expect(iconAct).toContain('width: 32px');
      expect(iconAct).toContain('padding: 0');
      // Both 44px rules must sit INSIDE a ≤760 block — sprint-review's gate on #1671: a lazy regex
      // matched from an earlier 760 query into the 640 block, so 641–760 got 674px bars, and a move
      // to top level passed too. Resolve the media block that actually encloses each rule.
      const enclosingMedia = (rule: string): string | null => {
        const at = v2.indexOf(rule);
        expect(at).toBeGreaterThan(-1);
        const open = v2.lastIndexOf('@media', at);
        if (open === -1) return null;
        const close = v2.indexOf('\n}', open);
        return close > at ? v2.slice(open, v2.indexOf('{', open)).trim() : null;
      };
      const icon44 = '.v2-root .v2-activity__queue-actions button.v2-activity__queue-action--icon { width: 44px; min-width: 44px; flex: none; }';
      const footer44 = '.v2-root .v2-activity__queue-row.v2-activity__queue-row--decision .v2-activity__decision-footer > button.v2-activity__queue-action--icon { flex: none; width: 44px; min-width: 44px; }';
      expect(enclosingMedia(icon44)).toBe('@media (max-width: 760px)');
      expect(enclosingMedia(footer44)).toBe('@media (max-width: 760px)');
      // And the footer override follows the full-width rule it beats, inside that same block.
      const fullWidth = '.v2-activity__decision-footer > button { flex: 1 1 100%;';
      expect(v2.indexOf(footer44)).toBeGreaterThan(v2.indexOf(fullWidth));
      expect(enclosingMedia(fullWidth)).toBe('@media (max-width: 760px)');
      // Other… is cobalt text; the handoff act is ink (no bordered modifier).
      expect(ruleBody(v2, '.v2-root .v2-activity__queue-actions button.v2-activity__option--other')).toContain('color: var(--v2-accent-text)');
      expect(activityPage).toContain('<button type="button" onClick={() => markHandoffHandled(item)}');
      // The rail badge is the exact count at any width, in mono and never clipped.
      // D223 (TASK-735): the artboard's .nav .bd, a filled cobalt count ringed
      // by the shell ground, replaced the bordered surface badge.
      const badge = ruleBody(v2, '.v2-rail__item-icon .MuiBadge-badge');
      expect(badge).toContain('var(--v2-font-mono)');
      expect(badge).toContain('background: var(--v2-accent)');
      expect(badge).toContain('box-shadow: 0 0 0 2px var(--v2-shell-bg)');
      // Moved forward: no section count; N more in <pod>.
      expect(activityPage).toContain("pod: shortPodName(group.name)");
      // ≤760: toggles stack, actions drop to 44px full width.
      expect(v2).toContain('.v2-root .v2-activity__queue-actions > button { flex: 1 1 100%; min-height: 44px; }');
      // The reply editor's nested Send takes only height at ≤760 — never a descendant width rule (66493/66498).
      expect(v2).toContain('.v2-root .v2-activity__reply > button { min-height: 44px; }');
      expect(v2).not.toContain('.v2-root .v2-activity__queue-actions button { flex: 1 1 100%;');
      // …and the stack outranks the desktop action column by ORDER: the ≤760 rule for
      // `.v2-activity__queue-row .v2-activity__queue-actions` comes after the grid-column: 3 rule (66438 at 720).
      const desktopActionsAt = v2.indexOf('.v2-activity__queue-row .v2-activity__queue-actions { grid-column: 3;');
      const stackedActionsAt = v2.indexOf('.v2-activity__queue-row .v2-activity__queue-actions { grid-column: 1 / -1; grid-row: auto; max-width: none;');
      expect(desktopActionsAt).toBeGreaterThan(-1);
      expect(stackedActionsAt).toBeGreaterThan(desktopActionsAt);
    });

    test('Activity keeps the Direction C bar, inbox measure, and moved-forward grouping', () => {
      expect(v2App).toContain("'v2-feature--activity'");
      expect(featurePage).toContain('className?: string;');
      expect(lastRuleBody(v2, '.v2-feature--activity > .v2-feature__body')).toContain('padding: 0 0 28px');
      expect(lastRuleBody(v2, '.v2-feature--activity .v2-feature__legacy')).toContain('max-width: none');
      // The page head is display 32 + muted 13 meta (ux-lead 66400 fix 2), not a 52px bar.
      expect(lastRuleBody(v2, '.v2-activity__title')).toContain('32px/36px var(--v2-font-display)');
      expect(activityPage).toContain('hint={t(\'activity.subtitle\')}');
      expect(lastRuleBody(v2, '.v2-activity__header')).toContain('border-bottom: 0');
      expect(lastRuleBody(v2, '.v2-activity')).toContain('width: 100%');
      expect(lastRuleBody(v2, '.v2-activity__sections')).toContain('760px');
      expect(activityPage).toContain('v2-activity__moved');
      expect(activityPage).toContain('v2-activity__queue-more');
      expect(activityPage).toContain('v2-activity__moved-cap-note');
      expect(lastRuleBody(v2, '.v2-root .v2-activity__queue-actions button.v2-activity__option')).toContain('border-radius: var(--v2-radius-sm)');
      expect(lastRuleBody(v2, '.v2-root .v2-activity__queue-actions button.v2-activity__option.v2-activity__queue-action--secondary')).toContain('var(--v2-accent-text)');
      expect(lastRuleBody(v2, '.v2-root .v2-activity__queue-actions button.v2-activity__option.v2-activity__queue-action--secondary')).toContain('border: 0');
      expect(v2).toMatch(/@media \(max-width: 640px\) \{[\s\S]*?\.v2-activity__header \{ min-height: 56px; align-items: baseline;/);
      // 390: decision options stack to 44px full width like every other action (66422 miss 2).
      // …and that block must come AFTER the inline option rules, or they outrank it (66428).
      const inlineOptionsAt = v2.indexOf('.v2-activity__queue-row.v2-activity__queue-row--decision .v2-activity__option-choice {');
      const stackedOptionsAt = v2.indexOf('.v2-activity__queue-row.v2-activity__queue-row--decision .v2-activity__option-choice { flex: 1 1 100%; max-width: none; }');
      expect(inlineOptionsAt).toBeGreaterThan(-1);
      expect(stackedOptionsAt).toBeGreaterThan(inlineOptionsAt);
      expect(v2.slice(0, stackedOptionsAt).lastIndexOf('@media (max-width: 760px)')).toBeGreaterThan(inlineOptionsAt);
      expect(v2).toMatch(/@media \(max-width: 760px\) \{[\s\S]*?\.v2-activity__queue-row\.v2-activity__queue-row--decision \.v2-activity__option-choice button \{ width: 100%; min-height: 44px; \}/);
      // 0-state (66422 miss 1): the dashed panel renders whenever nothing is open, settled cards under it, no kicker.
      expect(activityPage).toContain('{(queueCount === 0 || visibleQueue.length === 0) && (');
      expect(activityPage).toContain('queueCount === null && <span>');
      expect(activityPage).toContain('queueCount !== null && queueCount !== 0 && <V2Hint');
      // 390: mention and handoff actions drop full width under the copy, like the decision options (66400 fix 7).
      expect(v2).toMatch(/@media \(max-width: 640px\) \{[\s\S]*?\.v2-activity__queue-row \.v2-activity__queue-actions \{ grid-column: 1 \/ -1;/);
      expect(lastRuleBody(v2, '.v2-root button.v2-activity__window-button')).toContain('var(--v2-font-mono)');
      expect(lastRuleBody(v2, '.v2-root button.v2-activity__queue-more')).toContain('color: var(--v2-accent)');
      expect(lastRuleBody(v2, '.v2-root button.v2-activity__scope-button')).toContain('var(--v2-font-mono)');
      expect(lastRuleBody(v2, '.v2-root .v2-activity__queue-actions button.v2-activity__option')).toContain('min-height: 32px');
      // The 0-state is a sentence in a dashed panel (66400 fix 5), sans 13 — not mono meta.
      expect(lastRuleBody(v2, '.v2-activity__empty--plain span')).toContain('13px/18px var(--v2-font)');
      expect(activityPage).not.toContain('v2-activity__footer');
      expect(activityPage.indexOf('</header>')).toBeLessThan(activityPage.indexOf('className="v2-activity__controls"'));
      expect(v2).toMatch(/@media \(max-width: 1100px\) \{[\s\S]*?\.v2-activity__controls \{[^}]*position: relative;[^}]*top: auto;[^}]*right: auto;[^}]*flex-wrap: wrap;/);
      expect(lastRuleBody(v2, '.v2-activity__controls')).toContain('z-index: 2');
      expect(lastRuleBody(v2, '.v2-activity__scope-menu')).toContain('position: absolute');
      expect(lastRuleBody(v2, '.v2-activity__scope-menu')).toContain('max-height: 240px');
      expect(lastRuleBody(v2, '.v2-activity__scope-menu')).toContain('overflow-y: auto');
      expect(lastRuleBody(v2, '.v2-activity__queue-row .v2-activity__queue-actions')).toContain('grid-column: 3');
      expect(lastRuleBody(v2, '.v2-activity__queue-row .v2-activity__queue-actions:has(textarea)')).toContain('grid-column: 2 / -1');
      expect(v2).toMatch(/@media \(max-width: 640px\) \{[\s\S]*?\.v2-root \.v2-activity__reply button \{ min-height: 44px; \}/);
      const rowActionError = ruleBody(v2, '.v2-root .v2-activity__row-action-error');
      expect(rowActionError).toContain('grid-column: 1 / -1');
      expect(rowActionError).toContain('color: var(--v2-ink)');
    });

    test('halo focus: no hard outline in any Activity focus-visible rule; the global halo still carries the ring', () => {
      const activityFocusRules = v2.split('}').filter((block) => {
        const brace = block.indexOf('{');
        if (brace === -1) return false;
        const selector = block.slice(0, brace);
        return selector.includes('.v2-activity__') && selector.includes(':focus-visible');
      });
      expect(activityFocusRules.length).toBeGreaterThan(0);
      for (const block of activityFocusRules) expect(block.slice(block.indexOf('{'))).not.toContain('outline: 2px');
      expect(ruleBody(v2, '.v2-root button:focus-visible,\n.v2-root input:focus-visible,\n.v2-root textarea:focus-visible,\n.v2-root a:focus-visible')).toContain('box-shadow: var(--v2-focus-ring)');
      // The custom pod picker is outside the global halo's element list, so it carries its own.
      expect(ruleBody(v2, '.v2-activity__compose-picker-button:focus-visible')).toContain('box-shadow: var(--v2-focus-ring)');
    });

    test('ink primary: filled Activity buttons are ink, and blue stays off them', () => {
      expect(cssVariable(v2Root, '--v2-ink')).toBe('#101828');
      expect(cssVariable(tokens, '--c-ink')).toBe('#101828');
      const send = ruleBody(v2, '.v2-root .v2-activity__compose button');
      expect(send).toContain('var(--v2-ink)');
      expect(send).not.toContain('var(--v2-accent)');
      expect(ruleBody(v2, '.v2-root .v2-activity__queue-actions button')).not.toContain('var(--v2-accent)');
    });

    test('route chunks stay split the way the first screen depends on (TASK-145)', () => {
      // The cut that took the entry chunk from 4.18 MB (1.16 MB gzip) to 455 kB
      // (164 kB gzip) is one line of intent: every route renders a lazy chunk,
      // the entry keeps the stylesheet and the faces, and the shell keeps the
      // composer's own dependencies in its chunk. All three are reversible by a
      // single innocent edit, and none of them can be seen from the CSS, so
      // they are pinned here at the source that encodes them.
      const entry = read('../../App.tsx');
      expect(entry).toContain("const V2App = React.lazy(() => import('./v2/V2App'));");
      expect(entry).not.toMatch(/^import V2App from '\.\/v2\/V2App';$/m);
      // The entry, not the shell, has to carry the faces the first paint uses:
      // @font-face rules inside a lazy chunk would leave the public landing in
      // fallback fonts until the app shell loaded — and on the landing it never
      // loads at all.
      expect(entry).toContain("import '@fontsource-variable/bricolage-grotesque';");
      expect(entry).toContain("import '@fontsource/ibm-plex-sans/400.css';");
      expect(entry).toContain("import './v2/v2.css';");

      const shell = read('../V2App.tsx');
      // The composer lives in V2Layout, so V2Layout stays IN the shell chunk.
      // Making it lazy would add a serial round trip to the very path this row
      // is measured on while shrinking nothing that path does not need.
      expect(shell).toContain("import V2Layout from './components/V2Layout';");
      expect(shell).not.toContain("React.lazy(() => import('./components/V2Layout'))");
      // And the surfaces the composer does not need stay OUT of it.
      for (const heavy of [
        "'./components/V2PodBoard'",
        "'./connectors/ConnectorsPage'",
        "'./components/V2ActivityPage'",
        "'./components/V2ArtifactsPage'",
        "'../components/ChatRoom'",
        "'../components/admin/GlobalIntegrations'",
      ]) {
        expect(shell).toContain(`React.lazy(() => import(${heavy}))`);
      }
    });

    test('IBM Plex Sans is self-hosted, first in the stack, and imported before v2.css', () => {
      const app = read('../V2App.tsx');
      const fontImport = app.indexOf("import '@fontsource/ibm-plex-sans/400.css';");
      expect(fontImport).toBeGreaterThan(-1);
      expect(fontImport).toBeLessThan(app.indexOf("import './v2.css';"));
      expect(cssVariable(v2Root, '--v2-font')?.startsWith('"IBM Plex Sans"')).toBe(true);
      expect(cssVariable(tokens, '--c-font-sans')?.startsWith('"IBM Plex Sans"')).toBe(true);
      expect(v2Root).toContain('font-size: var(--v2-fs-body)');
      expect(v2Root).toContain('line-height: var(--v2-lh-body)');
      expect(cssVariable(v2Root, '--v2-lh-body')).toBe('20px');
      const pkg = JSON.parse(read('../../../package.json'));
      expect(pkg.dependencies['@fontsource/ibm-plex-sans']).toBeDefined();
      expect(pkg.dependencies['@fontsource-variable/bricolage-grotesque']).toBeDefined();
    });

    test('the empty-pod row survives on phones with its one act still reachable', () => {
      // A send into a pod with no agent installed is the case the delivery hint
      // skips (`agentsInPod > 0`), and the row's act is the whole point of it.
      expect(thread).toContain('delivery.agentsInPod === 0');
      expect(thread).toContain('noAgentsHint={noAgentsInPodLive ? noAgentsHint : null}');
      expect(threadMessages).toContain('className="v2-chat__no-agents"');
      expect(threadMessages).toContain('podChat.noAgentsInPod.action');
      // The box lives in the ONE shared side-row slot rule (with the delivery
      // hint); the derivation from `.v2-msg`'s grid is pinned by the next test.
      const slot = v2.slice(
        v2.indexOf('.v2-chat__delivery-hint,\n.v2-chat__no-agents,\n.v2-chat__starts {'),
        v2.indexOf('}', v2.indexOf('.v2-chat__delivery-hint,\n.v2-chat__no-agents,\n.v2-chat__starts {')),
      );
      expect(slot).toContain('margin: -4px 0 8px 48px');
      expect(slot).toContain('width: calc(100% - 48px)');
      // Their box is declared exactly once in the sheet — the shared slot — so
      // there is no second copy left for the cascade to pick between. The
      // margin pair is unique to this slot; `width: calc(100% - 48px)` is not
      // asserted globally because `.v2-thread-block` carries a complement of
      // its own one indent over.
      expect(v2.match(/margin: -4px 0 8px 48px;/g) || []).toHaveLength(1);
      // And neither row's own block restates a box. `ruleBody` cannot answer
      // this: it takes the FIRST line-start match, and the shared rule's second
      // selector line is itself a line-start `.v2-chat__no-agents {`, so it
      // reports the shared rule as the row's own — the TASK-140 trap, one file
      // over. lastIndexOf reaches the standalone block.
      for (const selector of ['\n.v2-chat__delivery-hint {', '\n.v2-chat__no-agents {', '\n.v2-chat__starts {']) {
        const from = v2.lastIndexOf(selector);
        expect(from).toBeGreaterThan(-1);
        expect(v2.slice(from, v2.indexOf('}', from))).not.toMatch(/(^|\s)(margin|width):/);
      }
      // `.v2-chat__messages > *` sets width: 100%, so the 50px indent must come
      // OUT of the width. Without this the row overruns the pane by 50px and the
      // full-width phone act and the body line are cut (ux-lead's 390 shot).
      expect(ruleBody(v2, '.v2-chat__messages > *')).toContain('width: 100%');
      expect(ruleBody(v2, '.v2-chat__no-agents-kicker')).toContain('font-size: 11px');
      expect(ruleBody(v2, '.v2-chat__no-agents-kicker')).toContain('text-transform: lowercase');
      expect(ruleBody(v2, '.v2-chat__no-agents-body')).toContain('color: var(--v2-text-secondary)');
      expect(ruleBody(v2, '.v2-root button.v2-chat__no-agents-action')).toContain('min-height: 32px');
      const phone = mediaBlockContaining(v2, 'button.v2-chat__no-agents-action');
      expect(phone).toContain('min-height: 44px');
      expect(phone).toContain('width: 100%');
      // The override has to beat the base MINIMUM. A `height: 44px` here would
      // lose to `min-height: 32px` and silently render 32 on a phone.
      expect(phone).not.toMatch(/[^-]height: 44px/);
    });

    test('both chat side-rows share one slot whose indent is the message text column', () => {
      // ux-lead's TASK-150 ruling: the delivery cue and the no-agent row must
      // land on the message text column — derived from the grid those rows'
      // own messages actually use, not a number by assumption. This guard reads
      // the avatar track and the gap out of the rule in play and compares; if
      // that column moves and the slot rule stays put, the suite fails instead
      // of the two edges quietly parting.
      //
      // The grid in play is the THREAD override, not the base `.v2-msg` rule:
      // these rows only ever render as siblings of a message inside
      // `.v2-thread`, where `.v2-thread .v2-msg` (0,3,0) replaces the base grid
      // (0,1,0). Deriving from the base rule is the mistake this rule shipped
      // with — it read 38 + 12 = 50 and the gate measured both rows 14px right
      // of `.v2-msg__content` at 390, 720 and 1440; 36px put them on it
      // (ux-lead verified by injection on their fixture, right edge and
      // scrollWidth unchanged).
      const at = v2.indexOf('.v2-chat__delivery-hint,\n.v2-chat__no-agents,\n.v2-chat__starts {');
      expect(at).toBeGreaterThan(-1);
      const slot = v2.slice(v2.indexOf('{', at) + 1, v2.indexOf('}', at));
      const threadGrid = ruleBody(v2, '.v2-thread .v2-msg');
      const lead = /grid-template-columns:\s*(\d+)px/.exec(threadGrid);
      const gap = /(?:^|\s)gap:\s*(\d+)px/.exec(threadGrid);
      expect(lead?.[1]).toBe('36');
      expect(gap?.[1]).toBe('12');
      const indent = `${Number(lead?.[1]) + Number(gap?.[1])}px`;
      expect(indent).toBe('48px');
      // The base grid is deliberately NOT the target. Without this line a
      // future reader finds 38 + 12 = 50 unreferenced and "corrects" the slot
      // back to it, which is exactly how this shipped wrong the first time.
      expect(ruleBody(v2, '.v2-msg')).toContain('grid-template-columns: 38px');
      expect(slot).toContain(`margin: -4px 0 8px ${indent};`);
      expect(slot).toContain(`width: calc(100% - ${indent});`);
      // Neither row restates its own box any more. A second declaration is
      // exactly how the two drifted apart, and last-in-sheet-wins would pick
      // between them silently — the delivery cue is the one that never had the
      // width complement at all.
      expect(ruleBody(v2, '.v2-chat__delivery-hint')).not.toMatch(/(^|\s)(margin|width):/);
      // The phone block that carries the transcript must not restate the slot:
      // the ≤760 act override is a BUTTON rule, and a row-level geometry rule in
      // there would outrank the shared rule exactly where it matters (390).
      const phone = mediaBlockContaining(v2, '.v2-chat__messages');
      // S3b: D215 .app.m .stream is 8 12 4.
      expect(phone).toContain('padding: 8px 12px 4px');
      expect(phone).not.toMatch(/\.v2-chat__(?:delivery-hint|no-agents|starts\b)/);
    });

    test("Scout's starts sit in the shared side-row slot and are 44px touch targets on a phone", () => {
      // First session, direction B: the welcome's starts render as their own
      // row under Scout's message, in the slot the delivery cue and the
      // no-agent row share, so they land on the message text column too.
      expect(threadMessages).toContain('className="v2-chat__starts"');
      expect(threadMessages).toContain('v2-chat__start${start.action === WELCOME_HOSTED_ACTION ? \' v2-chat__start--primary\' : \'\'}');
      // The 44px phone minimum must come AFTER the 32px base in the sheet: at
      // equal specificity the later rule wins, and a base rule placed after
      // the media block would silently render 32 on a phone.
      expect(ruleBody(v2, '.v2-root button.v2-chat__start')).toContain('min-height: 32px');
      expect(ruleBody(v2, '.v2-root button.v2-chat__start')).toContain('border-radius: var(--v2-radius)');
      const phone = mediaBlockContaining(v2, 'button.v2-chat__start');
      expect(phone).toContain('min-height: 44px');
      const base = v2.indexOf('\n.v2-root button.v2-chat__start {');
      const phoneAt = v2.indexOf(phone);
      expect(base).toBeGreaterThan(-1);
      expect(phoneAt).toBeGreaterThan(base);
    });

    test('pod focus keeps one bounded panel above the existing board and stays usable on phones', () => {
      expect(podBoard).toContain('className="v2-board__focus"');
      expect(podBoard).toContain('v2-board__focus-editor');
      expect(podBoard).toContain('expectedRevision: focusBaseRevision ?? 0');
      // S4: the closed panel is the frame's 40px focus strip.
      expect(ruleBody(boardCss, '.v2-feature--board .v2-board__focus-strip')).toContain('height: 40px');
      expect(ruleBody(boardCss, '.v2-board__focus-tasks')).toContain('flex-direction: column');
      expect(podBoard).toContain('focusConflictLatest');
      expect(podBoard).toContain('focusConflictReviewed');
      expect(podBoard).toContain('focusMoveTargetRef');
      expect(podBoard).toContain('aria-live="polite"');
      expect(podBoard).toContain('className="v2-board__focus-save"');
      expect(podBoard).toContain('v2-board__focus-position');
      expect(podBoard).toContain('className="v2-board__focus-task-position"');
      expect(podBoard).toContain('focusConflictLatest.focus.owner');
      expect(ruleBody(boardCss, '.v2-board__focus-selected li:focus-visible')).toContain('outline: 2px solid var(--v2-accent)');
      expect(ruleBody(boardCss, '.v2-board__focus-live')).toContain('clip: rect(0, 0, 0, 0)');
      expect(ruleBody(boardCss, '.v2-root button.v2-board__focus-save')).toContain('background: var(--v2-ink)');
      expect(ruleBody(boardCss, '.v2-root .v2-board__focus-selected button')).toContain('min-height: 32px');
      expect(ruleBody(boardCss, '.v2-root .v2-board__focus-selected button')).toContain('border: 1px solid var(--v2-border)');
      expect(ruleBody(boardCss, '.v2-board__focus-task-option')).toContain('flex: 0 0 auto');
      expect(ruleBody(boardCss, '.v2-board__focus-task-option > span')).toContain('overflow-wrap: anywhere');
      expect(ruleBody(boardCss, '.v2-board__focus-task-meta')).toContain('flex-wrap: wrap');
      expect(ruleBody(boardCss, '.v2-board__focus-scope')).toContain('font-size: 14px');
      expect(ruleBody(boardCss, '.v2-board__focus-scope')).toContain('line-height: 20px');
      expect(podBoard).toContain('if (data?.podId && data.podId !== podId) return;');
      expect(podBoard).toContain('className="v2-board__focus-retry"');
      expect(ruleBody(boardCss, '.v2-board__focus-conflict')).toContain('border: 1px solid var(--v2-border)');
      expect(boardCss).toMatch(/@media \(max-width: 760px\)[\s\S]*?\.v2-board__focus-edit,[\s\S]*?min-height: 44px;/);
      expect(boardCss).toMatch(/@media \(max-width: 760px\)[\s\S]*?\.v2-root \.v2-board__focus-editor button\.v2-board__focus-save,[\s\S]*?min-height: 44px;/);
      expect(boardCss).toMatch(/@media \(max-width: 760px\)[\s\S]*?\.v2-root \.v2-board__focus-selected button \{[\s\S]*?border: 1px solid var\(--v2-border\);/);
    });
  });

});

// The landing hero demo (TASK-147) is the product's own four-column workspace
// shrunk into a landing page, so its two failure modes are the ones jsdom
// cannot see: content clipped by the stage's fixed 720px height once the
// columns stack, and a transcript that collapses to nothing when the stage
// stops being a fixed-height grid. Both were reasoned about from the CSS and
// neither can be reproduced in a render test.
describe('the landing hero demo (TASK-147)', () => {
  const demo = read('../landing/demo-workspace.css');
  const landing = read('../landing/v2-landing.css');
  const landingPage = read('../landing/V2LandingPage.tsx');
  const component = read('../landing/DemoWorkspace.tsx');

  // demo-workspace.css carries exactly one phone block (v2.css carries many,
  // which is why it needs a different helper there).
  // Match an at-rule by its FULL text, never by a prefix: `@media (max-width:
  // 760px)` is a prefix of the 641-760 query beside it, so a prefix match reads
  // whichever the file happens to put first and the guard quietly asserts on the
  // wrong block.
  const phoneBlock = (css: string): string => mediaAt(css, '@media (max-width: 760px) {');

  test('the demo is the workspace at its own canvas, not a smaller invention', () => {
    expect(ruleBody(demo, '.v2-demo')).toContain('max-width: 1312px');
    expect(ruleBody(demo, '.v2-demo__stage')).toContain('grid-template-columns: 56px 212px minmax(0, 1fr) 272px');
    expect(ruleBody(demo, '.v2-demo__stage')).toContain('height: 720px');
    expect(ruleBody(demo, '.v2-demo__stage')).toContain('background: var(--v2-page-bg)');
    // The demo is the product's page, so it sits on the app's canvas colour.
    expect(cssVariable(readV2Css(), '--v2-page-bg')).toBe('#eef0f4');
  });

  test('a phone stacks the columns and lets the stage grow instead of clipping them', () => {
    const phone = phoneBlock(demo);
    expect(phone).toContain('.v2-demo__stage');
    expect(phone).toMatch(/\.v2-demo__stage \{[^}]*grid-template-columns: minmax\(0, 1fr\);/);
    // `height: auto` is the load-bearing half: .v2-demo has overflow:hidden, so
    // a stage that kept 720px while the columns stacked would cut off whatever
    // did not fit — silently, and only on a phone.
    expect(phone).toMatch(/\.v2-demo__stage \{[^}]*height: auto;/);
  });

  test('the transcript keeps a floor on a phone so the thread is never empty', () => {
    const phone = phoneBlock(demo);
    // .v2-demo__log is flex:1 / min-height:0, which needs a sized parent; on a
    // phone the stage is auto-height, so without this floor the hero's thread
    // renders as a blank strip.
    expect(phone).toMatch(/\.v2-demo__log \{[^}]*min-height: 300px;/);
  });

  test('the active pod row keeps its tint on a phone, where a later rule would clear it', () => {
    const phone = phoneBlock(demo);
    // ux-lead's 390 gate (#1855, at 62ceda24) measured the strip painting the
    // open pod like its neighbours. The cause is order, not a missing rule: the
    // phone row rule below has the same specificity as the desktop --active rule
    // and comes later, so its surface colour wins and the rail loses its only
    // position cue at exactly the width where the strip IS the navigation.
    expect(phone).toMatch(/\.v2-root button\.v2-demo__pod \{[^}]*background: var\(--v2-surface\);/);
    expect(phone).toMatch(/\.v2-root button\.v2-demo__pod--active \{[^}]*background: var\(--v2-accent-soft\);/);
    // Order IS the defect, so order is what this guard has to see. The two rules
    // are the same specificity (0,2,1), so the tint survives only because
    // --active sits later in the block: move it above the row rule with every
    // declaration unchanged and the active pod repaints white. sprint-review
    // measured exactly that in a browser at 390 — 86 parsed rules either way, so
    // it is the cascade, not a parse break — and this suite stayed green until
    // this pair. (Textual presence alone cannot see it.)
    const rowAt = phone.indexOf('.v2-root button.v2-demo__pod {');
    const activeAt = phone.indexOf('.v2-root button.v2-demo__pod--active {');
    expect(rowAt).toBeGreaterThanOrEqual(0);
    expect(activeAt).toBeGreaterThan(rowAt);
    // And hover cannot wipe it either — hover outranks the active rule, which is
    // the opposite of the product, where .v2-pods__item:hover is weaker than
    // .v2-root button.v2-pods__item--active.
    expect(demo).toMatch(/\.v2-root button\.v2-demo__pod--active:hover \{[^}]*background: var\(--v2-accent-soft\);/);
  });

  test('the inspector is one column at 390 and two only from 641 up', () => {
    // At 390 the two columns are ~156px against a board row that needs ~230, so
    // every row title truncated to an ellipsis with nothing left to read
    // (ux-lead, #1855 gate at 62ceda24).
    const twoUp = mediaAt(demo, '@media (max-width: 760px) and (min-width: 641px)');
    expect(twoUp).toMatch(/\.v2-demo__inspector \{[^}]*grid-template-columns: minmax\(0, 1fr\) minmax\(0, 1fr\);/);
    expect(twoUp).toMatch(/\.v2-demo__needs \{[^}]*grid-column: 1 \/ -1;/);
    // The phone block itself must not turn the inspector back into a grid: it
    // covers widths the 640 rule below also covers, and it comes first, so the
    // two-column layout would win at 390 as surely as it did before the fix.
    expect(phoneBlock(demo)).not.toMatch(/\.v2-demo__inspector \{[^}]*grid-template-columns/);
    // Below 641 it is the base flex column again, with needs hoisted to the top.
    expect(ruleBody(demo, '.v2-demo__inspector')).toContain('flex-direction: column');
    const oneUp = mediaAt(demo, '@media (max-width: 640px) {');
    expect(oneUp).toMatch(/\.v2-demo__needs \{ order: -1; \}/);
  });

  test('the hero is the product, not the video it replaced', () => {
    expect(landingPage).toContain('<DemoWorkspace />');
    expect(landingPage).not.toContain('/media/demo-2x.mp4');
    expect(landingPage).not.toContain('demoVideoRef');
    // The demo explains its own honesty limit in its chrome, and the component
    // renders that line unconditionally (the phone layout keeps it wrapping on
    // its own row rather than letting it scroll out of the pod strip).
    expect(component).toContain('sample workspace · replies are scripted');
    expect(phoneBlock(read('../landing/demo-workspace.css'))).toMatch(
      /\.v2-demo__sample \{[^}]*flex: 1 1 100%;/,
    );
  });

  test('the active pod row follows the component, not the board that drew it filled', () => {
    // ux-lead's carry note on #1841: the design board paints the active pod row
    // cobalt-filled, while the live rail uses a tint plus a 3px accent mark.
    // The build follows the component — a filled row here would be the landing
    // showing a product that does not exist.
    expect(ruleBody(demo, '.v2-root button.v2-demo__pod--active')).toContain('background: var(--v2-accent-soft)');
    expect(ruleBody(demo, '.v2-root button.v2-demo__pod--active')).not.toContain('background: var(--v2-accent);');
    expect(ruleBody(demo, '.v2-root button.v2-demo__pod--active::before')).toContain('width: 3px');
    expect(ruleBody(demo, '.v2-root button.v2-demo__pod--active::before')).toContain('background: var(--v2-accent);');
  });

  test('landing screenshot cards are flat: no window bar anywhere, no shadow anywhere', () => {
    // Landing.dc.html draws every card flat (1px border, radius 6). Checked over
    // the whole file, not through ruleBody('.v2-landing__shot-frame'): that
    // selector's first match is the max-width rule, so a shadow on the later
    // rule would pass a ruleBody check (ux-lead, #1918).
    expect(landingPage).not.toContain('v2-landing__shot-bar');
    // Any inset shadow is a focus ring, not card elevation, so the ban is narrowed
    // to NON-inset shadows rather than dropped: anything with an offset or blur
    // still fails here. The agent-team cards draw a border and no shadow at all.
    const shadows = [...landing.matchAll(/box-shadow:\s*([^;]+);/g)].map((m) => m[1].trim());
    expect(shadows.filter((s) => !s.startsWith('inset '))).toEqual([]);
  });

  test('even feature rows mirror their columns, and still stack on a phone', () => {
    // Without the mirror, :nth-child(even) only swaps order and rows 2 and 4
    // put the shot in the narrow column (423.7 px against 664.3 at 1200, and
    // 486 against 762 at 1440 — the two columns are 762 + 64 gap + 486, the
    // whole 1312 measure, exactly as the board draws them).
    expect(ruleBody(landing, '.v2-landing__feature-row:nth-child(even)')).toContain('grid-template-columns: minmax(0, 486fr) minmax(0, 762fr)');
    // :nth-child(even) (0,2,0) outranks the phone stacking rule (0,1,0), so the
    // phone block must name even rows too or they stay two columns at 390.
    const phone = landing.slice(landing.indexOf('@media (max-width: 680px)'));
    expect(phone).toContain('.v2-landing__feature-row:nth-child(even) { grid-template-columns: 1fr; }');
  });

  test('a row refusal takes a line of its own, under the row that raised it (Row C)', () => {
    // A refused Slack authorize now renders inside its row (ConnectorsPage).
    // jsdom cannot see this: the row is a 140px / minmax(150px, 1fr) / 120px
    // grid, so without the span the message would be squeezed into the name or
    // act track instead of reading as one line — the TASK-029 failure mode.
    const v2 = readV2Css();
    const refusal = ruleBody(v2, '.v2-connector-row__refusal');
    expect(refusal).toContain('grid-column: 1 / -1');
    expect(refusal).toContain('overflow-wrap: anywhere');
  });
});

// ---------------------------------------------------------------------------
// Bring your own agent, onto Signal (TASK-166).
//
// Seven items from ux-lead's spec on the row, all of the same shape: something
// the artboard draws and the component does not. Ink acts (1), the chosen card
// is marked by a 2px border rather than the focus ring used as a halo (2), meta
// is mono 500 at 11px and lowercase (3, 4), radius 4 on controls and 6 on cards
// (5, 6), and the avatar is a 4px square with a cobalt live dot (7).
//
// Items 1–6 are presence lines. The reason they can be, rather than a cascade
// comparison: the mode card owns its button reset locally, while
// `button.v2-byo__submit` is rooted at `.v2-root`, so the low-specificity
// default at `v2.css:201` cannot override these declarations. The component
// keeps its visual treatment explicit rather than relying on reset order.
//
// Item 7 gets three assertions, because each of its failure modes is invisible
// to a presence line:
//   (a) the square must WIN over `.v2-avatar`'s `border-radius: 50%`. It does so
//       on specificity — (0,2,0) against (0,1,0) — with no help from document
//       order, and the guard compares specificity while proving BOTH rules were
//       read, since a comparison against an empty body asserts nothing.
//   (b) the rule must match something. All four `<V2Avatar` call sites on this
//       route sit inside the `.v2-byo__layout` element, and that containment is
//       tag-counted rather than found by the first `</div>`: the first close
//       after the opening tag ends `__main`, while the aside sits outside it.
//       A descendant selector whose carrier moves out of the block goes
//       silently dead, which is the TASK-160 shape (a rule that matches
//       nothing).
//   (c) neither new rule may overreach. The online dot keeps its own 50% radius,
//       and the pressed card must not declare a shadow — the focus ring is
//       `:focus-visible`'s (v2.css:383), and a ring on the pressed state is what
//       this item exists to remove.
// ---------------------------------------------------------------------------
describe('Bring your own agent onto Signal (TASK-166)', () => {
  const v2 = readV2Css();
  const byoCss = read('../components/V2AgentBYO.css');
  const byo = read('../components/V2AgentBYO.tsx');
  const en = read('../../i18n/locales/en.json');

  // `ruleBody` returns the block from the selector line onward, and these rules
  // carry comments of their own — both would otherwise be parsed as declarations
  // (the selector's `:hover` and the prose's colons each take the first ':' of
  // their fragment). So the selector prefix and comments come off first.
  const cssDeclarations = (body: string): Record<string, string> => {
    const open = body.indexOf('{');
    const inner = (open === -1 ? body : body.slice(open + 1))
      .replace(/\/\*[\s\S]*?\*\//g, '');
    const found: Record<string, string> = {};
    inner.split(';').forEach((entry) => {
      const at = entry.indexOf(':');
      if (at < 0) return;
      found[entry.slice(0, at).trim()] = entry.slice(at + 1).trim();
    });
    return found;
  };

  // Specificity as [ids, classes+attributes+pseudo-classes, elements]. Only the
  // item-7 selectors are asked about, so this walk stays simple: `:pseudo`
  // counts as a class, `::pseudo` does not, and an element is a name beginning a
  // compound. Floors, not a parser — the guard says which rule it ranks.
  const specificity = (selector: string): number[] => {
    const withoutPseudoElements = selector.replace(/::[a-z-]+/g, '');
    const ids = (withoutPseudoElements.match(/#[A-Za-z0-9_-]+/g) ?? []).length;
    const classes = (
      withoutPseudoElements.match(/\.[A-Za-z0-9_-]+|\[[^\]]+\]|:[a-z-]+/g) ?? []
    ).length;
    const elements = (
      withoutPseudoElements.match(/(?:^|[\s>+~])([a-z][A-Za-z0-9-]*)/g) ?? []
    ).length;
    return [ids, classes, elements];
  };

  const outranks = (a: number[], b: number[]): boolean => {
    for (let i = 0; i < 3; i += 1) {
      if (a[i] !== b[i]) return a[i] > b[i];
    }
    // A tie is resolved by document order in the sheet; the item-7 pair is not
    // a tie, and this guard would rather not claim to model the tie it does not
    // depend on.
    return false;
  };

  // R04 lifted the page onto the d215 frame (V2AgentBYO.css). The items below
  // keep guarding what they guarded, at the frame's values.
  test('controls keep hover feedback and selects keep the focus ring the frame does not draw', () => {
    expect(selectorRuleBody(byoCss, '.v2-feature--byo .v2-byo__mode:not([aria-pressed="true"]):hover, .v2-feature--byo .v2-byo__os .v2-byo__link:not([aria-pressed="true"]):not(:disabled):hover, .v2-feature--byo .v2-byo__secondary:hover'))
      .toContain('var(--v2-surface-hover)');
    expect(ruleBody(byoCss, '.v2-feature--byo .v2-byo__submit:hover:not(:disabled)')).toContain('var(--v2-ink-hover)');
    expect(ruleBody(byoCss, '.v2-feature--byo .v2-byo__copy:hover')).toContain('var(--v2-surface-hover)');
    expect(ruleBody(byoCss, '.v2-feature--byo select.v2-byo__input:focus-visible')).toContain('var(--v2-focus-ring)');
  });
  test('the submit button is the ink key, at radius 10 (item 1)', () => {
    const submit = cssDeclarations(ruleBody(byoCss, '.v2-feature--byo .v2-byo__submit'));
    expect(submit.background).toBe('linear-gradient(180deg, var(--v2-fill-a), var(--v2-fill-b))');
    expect(submit.color).toBe('var(--v2-on-fill)');
    expect(submit.border).toBe('1px solid var(--v2-fill-edge)');
    const shared = cssDeclarations(selectorRuleBody(byoCss, '.v2-feature--byo .v2-byo__submit, .v2-feature--byo .v2-byo__secondary'));
    expect(shared['border-radius']).toBe('10px');
    expect(shared.cursor).toBe('pointer');
    // The old rules left v2.css with the lift.
    expect(v2).not.toContain('button.v2-byo__submit');
  });

  test('the modes are one segment, the pressed option a raised key (item 2)', () => {
    const group = cssDeclarations(selectorRuleBody(byoCss, '.v2-feature--byo .v2-byo__modes, .v2-feature--byo .v2-byo__os'));
    expect(group.display).toBe('inline-flex');
    expect(group.background).toBe('var(--v2-surface-tint)');
    const base = cssDeclarations(selectorRuleBody(byoCss, '.v2-feature--byo .v2-byo__mode, .v2-feature--byo .v2-byo__os .v2-byo__link'));
    expect(base.height).toBe('28px');
    expect(base['border-radius']).toBe('7px');
    const pressed = cssDeclarations(
      selectorRuleBody(byoCss, '.v2-feature--byo .v2-byo__mode[aria-pressed="true"]'),
    );
    expect(pressed.background).toBe('var(--v2-surface)');
    expect(pressed['font-weight']).toBe('600');
    // (c) the pressed state is the key's edge, never the focus ring...
    expect(pressed['box-shadow']).toBe('0 0 0 1px var(--v2-key-edge), var(--v2-key-inset)');
    expect(pressed['box-shadow']).not.toContain('--v2-focus-ring');
    // ...and the focus ring still shows on a pressed option: the pressed rule
    // (0,3,0) outranks `.v2-root button:focus-visible` (0,2,1), so the page
    // restates the ring at the pressed rule's weight.
    expect(selectorRuleBody(byoCss, '.v2-feature--byo .v2-byo__mode:focus-visible'))
      .toContain('box-shadow: var(--v2-focus-ring)');
    expect(
      selectorRuleBody(v2, '.v2-root button:focus-visible'),
    ).toContain('box-shadow: var(--v2-focus-ring)');
  });

  test('the preview label is mono 500 with no caps transform (item 4)', () => {
    const label = cssDeclarations(selectorRuleBody(byoCss, '.v2-feature--byo .v2-byo__modes-question, .v2-feature--byo .v2-byo__preview-label'));
    expect(label.font).toBe('500 11.5px/1 var(--v2-font-mono)');
    expect(label['text-transform']).toBeUndefined();
    expect(label.color).toBe('var(--v2-text-muted)');
  });

  test('controls and cards take the frame radii (items 5 and 6)', () => {
    expect(cssDeclarations(ruleBody(byoCss, '.v2-feature--byo .v2-byo__input'))['border-radius']).toBe('9px');
    expect(cssDeclarations(ruleBody(byoCss, '.v2-feature--byo .v2-byo__preview-card'))['border-radius']).toBe('12px');
  });

  test('the BYO avatar wins its radius against the global round one (item 7a)', () => {
    const square = ruleBody(byoCss, '.v2-byo__layout .v2-avatar');
    const round = ruleBody(v2, '.v2-avatar');
    // Non-vacuity: both rules were read, and each declares the very property
    // being overridden. A specificity comparison against an empty body would
    // pass while .v2-avatar no longer sets a radius at all.
    expect(round).toContain('border-radius: 50%');
    expect(round).toContain('border: 2px solid var(--v2-surface)');
    expect(square).toContain('border-radius: 4px');
    expect(square).toContain('border: 0');
    expect(square).toContain('box-shadow: none');

    const qualified = specificity('.v2-byo__layout .v2-avatar');
    const bare = specificity('.v2-avatar');
    expect(outranks(qualified, bare)).toBe(true);
    // Named, so a future reader sees WHICH axis the winner comes from rather
    // than a bare `true`: equal ids and elements, one more class.
    expect({ qualified, bare }).toEqual({ qualified: [0, 2, 0], bare: [0, 1, 0] });
    // `--lg`/`--md` set size only; if one ever restates a radius, the square
    // stops applying at that size and this guard should be the thing that says so.
    expect(ruleBody(v2, '.v2-avatar--lg')).not.toContain('border-radius');
    expect(ruleBody(v2, '.v2-avatar--md')).not.toContain('border-radius');
  });

  test('the live dot is cobalt, and stays round (item 7b)', () => {
    const dot = cssDeclarations(ruleBody(byoCss, '.v2-byo__layout .v2-avatar__online'));
    const baseDot = ruleBody(v2, '.v2-avatar__online');
    // Non-vacuity: the base rule it overrides is read, and it is the green one.
    expect(baseDot).toContain('background: var(--v2-success)');
    expect(baseDot).toContain('border-radius: 50%');
    expect(dot.background).toBe('var(--v2-accent)');
    // (c) a square dot is invisible in a screenshot and would be a silent
    // regression, so the new rule may not touch the radius.
    expect(dot['border-radius']).toBeUndefined();
  });

  test('the square rule has every avatar on the route inside its carrier (item 7c)', () => {
    const open = byo.indexOf('<div className="v2-byo__layout">');
    expect(open).toBeGreaterThan(-1);
    const tag = /<div\b[^>]*>|<\/div>/g;
    tag.lastIndex = open;
    let depth = 0;
    let end = -1;
    for (let m = tag.exec(byo); m !== null; m = tag.exec(byo)) {
      if (m[0].startsWith('</')) {
        depth -= 1;
        if (depth === 0) { end = m.index + m[0].length; break; }
      } else if (!m[0].endsWith('/>')) {
        depth += 1;
      }
    }
    expect(end).toBeGreaterThan(open);
    const layout = byo.slice(open, end);
    const avatars = (src: string): number => (src.match(/<V2Avatar\b/g) ?? []).length;
    // Every avatar the route renders is inside the block the selector is scoped
    // to. Both directions are asserted: one outside the block would be a rule
    // that silently does not apply to it, and the route's whole population is
    // these four (persona context, the two result cards, the preview).
    expect(avatars(layout)).toBe(4);
    expect(avatars(byo)).toBe(4);
  });

  test('the preview label string is lowercase too (item 4, the third string)', () => {
    // ux-lead's #1897 gate: the spec lowercased three en strings and the build
    // caught two. The other two were CSS caps over sentence-case data; this
    // one was caps in the data itself, which is why nothing in the sheet moved.
    expect(en).toContain('"title": "your agent"');
    expect(en).not.toContain('"title": "Your agent"');
  });

  // R04: the frame draws the status as a chip beside the avatar, so the line
  // became a small ringed chip again. What the fold-in removed stays removed:
  // no success colour anywhere on it.
  test('the preview status is the frame chip, in mono (item 7 fold-in)', () => {
    const status = cssDeclarations(ruleBody(byoCss, '.v2-feature--byo .v2-byo__preview-status'));
    expect(status.font).toBe('500 11.5px/1 var(--v2-font-mono)');
    expect(status.color).toBe('var(--v2-text-secondary)');
    expect(status.display).toBe('inline-flex');
    expect(status.gap).toBe('6px');
    expect(status.height).toBe('24px');
    expect(status['border-radius']).toBe('7px');
    expect(status['box-shadow']).toBe('inset 0 0 0 1px var(--v2-border-soft)');
  });

  test('each preview status is its frame state, and the success colours are gone', () => {
    // not created yet: the bare dot is a hollow ring.
    const dot = cssDeclarations(ruleBody(byoCss, '.v2-feature--byo .v2-byo__preview-dot'));
    expect(dot['box-shadow']).toBe('inset 0 0 0 1.5px var(--v2-text-muted)');
    expect(dot.background).toBeUndefined();
    // waiting and starting: a filled grey dot, the same in both.
    const pending = cssDeclarations(selectorRuleBody(byoCss, '.v2-feature--byo .v2-byo__preview-status--waiting .v2-byo__preview-dot, .v2-feature--byo .v2-byo__preview-status--starting .v2-byo__preview-dot'));
    expect(pending.background).toBe('var(--v2-text-muted)');
    expect(pending['box-shadow']).toBe('none');
    // live: the cobalt chip and dot.
    const live = cssDeclarations(ruleBody(byoCss, '.v2-feature--byo .v2-byo__preview-status--live'));
    expect(live.color).toBe('var(--v2-accent-text)');
    expect(live.background).toBe('var(--v2-accent-soft)');
    expect(cssDeclarations(
      ruleBody(byoCss, '.v2-feature--byo .v2-byo__preview-status--live .v2-byo__preview-dot'),
    ).background).toBe('var(--v2-accent)');

    // The negative that says what the fold-in removed: no status colour
    // anywhere in the preview rules.
    expect(byoCss).not.toContain('.v2-byo__preview-note');
    const preview = byoCss.split('\n').filter((line) => line.includes('.v2-byo__preview')).join('\n');
    expect(preview).toContain('.v2-byo__preview-status--live');
    ['--v2-success', '--v2-warning', '--v2-surface-hover']
      .forEach((token) => expect(preview).not.toContain(token));

    // The three strings, in the data rather than via a transform — the same
    // reason the kicker's caps were fixed in en.json.
    expect(en).toContain('"draft": "not created yet"');
    expect(en).toContain('"starting": "starting…"');
    expect(en).toContain('"live": "listening"');
  });
});

// ---------------------------------------------------------------------------
// The rest of the BYO flow onto Signal (TASK-169).
//
// TASK-166 fixed the form; this is the same pass over the surfaces its gate did
// not reach — the after-submit lines, the persona/stat/error cards and the
// snippets. Values are ux-lead's, rendered at 1200 and 390 on #1897's head.
//
// Every item names the negative as well as the value, because each defect here
// was a colour, a stack or a card that could come back beside the new value —
// and a presence check on the new value cannot see that.
//
// Stated limit, as the block above: these read the sheet, not the render. The
// heights ux-lead measured (359.1/375.0 at 1200, 214.5/223.9 at 390) are a
// browser's answer and jsdom has no layout engine, so they are not asserted.
describe('the BYO after-submit surfaces onto Signal (TASK-169)', () => {
  const v2 = readV2Css();
  const byoCss = read('../components/V2AgentBYO.css');
  const byo = read('../components/V2AgentBYO.tsx');
  const en = read('../../i18n/locales/en.json');
  const zh = read('../../i18n/locales/zh-CN.json');

  const decls = (body: string): Record<string, string> => {
    const open = body.indexOf('{');
    const inner = (open === -1 ? body : body.slice(open + 1)).replace(/\/\*[\s\S]*?\*\//g, '');
    const out: Record<string, string> = {};
    inner.split(';').forEach((entry) => {
      const at = entry.indexOf(':');
      if (at < 0) return;
      out[entry.slice(0, at).trim()] = entry.slice(at + 1).trim();
    });
    return out;
  };

  // Bodies of every rule whose selector is on the byo route, comments removed,
  // from the page's own sheet and from v2.css (which should carry none now).
  // The comments describe the old values in words ('green', 'SF Mono'), so a
  // raw `toContain` over the sheet would fail on prose rather than on a rule.
  const byoRuleBodies = (): string[] => {
    const out: string[] = [];
    [byoCss, v2].forEach((css) => {
      const re = /([^{}]+)\{([^{}]*)\}/g;
      let m = re.exec(css);
      while (m) {
        const selector = m[1].replace(/\/\*[\s\S]*?\*\//g, '');
        if (selector.includes('.v2-byo__')) out.push(m[2].replace(/\/\*[\s\S]*?\*\//g, ''));
        m = re.exec(css);
      }
    });
    return out;
  };

  test('item 1: the live line is a cobalt dot, and green is gone from the route', () => {
    expect(decls(ruleBody(byoCss, '.v2-feature--byo .v2-byo__live::before')).background).toBe('var(--v2-accent)');
    expect(decls(selectorRuleBody(byoCss, '.v2-feature--byo [data-testid="byo-listen-waiting"]::before, .v2-feature--byo .v2-byo__live::before'))['border-radius']).toBe('50%');
    // The hex, not the word: #1e6b2a was the only green literal on the route.
    expect(byoRuleBodies().join('\n')).not.toContain('#1e6b2a');
    // memory-done keeps its name and loses its padding and its green.
    const done = decls(ruleBody(byoCss, '.v2-byo__memory-done'));
    expect(done.color).toBe('var(--v2-text-primary)');
    expect(done.padding).toBe('0');
    // The two live lines wear the new class; the memory line does not.
    expect(byo).toContain("hostedState === 'running' ? 'v2-byo__live'");
    expect(byo).toContain('className="v2-byo__live" data-testid="byo-listen-ok"');
    expect(byo).toContain('<p className="v2-byo__memory-done">');
    // A dot plus a ✓ marks the same line twice, so the ✓ left the copy. Named
    // keys, not a global scan: three other ✓ strings live outside this flow.
    expect(en).toContain('"running": "{{name}} is listening."');
    expect(en).toContain('"verified": "{{name}} is listening — mentions will wake it."');
    expect(en).toContain('"doneLead": "Memory imported —"');
    expect(zh).toContain('"running": "{{name}} 已在监听。"');
    expect(zh).toContain('"verified": "{{name}} 已在监听 —— @提及 会唤醒它。"');
    expect(zh).toContain('"doneLead": "记忆已导入——"');
  });

  test('item 2: stat cards are radius 6, and the counts are data in mono', () => {
    expect(decls(ruleBody(byoCss, '.v2-byo__stat'))['border-radius']).toBe('var(--v2-radius-lg)');
    expect(decls(ruleBody(byoCss, '.v2-byo__stat-value')).font).toBe('500 18px/24px var(--v2-font-mono)');
    // Mono at 11px is legal only because the family is named in the same rule,
    // which is also what let its type-floors allowlist entry leave that list.
    expect(decls(ruleBody(byoCss, '.v2-byo__stat-label')).font).toBe('500 11px/16px var(--v2-font-mono)');
  });

  test('item 3: the secondary button is a control, at the frame key radius', () => {
    expect(decls(selectorRuleBody(byoCss, '.v2-feature--byo .v2-byo__submit, .v2-feature--byo .v2-byo__secondary'))['border-radius'])
      .toBe('10px');
    expect(decls(ruleBody(byoCss, '.v2-feature--byo .v2-byo__secondary')).color).toBe('var(--v2-text-secondary)');
  });

  test('item 4: the persona card is a card, radius 6', () => {
    expect(decls(ruleBody(byoCss, '.v2-byo__persona'))['border-radius']).toBe('var(--v2-radius-lg)');
  });

  test('item 5: an error is a bordered white card, not a red fill', () => {
    const body = ruleBody(byoCss, '.v2-byo__error');
    const err = decls(body);
    expect(err.background).toBe('var(--v2-surface)');
    expect(err.border).toBe('1px solid var(--v2-border)');
    expect(err.color).toBe('var(--v2-text-primary)');
    expect(err['border-radius']).toBe('var(--v2-radius-lg)');
    ['#fee2e2', '#fca5a5', '#991b1b'].forEach((hex) => expect(body).not.toContain(hex));
  });

  test('item 6: commands are tinted blocks with Copy as a key on the block, and the cards are gone', () => {
    // R04 (d215 frame): the ink block became the light code block, and Copy a
    // key placed on its top-right corner; the padding keeps text clear of it.
    const command = decls(ruleBody(byoCss, '.v2-feature--byo .v2-byo__command'));
    expect(command.background).toBe('var(--v2-bg-subtle)');
    expect(command['border-radius']).toBe('12px');
    expect(command.position).toBe('relative');
    expect(command.padding).toBe('12px 96px 12px 14px');
    const copy = decls(ruleBody(byoCss, '.v2-feature--byo .v2-byo__copy'));
    expect(copy.background).toBe('linear-gradient(180deg, var(--v2-key-a), var(--v2-key-b))');
    expect(copy.color).toBe('var(--v2-text-primary)');
    expect(copy.position).toBe('absolute');
    expect(decls(ruleBody(byoCss, '.v2-feature--byo .v2-byo__pre')).color).toBe('var(--v2-text-primary)');
    // The add-computer row is not drawn in the frame and keeps its ink block,
    // with its Copy kept in the row's own column.
    expect(decls(ruleBody(byoCss, '.v2-byo__add-computer-row')).background).toBe('var(--v2-ink)');
    expect(decls(ruleBody(byoCss, '.v2-feature--byo .v2-byo__add-computer-row .v2-byo__copy')).position).toBe('static');
    const addComputer = decls(ruleBody(byoCss, '.v2-byo__add-computer'));
    expect(addComputer['border-radius']).toBe('var(--v2-radius-lg)');
    expect(addComputer.background).toBe('var(--v2-bg-subtle)');
    // Each snippet is a flat section, not a card.
    const snippet = decls(selectorRuleBody(byoCss, '.v2-feature--byo .v2-byo__form, .v2-feature--byo .v2-byo__result, .v2-feature--byo .v2-byo__snippet'));
    expect(snippet.display).toBe('flex');
    expect(snippet.border).toBeUndefined();
    expect(snippet.background).toBeUndefined();
    // Copy left the head, and the head is a label: five heads, no button in any.
    const heads = byo.match(/<div className="v2-byo__snippet-head">[\s\S]*?<\/div>/g) ?? [];
    expect(heads).toHaveLength(5);
    heads.forEach((head) => expect(head).not.toContain('v2-byo__copy'));
  });

  test('item 7: the mono stack is the token, and the textarea outranks the shell', () => {
    expect(decls(ruleBody(byoCss, '.v2-root textarea.v2-byo__memory-text'))['font-family'])
      .toBe('var(--v2-font-mono)');
    // Why the element is in the selector: `.v2-root textarea` inherits the
    // family and outranks a lone class, so the old stack never applied at all.
    expect(v2).toContain('.v2-root textarea {');
    expect(decls(ruleBody(byoCss, '.v2-byo__footnote code'))['font-family']).toBe('var(--v2-font-mono)');
    expect(decls(ruleBody(byoCss, '.v2-byo__layout code'))['font-family']).toBe('var(--v2-font-mono)');
    const bodies = byoRuleBodies().join('\n');
    expect(bodies).not.toContain('SF Mono');
    expect(bodies).not.toContain('ui-monospace');
  });

  test('item 8: the agent name in a result heading is mono in cobalt', () => {
    // The connect command's heading is the frame's; the two result-card
    // headings (not drawn yet) keep the old rule.
    const drawn = decls(ruleBody(byoCss, '.v2-feature--byo .v2-byo__result > h2 code'));
    expect(drawn.font).toBe('600 15px/1 var(--v2-font-mono)');
    expect(drawn.color).toBe('var(--v2-accent-text)');
    const kept = decls(ruleBody(byoCss, '.v2-byo__result h2 code'));
    expect(kept['font-family']).toBe('var(--v2-font-mono)');
    expect(kept.color).toBe('var(--v2-accent-text)');
    // The three headings it covers, so it is not styling a name that left.
    expect(byo.match(/<h2>[^<]*<code>\{/g) ?? []).toHaveLength(3);
  });

  test('the fourth preview state: waiting, once a token is issued and nothing has checked in', () => {
    // waiting shares starting's filled grey dot; draft is the bare hollow ring.
    const waiting = decls(selectorRuleBody(byoCss, '.v2-feature--byo .v2-byo__preview-status--waiting .v2-byo__preview-dot'));
    expect(waiting.background).toBe('var(--v2-text-muted)');
    // The rail said "not created yet" while the page beside it said the install
    // had succeeded; that is the state this adds.
    expect(en).toContain('"waiting": "not listening yet"');
    expect(zh).toContain('"waiting": "尚未监听"');
    expect(byo).toContain("const previewStatus: 'draft' | 'waiting' | 'starting' | 'live'");
    expect(byo).toContain("return listenState === 'listening' ? 'live' : 'waiting';");
    // zh said the line would turn into a checkmark, and there is no checkmark.
    expect(zh).not.toContain('变成对勾');
  });

  test('phone: Copy is a full-width 44px key, and the layout adds no side padding', () => {
    const phone = mediaBlockContaining(byoCss, '.v2-feature--byo .v2-byo__copy');
    expect(phone).toContain('.v2-feature--byo .v2-byo__copy { position: static; width: 100%; height: 44px;');
    // The shell already pads at this width; the page's own layout adds none.
    const layout = decls(ruleBody(byoCss, '.v2-feature--byo .v2-byo__layout'));
    expect(layout.padding).toBeUndefined();
    expect(layout['padding-left']).toBeUndefined();
  });

  test('the render gate: result paragraphs add no margin to the frame gap', () => {
    // A paragraph's user-agent margin does not collapse inside a flex column,
    // so an authored gap draws as gap + 1em unless the paragraph is zeroed.
    //
    // The `>` is the scope, and what it buys is the NEXT paragraph, not today's:
    // a paragraph added later inside some OTHER wrapper in a result keeps its
    // own rhythm, where the descendant form would zero it silently. That is why
    // the descendant form is the negative rather than the value.
    expect(decls(ruleBody(byoCss, '.v2-byo__result > p')).margin).toBe('0');
    expect(byoCss).not.toMatch(/\.v2-byo__result p\s*\{/);
    expect(decls(ruleBody(byoCss, '.v2-byo__memory > p')).margin).toBe('0');
    expect(decls(ruleBody(byoCss, '.v2-byo__result h2')).margin).toBe('0');
    // The frame's rhythm: one 10px gap through the form and the result.
    expect(decls(selectorRuleBody(byoCss, '.v2-feature--byo .v2-byo__form, .v2-feature--byo .v2-byo__result, .v2-feature--byo .v2-byo__snippet')).gap).toBe('10px');
    // The live and waiting lines are one status row, 44px tall, dot centred.
    const line = decls(selectorRuleBody(byoCss, '.v2-feature--byo [data-testid="byo-listen-waiting"], .v2-feature--byo .v2-byo__live'));
    expect(line['min-height']).toBe('44px');
    expect(line['align-items']).toBe('center');
  });
});

// ---------------------------------------------------------------------------
// The authenticated shell's height chain (TASK-157).
//
// Both defects this block covers are cascade outcomes, not missing text: the
// desktop one is the content div auto-placing into the `auto` banner row instead
// of the `1fr` row, and the phone one is a 0,2,0 `height: 100vh` sitting LATER in
// the sheet than every 0,2,0 `height: 100%` that should bound it. Presence cannot
// see either — `not.toContain('100vh')` passes while a duplicate rule at EOF
// repaints the phone, and `toContain('grid-row: 2')` passes while a later rule
// resets it to auto. So this block parses the sheet into rules carrying their
// at-rule context, specificity and document order, and asserts on the WINNER of
// the small cascade it can resolve — the same move as the #1868 specificity
// comparison, one level up. (ux-lead measured the defect in a browser at 390 and
// 1200; jsdom has no layout engine, so what is pinned here is the cascade, never
// the rendered box.)
//
// Stated limits, so the next reader does not over-read this: the parser handles
// simple selectors, max-/min-width conditions, and the `height` / `grid-row`
// declarations asserted on. It does not resolve percentages against containing
// blocks or model cascade layers/origins, and treats unmodelled media features
// (hover, prefers-reduced-motion) as applying — the conservative direction for a
// guard whose job is to catch a rule that WINS. The chain matcher at the end of
// this block walks the descendant axis for class-only compounds, and treats `>`
// as descendant; every chain it is asked about is single-child, so the two agree.
describe('the authenticated shell keeps its panes inside the banner row (TASK-157)', () => {
  const v2 = readV2Css();

  type ParsedRule = {
    selector: string;
    body: string;
    media: string[];
    order: number;
    classes: string[];
    specificity: number[];
  };

  const stripComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '');

  const classTokens = (compound: string): string[] => (
    compound.match(/\.[A-Za-z0-9_-]+/g) ?? []
  ).map((token) => token.slice(1));

  const lastCompound = (selector: string): string => (
    selector.split(/\s+|>/).filter(Boolean).pop() ?? ''
  );

  // (ids, classes/attributes/pseudo-classes, elements). Enough for this sheet:
  // the rules in dispute are 0,1,0 / 0,2,0 / 0,3,0. Importance is ranked
  // separately, per declaration, before specificity.
  const specificityOf = (selector: string): number[] => {
    const ids = (selector.match(/#[A-Za-z0-9_-]+/g) ?? []).length;
    const classes = (selector.match(/\.[A-Za-z0-9_-]+/g) ?? []).length
      + (selector.match(/\[[^\]]*\]/g) ?? []).length
      + ((selector.match(/:(?!:)[a-z-]+/g) ?? []).length);
    const elements = (selector
      .replace(/::?[a-z-]+(\([^)]*\))?/g, ' ')
      .replace(/[.#][A-Za-z0-9_-]+/g, ' ')
      .replace(/\[[^\]]*\]/g, ' ')
      .match(/\b[a-z][a-z0-9-]*\b/g) ?? []).length;
    return [ids, classes, elements];
  };

  const parseCascade = (css: string): ParsedRule[] => {
    const rules: ParsedRule[] = [];
    let order = 0;
    const walk = (text: string, media: string[]): void => {
      let i = 0;
      while (i < text.length) {
        const open = text.indexOf('{', i);
        if (open < 0) return;
        const head = text.slice(i, open).trim();
        let depth = 1;
        let j = open + 1;
        while (j < text.length && depth > 0) {
          if (text[j] === '{') depth += 1;
          else if (text[j] === '}') depth -= 1;
          j += 1;
        }
        const inner = text.slice(open + 1, j - 1);
        if (head.startsWith('@')) {
          walk(inner, media.concat([head]));
        } else {
          const parts = head.split(',');
          let p = 0;
          while (p < parts.length) {
            const selector = parts[p].trim();
            if (selector) {
              rules.push({
                selector,
                body: inner,
                media,
                order,
                classes: classTokens(lastCompound(selector)),
                specificity: specificityOf(selector),
              });
              order += 1;
            }
            p += 1;
          }
        }
        i = j;
      }
    };
    walk(stripComments(css), []);
    return rules;
  };

  type Declaration = { value: string; important: boolean };
  const parsedDeclarations = (body: string): Record<string, Declaration> => {
    const found: Record<string, Declaration> = {};
    body.split(';').forEach((entry) => {
      const at = entry.indexOf(':');
      if (at < 0) return;
      const property = entry.slice(0, at).trim();
      const raw = entry.slice(at + 1).trim();
      const important = /!\s*important\s*$/i.test(raw);
      const value = raw.replace(/!\s*important\s*$/i, '').trim();
      const put = (key: string, next: string): void => {
        if (!found[key]?.important || important) found[key] = { value: next, important };
      };
      put(property, value);
      // Expand the one shorthand this guard resolves at declaration time, so
      // longhand/shorthand importance and source order agree within a block.
      if (property === 'padding') {
        const parts = value.split(/\s+/).filter(Boolean);
        const bottomIndex: Record<number, number> = { 1: 0, 2: 0, 3: 2, 4: 2 };
        if (bottomIndex[parts.length] !== undefined) put('padding-bottom', parts[bottomIndex[parts.length]]);
      }
    });
    return found;
  };
  const declarations = (body: string): Record<string, string> => Object.fromEntries(
    Object.entries(parsedDeclarations(body)).map(([key, declaration]) => [key, declaration.value]),
  );

  // A rule applies at a width unless an at-rule it sits inside rules that width
  // out. Conditions the guard does not model are treated as applying.
  const appliesAt = (rule: ParsedRule, width: number): boolean => rule.media.every((at) => {
    const max = at.match(/max-width:\s*(\d+)px/);
    const min = at.match(/min-width:\s*(\d+)px/);
    if (max && width > Number(max[1])) return false;
    if (min && width < Number(min[1])) return false;
    return true;
  });

  const outranks = (a: ParsedRule, b: ParsedRule, property: string): boolean => {
    const aImportant = parsedDeclarations(a.body)[property]?.important ?? false;
    const bImportant = parsedDeclarations(b.body)[property]?.important ?? false;
    if (aImportant !== bImportant) return aImportant;
    for (let i = 0; i < 3; i += 1) {
      if (a.specificity[i] !== b.specificity[i]) return a.specificity[i] > b.specificity[i];
    }
    return a.order > b.order;
  };

  const winnerOf = (rules: ParsedRule[], property: string): ParsedRule => rules.reduce(
    (best, rule) => (outranks(rule, best, property) ? rule : best),
  );

  test('importance is parsed and outranks specificity/order for the property being resolved (TASK-158)', () => {
    const fixture = parseCascade(`
      .v2-pane { height: 100vh ! IMPORTANT; grid-row: 1; }
      .v2-root .v2-shell .v2-pane { height: 100%; grid-row: 2; }
    `);
    expect(parsedDeclarations(fixture[0].body).height).toEqual({ value: '100vh', important: true });
    expect(winnerOf(fixture, 'height').selector).toBe('.v2-pane');
    expect(winnerOf(fixture, 'grid-row').selector).toBe('.v2-root .v2-shell .v2-pane');
    const equal = parseCascade(`
      .v2-shell .v2-pane { height: 90vh !important; }
      .v2-pane { height: 100vh !important; }
      .v2-shell .v2-pane { height: 80vh !important; }
    `);
    expect(winnerOf(equal.slice(0, 2), 'height').order).toBe(0);
    expect(winnerOf(equal, 'height').order).toBe(2);
    expect(parsedDeclarations('height: 100vh !important; height: 100%;').height.value).toBe('100vh');
    expect(parsedDeclarations('padding-bottom: 56px !important; padding: 0;')['padding-bottom'].value).toBe('56px');
    expect(parsedDeclarations('padding: 0 !important; padding-bottom: 56px;')['padding-bottom'].value).toBe('0');
  });

  const rules = parseCascade(v2);

  // The main content pane is rendered as `class="v2-pane v2-pane--main"`, so a
  // rule can only match it if its last compound requires no other class.
  const MAIN_PANE = new Set(['v2-pane', 'v2-pane--main']);
  const mainPaneRules = rules.filter((rule) => rule.classes.length > 0
    && rule.classes.every((token) => MAIN_PANE.has(token)));

  const BOUNDED_PANE_SELECTOR = '.v2-authenticated-shell__content .v2-shell .v2-pane';

  test('the authenticated content always takes the shell\'s second grid row', () => {
    const contentRules = rules.filter(
      (rule) => rule.classes.includes('v2-authenticated-shell__content')
        && declarations(rule.body)['grid-row'] !== undefined,
    );
    // Non-vacuity: the assertions below are about a winner, and a winner chosen
    // from an empty set asserts nothing.
    expect(contentRules.length).toBeGreaterThan(0);
    const winner = winnerOf(contentRules, 'grid-row');
    expect(declarations(winner.body)['grid-row']).toBe('2');
    expect(winner.selector).toContain('v2-authenticated-shell__content');
  });

  test('no pane of the authenticated shell takes the viewport height on a phone', () => {
    const atPhone = mainPaneRules.filter((rule) => declarations(rule.body)['height'] !== undefined
      && appliesAt(rule, 390));
    const viewportHeight = atPhone.filter(
      (rule) => /^100(?:\.0)?(?:vh|dvh|svh)$/.test(declarations(rule.body)['height']),
    );
    const bounded = atPhone.filter((rule) => declarations(rule.body)['height'] === '100%');
    // Non-vacuity, both directions: a filter shaped "every 100vh rule is outranked"
    // passes loudest when no 100vh rule is found, and a fix that deleted the
    // bounding rule would otherwise pass by having nothing to compare.
    expect(viewportHeight.length).toBeGreaterThan(0);
    expect(bounded.length).toBeGreaterThan(0);

    viewportHeight.forEach((rule) => {
      const dominator = bounded.find((candidate) => outranks(candidate, rule, 'height'));
      // Named, not counted: a bare `dominated: false` reports that something is
      // wrong without saying which rule now wins the phone.
      expect({
        selector: rule.selector,
        height: declarations(rule.body)['height'],
        outrankedBy: dominator ? dominator.selector : null,
      }).toEqual({
        selector: rule.selector,
        height: declarations(rule.body)['height'],
        outrankedBy: expect.any(String),
      });
    });

    const winner = winnerOf(atPhone, 'height');
    expect(declarations(winner.body)['height']).toBe('100%');
    expect(winner.selector).toBe(BOUNDED_PANE_SELECTOR);
  });

  test('the bounded pane rule stays a phone rule', () => {
    // It must not apply at desktop, where the pane keeps its 16px gutter
    // (`.v2-authenticated-shell .v2-pane--main { height: calc(100% - 16px) }`).
    //
    // Stated on purpose: this requires the SPECIFICITY-scoped form, not merely a
    // rule that happens to win. A same-specificity `.v2-shell .v2-pane {
    // height: 100% }` added after the 100vh rule also bounds the phone today —
    // and is the shape that has failed twice here, because the next rule written
    // later takes the width back. Measured as m7 in the mutation campaign: it reds
    // this pair deliberately.
    const scoped = rules.filter((rule) => rule.selector === BOUNDED_PANE_SELECTOR);
    expect(scoped.length).toBeGreaterThan(0);
    expect(scoped.filter((rule) => appliesAt(rule, 390)).length).toBeGreaterThan(0);
    expect(scoped.filter((rule) => appliesAt(rule, 1200))).toHaveLength(0);
  });

  test('the selectors this guard ranks are the ones the components render', () => {
    // The chain the winning selector walks: content div > shell > pane. Checked
    // against the components so the guard cannot pass on a chain the app does
    // not build.
    expect(read('../V2App.tsx')).toContain('v2-authenticated-shell__content');
    expect(read('../components/V2Layout.tsx')).toContain("'v2-shell'");
    expect(read('../components/V2Thread.tsx')).toContain('"v2-pane v2-pane--main"');
    expect(read('../components/V2FeaturePage.tsx')).toContain('v2-pane v2-pane--main');
  });

  // ---- the phone pods list: the tab bar has to stay reachable -----------------
  //
  // ux-lead's design gate failed the first head here (390, `/v2`, verified user):
  // 0 of 4 tabs hit-testable, on a short list and a long one. The height chain
  // asserted above is still true under the fix — the aside is still `100%` —
  // because what changed is the BOX that percentage resolves against, and the
  // aside's stacking. So the same parser is asked two different questions: what
  // wins `padding-bottom` on the list shell, and what wins `z-index` on the list
  // aside. Neither is visible to a presence check.

  // Chain matching checks the known rendered family only. It must never
  // decide cascade membership: an unlisted ancestor can still match the app.
  const MODELABLE_COMPOUND = /^[A-Za-z0-9_.-]+$/;

  // Outermost first; each entry is the class set of one rendered element.
  const LIST_CHAIN = [
    ['v2-authenticated-shell__content'],
    ['v2-shell', 'v2-shell--list'],
    ['v2-pane', 'v2-pods-aside', 'v2-pods-aside--page'],
  ];
  const TAB_BAR = [['v2-mobile-tabs']];

  const matchesChain = (selector: string, chain: string[][]): boolean => {
    const compounds = selector.split(/\s*>\s*|\s+/).filter(Boolean);
    if (compounds.length === 0 || !compounds.every((c) => MODELABLE_COMPOUND.test(c))) {
      return false;
    }
    let from = 0;
    let i = 0;
    while (i < compounds.length) {
      const wanted = classTokens(compounds[i]);
      let found = -1;
      let j = from;
      while (j < chain.length) {
        const rendered = chain[j];
        let all = true;
        let k = 0;
        while (k < wanted.length) {
          if (!rendered.includes(wanted[k])) { all = false; break; }
          k += 1;
        }
        if (all) { found = j; break; }
        j += 1;
      }
      if (found < 0) return false;
      from = found + 1;
      i += 1;
    }
    return true;
  };

  const LIST_SHELL = ['v2-shell', 'v2-shell--list'];
  const LIST_ASIDE = ['v2-pane', 'v2-pods-aside', 'v2-pods-aside--page'];
  // Conservative, like MAIN_PANE above: rank every rule whose target compound
  // can bind to this element, regardless of ancestors we cannot place. This
  // can over-include rules from another subtree; it cannot silently drop a
  // real competitor just because LIST_CHAIN omits its ancestor (TASK-160).
  const targetRules = (source: ParsedRule[], target: string[], width: number): ParsedRule[] => source.filter(
    (rule) => appliesAt(rule, width) && rule.classes.length > 0
      && rule.classes.every((token) => target.includes(token)),
  );

  test('list candidates retain competitors with ancestors outside the known chain (TASK-160)', () => {
    const fixture = parseCascade(`
      .v2-shell.v2-shell--list { padding-bottom: 56px; }
      .v2-root .v2-shell--list { padding: 0; }
      .v2-shell--list .v2-pods-aside--page { z-index: auto; }
      .v2-root .v2-shell--list .v2-pods-aside--page { z-index: 60; }
      .elsewhere { padding: 999px; z-index: 999; }
      @media (min-width: 761px) { .v2-shell--list { padding: 999px; } }
    `);
    expect(matchesChain(fixture[1].selector, LIST_CHAIN)).toBe(false);
    expect(matchesChain(fixture[3].selector, LIST_CHAIN)).toBe(false);
    const shell = targetRules(fixture, LIST_SHELL, 390);
    const aside = targetRules(fixture, LIST_ASIDE, 390);
    expect(shell.map((rule) => rule.order)).toEqual([0, 1]);
    expect(aside.map((rule) => rule.order)).toEqual([2, 3]);
    expect(winnerOf(shell, 'padding-bottom').selector).toBe('.v2-root .v2-shell--list');
    expect(declarations(winnerOf(shell, 'padding-bottom').body)['padding-bottom']).toBe('0');
    expect(declarations(winnerOf(aside, 'z-index').body)['z-index']).toBe('60');
  });

  test.each([
    { marker: 'v2-shell--list', target: LIST_SHELL, property: 'padding-bottom' },
    { marker: 'v2-pods-aside--page', target: LIST_ASIDE, property: 'z-index' },
  ])('every parsed phone $marker $property competitor reaches the candidate set', ({ marker, target, property }) => {
    const candidates = targetRules(rules, target, 390);
    const competitors = rules.filter((rule) => appliesAt(rule, 390)
      && classTokens(lastCompound(rule.selector)).includes(marker)
      && declarations(rule.body)[property] !== undefined);
    expect(competitors.length).toBeGreaterThan(0);
    // Named omissions make a newly introduced target class actionable rather
    // than silently narrowing the model. Coverage is of parsed rules only.
    expect(competitors.filter((rule) => !candidates.includes(rule)).map((rule) => rule.selector)).toEqual([]);
  });

  // `padding-bottom`, or the `padding` shorthand it may be written as. A guard
  // that read only the longhand would pass while the shorthand took the space
  // back — and the shorthand is how this rule is written.
  const bottomPadding = (body: string): string | undefined => declarations(body)['padding-bottom'];

  test('the phone list reserves the tab bar\'s own height inside its box', () => {
    const shellRules = targetRules(rules, LIST_SHELL, 390)
      .filter((rule) => bottomPadding(rule.body) !== undefined);
    // Non-vacuity, both parts: a winner of an empty set asserts nothing, and the
    // specificity claim below needs a one-class competitor to be about.
    expect(shellRules.length).toBeGreaterThan(1);
    const oneClass = shellRules.filter((rule) => rule.specificity[1] <= 1);
    expect(oneClass.length).toBeGreaterThan(0);

    const barRules = targetRules(rules, TAB_BAR[0], 390)
      .filter((rule) => declarations(rule.body)['height'] !== undefined);
    expect(barRules.length).toBeGreaterThan(0);
    const barHeight = declarations(winnerOf(barRules, 'height').body)['height'];

    const winner = winnerOf(shellRules, 'padding-bottom');
    // Derived, not restated: the reserved space must equal the bar it reserves,
    // so a bar that grows reds this without anyone editing two numbers.
    expect(bottomPadding(winner.body)).toBe(barHeight);
    expect(bottomPadding(winner.body)).toMatch(/^[1-9]\d*px$/);
    // …and it has to win on SPECIFICITY rather than on coming later. A one-class
    // rule of the same name below it takes the padding back — the shape that has
    // failed twice in this sheet, and why ux-lead's spec asks for the two-class
    // selector. Mutation m4 reds this line and only this line.
    expect(winner.specificity[1]).toBeGreaterThan(winnerOf(oneClass, 'padding-bottom').specificity[1]);
  });

  test('the list aside does not stack over the tab bar', () => {
    const asideRules = targetRules(rules, LIST_ASIDE, 390)
      .filter((rule) => declarations(rule.body)['z-index'] !== undefined);
    // Non-vacuity: the reset needs something to beat. The drawer rule that
    // stacks the aside at 60 must be in the set, or this ranks a winner among
    // rules that never disagreed.
    expect(asideRules.length).toBeGreaterThan(1);
    expect(asideRules.map((rule) => declarations(rule.body)['z-index'])).toContain('60');

    const barRules = targetRules(rules, TAB_BAR[0], 390)
      .filter((rule) => declarations(rule.body)['z-index'] !== undefined);
    expect(barRules.length).toBeGreaterThan(0);
    const barZ = Number(declarations(winnerOf(barRules, 'z-index').body)['z-index']);
    expect(Number.isNaN(barZ)).toBe(false);

    const aside = winnerOf(asideRules, 'z-index');
    const z = declarations(aside.body)['z-index'];
    // `auto` never forms a stacking context; any number at or above the bar's own
    // z-index paints over it. The bar is fixed, so being under it in paint order
    // is the whole of being tappable.
    const stacks = z !== 'auto' && Number(z) >= barZ;
    // Named, not boolean: a bare `stacks: true` says something is wrong without
    // saying which rule now wins the list.
    expect({ selector: aside.selector, z, stacks }).toEqual({
      selector: aside.selector, z, stacks: false,
    });
  });

  test('the list chain this guard ranks is the chain the components render', () => {
    const layout = read('../components/V2Layout.tsx');
    expect(layout).toContain('v2-shell v2-shell--list');
    expect(matchesChain('.v2-shell.v2-shell--list', LIST_CHAIN)).toBe(true);
    expect(matchesChain('.v2-shell--list .v2-pods-aside--page', LIST_CHAIN)).toBe(true);
    expect(layout).toContain('<V2MobileTabs');
    expect(read('../components/V2PodsSidebar.tsx')).toContain("' v2-pods-aside--page'");
  });

});

// TASK-167 row A (TASK-192). The hero moved onto Signal: cobalt as a BLOCK on
// the front door, one 1312 measure shared by the page and the product, and a
// bar that is part of the band until the band ends. Most assertions below are
// pairings, because the failure mode for these is two rules drifting apart
// rather than a rule going missing.
describe('TASK-167 row A — the landing hero onto Signal', () => {
  const landing = read('../landing/v2-landing.css');
  const landingTsx = read('../landing/V2LandingPage.tsx');
  const landingEn = read('../../i18n/locales/en.json');

  test('one measure: 1312 on the page and on the product frame inside it', () => {
    // The frame padding is the page's measure, so it is asserted as a PAIR of
    // declarations: the left/right pair drifting apart is how a centred column
    // silently becomes an off-centre one.
    const frameStart = landing.indexOf('.v2-landing__bar,');
    const frameBody = landing.slice(
      landing.indexOf('{', frameStart),
      landing.indexOf('}', landing.indexOf('{', frameStart)),
    );
    expect(frameBody).toContain('padding-left: max(24px, calc((100% - 1312px) / 2))');
    expect(frameBody).toContain('padding-right: max(24px, calc((100% - 1312px) / 2))');
    // ...and no section keeps the old 1120 cap, or the page has two measures
    // and which one wins depends on the section.
    expect(landing).not.toContain('1120');
  });

  test('the band is a block of cobalt with the demo half on it', () => {
    const hero = selectorRuleBody(landing, '.v2-landing__hero {');
    expect(hero).toContain('background: #1d3fd1');
    expect(hero).toContain('padding-top: 72px');
    expect(hero).toContain('padding-bottom: 376px');
    // The overlap is a pair: 376 of band padding against a 360 pull-up leaves
    // the 16px the caption sits in. 196/180 is the same relationship at ≤760,
    // and either half moving alone moves the caption.
    expect(selectorRuleBody(landing, '.v2-landing__hero-art {')).toContain('margin-top: -360px');
    const phone = mediaAt(landing, '@media (max-width: 760px) {');
    expect(phone).toContain('.v2-landing__hero { padding-bottom: 196px; }');
    expect(phone).toContain('.v2-landing__hero-art { margin-top: -180px; }');
  });

  test('the frame is the band\'s sibling, so the pull-up measures from the band', () => {
    // ux-lead's gate at 532f38bb: as a child of the band, -360 was measured from
    // the last control and laid the demo over the title, both CTAs and the
    // install box — every control's hit test returned a demo node at 1440/1200.
    const sectionEnd = landingTsx.indexOf('</section>', landingTsx.indexOf('v2-landing__hero"'));
    expect(sectionEnd).toBeGreaterThan(-1);
    expect(landingTsx.indexOf('v2-landing__hero-art')).toBeGreaterThan(sectionEnd);
    // The caption stays in the band, as its last child, above the frame; the
    // frame carries the label and points at it by id, since a figure can no
    // longer hold both.
    const cap = landingTsx.indexOf('v2-landing__demo-cap');
    expect(cap).toBeGreaterThan(landingTsx.indexOf('v2-landing__hero-inner'));
    expect(cap).toBeLessThan(sectionEnd);
    expect(landingTsx).toContain('aria-describedby="v2-landing-demo-caption"');
    // A frame outside the band carries the page measure itself.
    expect(landing).toContain('.v2-landing__hero-art,\n.v2-landing__trusted,');
    // The 94 below the frame is the board's gap between the frame container
    // (456 − 360) and the strip, and row B landed it as the strip's own
    // `margin-top` — outside its top hairline, where the board draws it. As top
    // padding the gap fell inside the hairline, which then sat on the frame's
    // bottom edge (ux-lead's #2019 finding 1). Both halves are pinned: the
    // declaration that now carries the gap, and the one whose return is the
    // defect.
    const phone = mediaAt(landing, '@media (max-width: 760px) {');
    expect(phone).toContain('.v2-landing__hero-art { margin-top: -180px; }');
    const trusted = selectorRuleBody(landing, '.v2-landing__trusted {');
    expect(trusted).toContain('margin-top: 94px');
    expect(trusted).not.toContain('padding-top: 94px');
  });

  test('the copy column is uncapped, and the title is uncapped inside it', () => {
    // 288 + 24 + 784 = 1096 wrapped the install box at 1440 and 1200 while the
    // inner was capped at 1000 (ux-lead's #2018 finding 3). The hero title is
    // uncapped so "One pod for your team and" stays on one line at 1440; the
    // hero column is the cap.
    expect(selectorRuleBody(landing, '.v2-landing__hero-inner {')).not.toContain('max-width');
    expect(selectorRuleBody(landing, '.v2-landing__title {')).toContain('max-width: none');
    expect(selectorRuleBody(landing, '.v2-landing__lede {')).toContain('max-width: 780px');
  });

  test('the hero CTA is white on cobalt; the bar\'s stays primary on white', () => {
    // --primary measured cobalt on cobalt: only the label showed (finding 2).
    expect(landingTsx).toContain('v2-landing__btn v2-landing__btn--onaccent" to={appHref}>{primaryLabel}');
    // Row E joins these two rules with the CTA band's own buttons, so the
    // selector list's tail is optional rather than one literal line.
    expect(landing).toMatch(
      /\.v2-landing__hero-actions \.v2-landing__btn--onaccent(?:,\n\.v2-landing__cta \.v2-landing__btn--primary)? \{ padding: 0 26px; font-weight: 700; \}/,
    );
    const small = mediaAt(landing, '@media (max-width: 680px) {');
    expect(small).toMatch(
      /\.v2-landing__hero-actions \.v2-landing__btn--onaccent(?:,\n  \.v2-landing__cta \.v2-landing__btn--primary)? \{ padding: 0 20px; font-size: 16px; \}/,
    );
    expect(small).toContain('.v2-landing__hero-actions .v2-landing__btn--onaccent-ghost { padding: 0 18px; font-size: 16px; }');
    // The bar CTA sits on the page's white ground and keeps the fill.
    expect(landingTsx).toContain('v2-landing__btn v2-landing__btn--primary v2-landing__btn--sm" to={appHref}');
  });

  test('the bar switch is measured from the bar rather than hard-coded', () => {
    // 8px early at ≤680, where the bar is 64 (finding 8).
    expect(landingTsx).toContain('rootMargin: `-${barHeight || 72}px 0px 0px 0px`');
    expect(landingTsx).toContain("window.addEventListener('resize', measure)");
  });

  test('the scroller is the containing block for the demo\'s sr-only node', () => {
    // Without it `.v2-demo__sr` resolved against the document and a
    // wheel-overscroll at the footer scrolled the window 401px (finding 9).
    expect(selectorRuleBody(landing, '.v2-root.v2-landing {')).toContain('position: relative');
  });

  test('the bar is cobalt on the band and white past it, wordmark only', () => {
    const band = selectorRuleBody(landing, '.v2-landing__bar--band {');
    expect(band).toContain('background: #1d3fd1');
    expect(band).toContain('backdrop-filter: none');
    expect(band).toContain('border-bottom-color: rgba(255, 255, 255, 0.22)');
    // The state starts ON in the component, so first paint is the band state
    // and there is no white flash before the observer runs.
    expect(landingTsx).toContain('const [onBand, setOnBand] = useState(true)');
    expect(landingTsx).toContain("v2-landing__bar--band' : ''");
    // The test stub's `observe()` never calls back, so every render test stays
    // on the band: the switch is a browser check. (The stub's existence is why
    // the reason is that and not "jsdom has no IntersectionObserver".)
    expect(landingTsx).toContain("typeof IntersectionObserver === 'undefined'");
    // Wordmark only in the bar. (Row E removed the glyph mark entirely, so the
    // bar assertion below is now a claim about a page that has no mark at all —
    // the row E pins assert that.)
    const bar = landingTsx.slice(landingTsx.indexOf('v2-landing__bar'), landingTsx.indexOf('</header>'));
    expect(bar).not.toContain('<Mark');
    // The lang trigger is a v2.css <button>; the override has to carry the
    // .v2-root prefix plus the band class to outrank the rail pin.
    expect(landing).toContain('.v2-root .v2-landing__bar--band button.v2-lang-switch__trigger { color: var(--v2-on-accent, #ffffff); }');
  });

  test('the rotator is white on the band — the accent is cobalt and would vanish', () => {
    const rotator = selectorRuleBody(landing, '.v2-landing__rotator {');
    expect(rotator).toContain('color: var(--v2-on-accent, #ffffff)');
    expect(rotator).not.toContain('var(--v2-accent)');
  });

  test('the demo caption is on the band, above the frame, and the old lift is gone', () => {
    const cap = selectorRuleBody(landing, '.v2-landing__demo-cap {');
    expect(cap).toContain('color: var(--v2-on-accent, #ffffff)');
    expect(cap).toContain('margin: 44px 0 0');
    expect(cap).not.toContain('var(--v2-font-mono)');
    expect(mediaAt(landing, '@media (max-width: 760px) {')).toContain('.v2-landing__demo-cap { margin: 28px 0 0; }');
    // The caption precedes the demo in source, and lives in the band rather than
    // in the figure (the sibling-fix test above asserts where).
    expect(landingTsx.indexOf('v2-landing__demo-cap')).toBeLessThan(landingTsx.indexOf('<DemoWorkspace />'));
    // The hover lift is out: the frame sits on cobalt, so lifting it lifts the
    // product off the band rather than the card off the page.
    expect(landing).not.toContain('translateY(-2px)');
    expect(landing).not.toContain('.v2-landing__shot:hover .v2-landing__shot-frame');
  });

  test('the built-by line is gone from the hero and its string is out of both locales', () => {
    expect(landingTsx).not.toContain('hero.builtBy');
    expect(landingTsx).not.toContain('v2-landing__hero-by');
    expect(landing).not.toContain('v2-landing__hero-by');
    // Both locales, or the key survives in the one nothing reads.
    expect(landingEn).not.toContain('"builtBy"');
    expect(read('../../i18n/locales/zh-CN.json')).not.toContain('"builtBy"');
    // X_HANDLE still has a reader — it moved to the footer's own link.
    expect(landingTsx).toContain('href={X_HANDLE}');
  });

  test('zh-CN: every negative-tracked landing selector is reset — the twin of the shell test', () => {
    // The same rule as the v2.css test above, one sheet over: CJK glyphs have
    // no side bearings, so the latin optical tightening crushes them. Reading
    // the landing sheet is what makes rows B–E inherit it — a new negative
    // tracking without its :lang(zh) twin fails here instead of in a browser.
    const negative = [...landing.matchAll(/\n((?:[^\n{}]+,\n)*[^\n{}]+) \{[^}]*letter-spacing:\s*-[^;]+;/g)]
      .flatMap((m) => m[1].split(',').map((sel) => sel.trim()))
      .filter(Boolean);
    expect(negative.length).toBeGreaterThan(0);
    const resetStart = landing.indexOf(':lang(zh) .v2-landing__brand-name');
    expect(resetStart).toBeGreaterThan(-1);
    const resetBlock = landing.slice(resetStart, landing.indexOf('}', resetStart));
    expect(resetBlock).toContain('letter-spacing: 0');
    for (const sel of negative) {
      expect(resetBlock).toContain(`:lang(zh) ${sel}`);
    }
  });
});

// TASK-167 row B (TASK-193). The three sections under the band: the trusted
// strip, the wedge, and the feature rows. The load-bearing parts are the two
// rules that only work as pairs — a mirrored grid whose halves must add up, and
// a marquee whose gap and padding-right must move together — plus the removal of
// the old ✓ mark, which is a glyph the file must not contain again.
describe('TASK-167 row B — trusted, wedge and In action onto Signal', () => {
  const landing = read('../landing/v2-landing.css');
  const landingTsx = read('../landing/V2LandingPage.tsx');

  test('the feature row is 762 + 64 + 486, and the columns cannot outgrow it', () => {
    const row = selectorRuleBody(landing, '.v2-landing__feature-row {');
    // `minmax(0, …)` on both sides: bare `fr` has an automatic minimum of
    // `auto`, so the 760px screenshot in the media column would push the copy
    // narrower instead of letting the image shrink.
    expect(row).toContain('grid-template-columns: minmax(0, 762fr) minmax(0, 486fr)');
    expect(row).toContain('gap: 64px');
    // 762 + 64 + 486 = 1312, the measure row A set — asserted as arithmetic
    // rather than as three numbers that happen to sit next to each other.
    expect(762 + 64 + 486).toBe(1312);
    // The mirror has to reverse both tracks, or the even rows put the shot in
    // the narrow column and the shots stop lining up down the page.
    expect(ruleBody(landing, '.v2-landing__feature-row:nth-child(even)')).toContain('minmax(0, 486fr) minmax(0, 762fr)');
    expect(selectorRuleBody(landing, '.v2-landing__features {')).toContain('gap: 96px');
  });

  test('the feature title is set in the display face, and the ✓ is gone', () => {
    const title = selectorRuleBody(landing, '.v2-landing__feature-title {');
    expect(title).toContain('font-family: var(--v2-font-display');
    expect(title).toContain('font-size: 36px');
    expect(title).toContain('line-height: 40px');
    expect(title).toContain('text-wrap: balance');
    // The mark is a square now: a glyph that a font can render 3px wide at one
    // weight and 14px at another is not a mark, and the off-palette blue was
    // the only colour on the page outside the tokens.
    const mark = selectorRuleBody(landing, '.v2-landing__feature-points li::before {');
    expect(mark).toContain("content: ''");
    expect(mark).toContain('width: 6px');
    expect(mark).toContain('height: 6px');
    expect(mark).not.toContain('✓');
    expect(landing).not.toContain('✓');
    expect(landing).not.toContain('#2f6feb');
    // The row holds the square against a two-line point; a square has no
    // baseline, so centering is the only thing that lines them up.
    expect(selectorRuleBody(landing, '.v2-landing__feature-points li {')).toContain('align-items: center');
  });

  test('the copy column owns its spacing, so the UA margins cannot double it', () => {
    // Via the anchored helper: two even-row overrides name this class before the
    // base rule does, so a substring lookup returns `{ order: 1 }`.
    const copy = topLevelRuleBody(landing, '.v2-landing__feature-copy');
    expect(copy).toContain('display: flex');
    expect(copy).toContain('flex-direction: column');
    expect(copy).toContain('gap: 16px');
    expect(copy).toContain('min-width: 0');
    // <p>, <h3> and <ul> all carry margins; without this the column gap would
    // be added to them and the four blocks would sit at four different
    // distances, which is what "gap 16" is meant to replace.
    expect(landing).toContain('.v2-landing__feature-copy .v2-landing__feature-points { margin: 0; }');
    expect(landing).toContain('.v2-landing__feature-copy .v2-landing__feature-points { margin-top: 4px; }');
  });

  test('the trusted strip is a band between two rules, with no fill', () => {
    const strip = selectorRuleBody(landing, '.v2-landing__trusted {');
    // Declaration-shaped, not a substring: the block's own comment says the word
    // "background", and a check that trips on prose is a check on the comment.
    expect(strip).not.toMatch(/\bbackground(-[a-z]+)?\s*:/);
    expect(strip).toContain('border-top: 1px solid var(--v2-border-soft)');
    expect(strip).toContain('border-bottom: 1px solid var(--v2-border-soft)');
    expect(strip).toContain('min-height: 132px');
    // The 94 sits OUTSIDE the border: inside it the hairline could not straddle
    // the gap, so it sat on the frame's bottom edge at 0 and the box measured
    // 178 where the board draws 132 (ux-lead's #2019 finding 1). The min-height
    // above is the box, this is the gap, and 22 is the inset above and below the
    // label the centring then splits.
    expect(strip).toContain('margin-top: 94px');
    expect(strip).toContain('padding: 22px 0');
    expect(strip).not.toContain('padding-top: 94px');
    // And at ≤760 the gap is a margin too, or the ≤680 `padding: 24px 0` below
    // overrides it and the 48 disappears at 390.
    const phone760 = mediaAt(landing, '@media (max-width: 760px) {');
    expect(phone760).toContain('.v2-landing__trusted { margin-top: 48px; }');
    // Mono, and the same 12/20 as the kickers: a label with a different face
    // from every other label on the page reads as body copy.
    const label = selectorRuleBody(landing, '.v2-landing__trusted-label {');
    expect(label).toContain('font-family: var(--v2-font-mono)');
    expect(label).toContain('font-weight: 500');
    expect(label).toContain('letter-spacing: 0.06em');
    expect(label).toContain('text-transform: uppercase');
  });

  test('the phone halves of the marquee move together, or the loop jumps', () => {
    const phone = mediaAt(landing, '@media (max-width: 680px) {');
    // Two identical sets is what makes `translateX(-50%)` seamless, so the gap
    // and the padding-right that close each set are one quantity in two
    // declarations: change one alone and the track jumps 24px every cycle.
    expect(phone).toContain('.v2-landing__trusted-set { gap: 32px; padding-right: 32px; }');
    expect(phone).toContain('.v2-landing__trusted-logo { height: 22px; }');
    expect(phone).toContain('.v2-landing__trusted { min-height: 110px; padding: 24px 0; gap: 12px; }');
  });

  test('the section rhythm and the head are set once, for every section below', () => {
    expect(selectorRuleBody(landing, '.v2-landing__section {')).toContain('padding-bottom: 120px');
    expect(selectorRuleBody(landing, '.v2-landing__section {')).toContain('padding-top: 0');
    expect(selectorRuleBody(landing, '.v2-landing__section-head {')).toContain('margin: 0 auto 56px');
    // The features head is the exception, and it is 40 at BOTH widths, so the
    // rule has to outrank the 56 above it by name rather than by position.
    expect(selectorRuleBody(landing, '.v2-landing__section--features .v2-landing__section-head {')).toContain('margin-bottom: 40px');
    expect(landingTsx).toContain('v2-landing__section v2-landing__section--features');
    const phone = mediaAt(landing, '@media (max-width: 680px) {');
    expect(phone).toContain('.v2-landing__section { padding-top: 0; padding-bottom: 64px; }');
    // 24 here plus the wedge's 24 below is the board's 48 at 390, and the
    // features rule has to sit after the section rule to win on source order.
    expect(phone.indexOf('.v2-landing__section--features { padding-top: 24px; }'))
      .toBeGreaterThan(phone.indexOf('.v2-landing__section { padding-top: 0;'));
    expect(phone).toContain('.v2-landing__section-head { margin-bottom: 32px; }');
    const h2 = selectorRuleBody(landing, '.v2-landing__h2 {');
    expect(h2).toContain('font-size: 44px');
    expect(h2).toContain('line-height: 48px');
    expect(h2).toContain('font-weight: 800');
  });

  test('the wedge is left-aligned, unbordered and 56/58', () => {
    const wedge = selectorRuleBody(landing, '.v2-landing__wedge {');
    // The trusted strip above carries the hairline now; keeping these drew the
    // same rule twice, 80px apart.
    expect(wedge).not.toContain('border-top');
    expect(wedge).not.toContain('border-bottom');
    expect(wedge).not.toContain('text-align: center');
    expect(wedge).toContain('padding-top: 80px');
    const line = selectorRuleBody(landing, '.v2-landing__wedge-line {');
    expect(line).toContain('font-size: 56px');
    expect(line).toContain('line-height: 58px');
    expect(line).toContain('margin: 0');
    expect(line).not.toContain('max-width');
    const phone = mediaAt(landing, '@media (max-width: 680px) {');
    expect(phone).toContain('.v2-landing__wedge { padding-top: 48px; padding-bottom: 24px; }');
    expect(phone).toContain('.v2-landing__wedge-line { font-size: 34px; line-height: 36px; }');
    expect(phone).toContain('.v2-landing__wedge-sub { margin-top: 16px; font-size: 16px; line-height: 26px; }');
  });

  test('zh-CN: the three trackings this row re-tightens keep their reset', () => {
    // Row A owns the block; this row is what would break it, because it is the
    // row that sets the wedge, the h2 and the feature title as display type at
    // −0.03em. The reset list is read from the sheet, not restated here, so the
    // three names cannot drift out of it.
    const resetStart = landing.indexOf(':lang(zh) .v2-landing__brand-name');
    expect(resetStart).toBeGreaterThan(-1);
    const resetBlock = landing.slice(resetStart, landing.indexOf('}', resetStart));
    for (const sel of ['.v2-landing__wedge-line', '.v2-landing__h2', '.v2-landing__feature-title']) {
      expect(selectorRuleBody(landing, `${sel} {`)).toContain('letter-spacing: -0.03em');
      expect(resetBlock).toContain(`:lang(zh) ${sel}`);
    }
  });
});

describe('TASK-167 row C — How it works, Why open source and What you get onto Signal', () => {
  const landing = read('../landing/v2-landing.css');
  const landingTsx = read('../landing/V2LandingPage.tsx');

  test('a step is a 28px number track and a copy column, not a card', () => {
    const steps = topLevelRuleBody(landing, '.v2-landing__steps');
    expect(steps).toContain('repeat(3, minmax(0, 1fr))');
    expect(steps).toContain('gap: 64px');
    expect(steps).toContain('margin-bottom: 56px');
    const step = topLevelRuleBody(landing, '.v2-landing__step');
    // The card's four declarations are what the board removed; asserting the
    // grid alone would leave a padding or a background free to come back.
    expect(step).toContain('grid-template-columns: 28px minmax(0, 1fr)');
    expect(step).toContain('align-items: baseline');
    expect(step).not.toContain('padding');
    expect(step).not.toContain('background');
    expect(step).not.toContain('border');
    expect(step).not.toContain('border-radius');
    expect(topLevelRuleBody(landing, '.v2-landing__step-copy')).toContain('gap: 10px');
  });

  test('the step number is mono type, not a pill', () => {
    const num = topLevelRuleBody(landing, '.v2-landing__step-num');
    expect(num).toContain('var(--v2-font-mono)');
    expect(num).toContain('font-size: 13px');
    expect(num).toContain('font-weight: 500');
    expect(num).not.toContain('--v2-radius-pill');
    expect(num).not.toContain('--v2-accent-soft');
    expect(num).not.toContain('width:');
    expect(num).not.toContain('height:');
    const title = topLevelRuleBody(landing, '.v2-landing__step-title');
    expect(title).toContain('font-family: var(--v2-font-display');
    expect(title).toContain('font-size: 24px');
    expect(title).toContain('line-height: 28px');
    expect(title).toContain('letter-spacing: -0.03em');
    expect(title).toContain('text-wrap: balance');
    expect(topLevelRuleBody(landing, '.v2-landing__step-text')).toContain('font-size: 16px');
  });

  test('the numbers are two-digit and the copy is the pod wording', () => {
    // Two digits because the board draws 01/02/03 and the mono track is what
    // makes them align; the markup is the only place that can be checked.
    expect(landingTsx).toContain('v2-landing__step-num">01<');
    expect(landingTsx).toContain('v2-landing__step-num">02<');
    expect(landingTsx).toContain('v2-landing__step-num">03<');
    expect(read('../../i18n/locales/en.json')).toContain('Install your agents into a pod');
    expect(read('../../i18n/locales/zh-CN.json')).toContain('把智能体安装到 Pod 中');
    // Row D drops the use-cases tint; this row drops the how-it-works one.
    // Row D therefore takes this count to zero and deletes the class from the
    // sheet with it — the pinned property (no section carries a tint) is the
    // same claim at either value, and row D's own test checks the sheet half.
    expect((landingTsx.match(/v2-landing__section--tint/g) || []).length).toBe(0);
  });

  test('the adapters sit under a hairline and the command blocks are ink', () => {
    const adapters = topLevelRuleBody(landing, '.v2-landing__adapters');
    expect(adapters).toContain('repeat(3, minmax(0, 1fr))');
    expect(adapters).toContain('gap: 12px');
    expect(adapters).toContain('border-top: 1px solid var(--v2-border-soft)');
    expect(adapters).toContain('padding-top: 56px');
    const adapter = topLevelRuleBody(landing, '.v2-landing__adapter');
    expect(adapter).toContain('min-width: 0');
    expect(adapter).not.toContain('padding');
    expect(adapter).not.toContain('background');
    expect(adapter).not.toContain('border');
    const code = topLevelRuleBody(landing, '.v2-landing__code');
    // Code tokens, not text-primary or ink: both flip light in dark (TASK-682).
    expect(code).toContain('background: var(--v2-code-bg)');
    expect(code).toContain('color: var(--v2-code-text)');
    expect(code).toContain('outline: 1px solid var(--v2-code-edge)');
    expect(code).toContain('outline-offset: -1px');
    expect(topLevelRuleBody(landing, '.v2-landing__code-comment')).toContain('color: var(--v2-code-muted)');
    // Light keeps today's slab exactly; dark is a dark slab with an edge.
    const lightCode = /^\.v2-landing \{([^}]*--v2-code-bg[^}]*)\}/m.exec(landing)?.[1] ?? '';
    expect(lightCode).toContain('--v2-code-bg: #101828');
    expect(lightCode).toContain('--v2-code-text: #ffffff');
    expect(lightCode).toContain('--v2-code-muted: #98a2b3');
    expect(lightCode).toContain('--v2-code-edge: var(--v2-code-bg)');
    const darkCode = topLevelRuleBody(landing, ':root[data-v2-theme="dark"] .v2-landing');
    expect(darkCode).toContain('--v2-code-bg: #0b0e13');
    expect(darkCode).toContain('--v2-code-text: #e8ebf1');
    expect(darkCode).toContain('--v2-code-muted: #8b94a5');
    expect(darkCode).toContain('--v2-code-edge: #364051');
    expect(landing).toContain(':root:not([data-v2-theme="light"]) .v2-landing {');
    expect(code).toContain('font-size: 14px');
    expect(code).toContain('line-height: 22px');
    // 1 1 auto, so the three blocks share the row's height instead of each
    // ending where its own command ends.
    expect(code).toContain('flex: 1 1 auto');
    expect(code).toContain('white-space: pre');
    expect(code).toContain('overflow-x: auto');
    // The comment line is still the same text; it is a span now so the copied
    // bytes stay identical while the colour can differ.
    expect(topLevelRuleBody(landing, '.v2-landing__code-comment')).toContain('var(--v2-code-muted)');
    expect(landingTsx).toContain('v2-landing__code-comment');
    expect(landingTsx).toContain('commonly agent run my-agent');
    expect(landingTsx).toContain('# joins pods, replies to @mentions');
  });

  test('the open-source column is bordered rows and a ghost button', () => {
    const grid = topLevelRuleBody(landing, '.v2-landing__open-grid');
    expect(grid).toContain('minmax(0, 608fr) minmax(0, 640fr)');
    expect(grid).toContain('gap: 64px');
    expect(grid).toContain('align-items: start');
    const list = topLevelRuleBody(landing, '.v2-landing__open-list');
    expect(list).toContain('border: 1px solid var(--v2-border)');
    expect(list).toContain('border-radius: 4px');
    expect(list).toContain('gap: 0');
    const item = topLevelRuleBody(landing, '.v2-landing__open-item');
    expect(item).toContain('display: block');
    expect(item).toContain('padding: 20px 24px');
    expect(item).toContain('font-size: 16px');
    const strong = topLevelRuleBody(landing, '.v2-landing__open-item strong');
    expect(strong).toContain('display: block');
    expect(strong).toContain('font-family: var(--v2-font-display');
    expect(strong).toContain('font-size: 18px');
    expect(strong).toContain('line-height: 24px');
    // The rows are divided by a hairline on every row after the first.
    expect(landing).toContain('.v2-landing__open-item + .v2-landing__open-item { border-top: 1px solid var(--v2-border-soft); }');
    // Row A's fill belongs to the hero; row D's cobalt belongs to Pro.
    expect(landingTsx).toContain('v2-landing__btn v2-landing__btn--ghost" href={REPO}');
    expect(topLevelRuleBody(landing, '.v2-landing__open .v2-landing__btn')).toContain('height: 48px');
  });

  test('the value cards are bordered and their icons are gone', () => {
    const cards = topLevelRuleBody(landing, '.v2-landing__cards');
    expect(cards).toContain('repeat(2, minmax(0, 1fr))');
    expect(cards).toContain('gap: 12px');
    const card = topLevelRuleBody(landing, '.v2-landing__card');
    expect(card).toContain('border: 1px solid var(--v2-border)');
    expect(card).toContain('border-radius: 6px');
    expect(card).toContain('padding: 28px 32px');
    expect(card).toContain('gap: 10px');
    const title = topLevelRuleBody(landing, '.v2-landing__card-title');
    expect(title).toContain('font-family: var(--v2-font-display');
    expect(title).toContain('font-size: 24px');
    expect(title).toContain('letter-spacing: -0.03em');
    // Icons deleted on both sides: the rules and their last readers.
    expect(landing).not.toContain('.v2-landing__card-icon');
    expect(landing).not.toContain('.v2-landing__open-ic');
    expect(landingTsx).not.toContain('card-icon');
    expect(landingTsx).not.toContain('open-ic');
    // And the import block goes with them: eight imports whose last reader was
    // one of these two spans.
    expect(landingTsx).not.toContain('@mui/icons-material');
  });

  test('the phone values for this row live in the 680 block', () => {
    const phone = mediaAt(landing, '@media (max-width: 680px)');
    expect(phone).toContain('.v2-landing__steps { margin-bottom: 32px; }');
    expect(phone).toContain('.v2-landing__step-title { font-size: 22px; line-height: 26px; }');
    expect(phone).toContain('.v2-landing__adapters { padding-top: 32px; }');
    expect(phone).toContain('.v2-landing__code { padding: 14px; font-size: 12px; line-height: 20px; }');
    expect(phone).toContain('.v2-landing__card { padding: 20px 22px; }');
    expect(phone).toContain('.v2-landing__open-item { padding: 16px 18px; }');
    // The one-column switches stay in the 900 block, including the row gaps the
    // stacked adapters and steps need.
    const mid = mediaAt(landing, '@media (max-width: 900px)');
    expect(mid).toContain('.v2-landing__steps { row-gap: 28px; }');
    expect(mid).toContain('.v2-landing__adapters { row-gap: 24px; }');
  });

  test('every negative tracking this row adds has its zh reset', () => {
    const zh = landing.slice(landing.indexOf(':lang(zh) .v2-landing__brand-name'));
    for (const sel of ['step-title', 'adapter-title', 'open-item strong', 'card-title']) {
      expect(zh).toContain(`:lang(zh) .v2-landing__${sel},`);
    }
    // Non-vacuity for the loop above: the block that must carry them exists and
    // the property is the one row A's inheritance test scans for.
    expect(zh).toContain('letter-spacing: 0;');
  });
});

// TASK-167 row D (TASK-195). The page's second half: use cases as a bordered
// list, architecture as a bordered stack, the proof as a quiet panel on the
// card surface, and pricing onto Signal. Two of these are REMOVALS a later edit
// could quietly undo — the navy proof band and the round accent dot — so both
// are asserted absent rather than left unmentioned.
describe('TASK-167 row D — Use cases, Architecture, the proof panel and Pricing onto Signal', () => {
  const landing = read('../landing/v2-landing.css');
  const landingTsx = read('../landing/V2LandingPage.tsx');
  const repoRoot = path.resolve(__dirname, '..', '..', '..', '..');

  test("the page's ADR count equals the ADR files in docs/adr", () => {
    // docs/ sits outside the frontend image's build context, so the page cannot
    // count at build time and the number is a literal in the TSX. This test is
    // the only thing that notices when the two disagree — and it fails in the
    // PR that adds the ADR, which is the PR whose author can fix it (tests.yml
    // carries no path filter, which is what makes that true).
    const count = Number(/^const ADR_COUNT = (\d+);$/m.exec(landingTsx)?.[1]);
    expect(Number.isInteger(count)).toBe(true);
    const files = fs.readdirSync(path.join(repoRoot, 'docs/adr'))
      .filter((f) => /^ADR-\d+.*\.md$/.test(f));
    expect(files).toHaveLength(count);
  });

  test('an agent-team card is one bordered box, with its footer pinned to the bottom', () => {
    expect(topLevelRuleBody(landing, '.v2-landing__team-cards')).toContain(
      'grid-template-columns: repeat(3, minmax(0, 1fr))',
    );
    const card = topLevelRuleBody(landing, '.v2-landing__team-card');
    expect(card).toContain('border: 1px solid var(--v2-border)');
    expect(card).toContain('border-radius: var(--v2-radius)');
    expect(card).toContain('flex-direction: column');
    expect(topLevelRuleBody(landing, '.v2-landing__team-footer')).toContain('margin: auto 0 0');
    // Three cards in one row, and one column once the tablet switch applies.
    expect(mediaAt(landing, '@media (max-width: 900px)')).toContain(
      '.v2-landing__team-cards { grid-template-columns: minmax(0, 1fr); }',
    );
  });

  test('the works-with chips wrap inside their container instead of running past it', () => {
    // CodeRabbit (PR #2956): the chip list is the element that has to wrap. Removing
    // flex-wrap would let the set run past a narrow phone container without a failing test.
    expect(topLevelRuleBody(landing, '.v2-landing__works-list')).toContain('flex-wrap: wrap');
  });

  test('the star count is absent until GitHub answers and never takes the link name', () => {
    expect(landingTsx).toContain('{starLabel && <span className="v2-landing__star-count"');
    expect(landingTsx).toContain(
      "href={REPO} target=\"_blank\" rel=\"noreferrer\">{t('landing.actions.starGithub')}</a>",
    );
    expect(topLevelRuleBody(landing, '.v2-landing__star-count')).toContain('font-variant-numeric: tabular-nums');
  });

  test('the team-card title keeps its weight, leading and tracking', () => {
    const title = topLevelRuleBody(landing, '.v2-landing__team-title');
    expect(title).toContain('font-weight: 800');
    expect(title).toContain('line-height: 24px');
    expect(title).toContain('letter-spacing: -0.03em');
  });

  test('the marketplace case is gone from the page and from both locales', () => {
    expect(landingTsx).not.toContain('app-marketplace');
    for (const locale of ['en.json', 'zh-CN.json']) {
      const json = JSON.parse(read(`../../i18n/locales/${locale}`));
      expect(json.landing.useCases).toBeUndefined();
      expect(Object.keys(json.landing.agentTeams.cards)).toEqual(['one', 'two', 'three']);
      expect(Object.keys(json.landing.worksWith.items)).toEqual([
        'claudeCode', 'codex', 'opencode', 'qwenCode', 'pi', 'deepseekHarness', 'hosted', 'mcp', 'linear',
      ]);
    }
  });

  test('architecture is one bordered stack, and a layer is not a step', () => {
    const stack = topLevelRuleBody(landing, '.v2-landing__tiles');
    expect(stack).toContain('border: 1px solid var(--v2-border)');
    expect(stack).toContain('border-radius: var(--v2-radius)');
    expect(stack).not.toContain('grid-template-columns');

    const row = topLevelRuleBody(landing, '.v2-landing__tile');
    expect(row).toContain('grid-template-columns: 280px minmax(0, 1fr)');
    expect(row).toContain('padding: 28px 32px');
    expect(row).toContain('align-items: baseline');
    expect(landing).toContain(
      '.v2-landing__tile + .v2-landing__tile { border-top: 1px solid var(--v2-border-soft); }',
    );
    expect(topLevelRuleBody(landing, '.v2-landing__tile-text')).toContain('max-width: 760px');

    // The 01/02/03 are gone from the markup AND the sheet, so a card treatment
    // cannot come back by restoring a single rule.
    expect(landingTsx).not.toContain('tile-num');
    expect(landing).not.toContain('tile-num');
  });

  test('the proof is a quiet panel on the card surface, not a navy band', () => {
    const panel = topLevelRuleBody(landing, '.v2-landing__proof-inner');
    expect(panel).toContain('background: var(--v2-bg-subtle)');
    expect(panel).toContain('border: 1px solid var(--v2-border-soft)');
    expect(panel).toContain('border-radius: var(--v2-radius-lg)');
    expect(panel).toContain('padding: 56px 64px');
    expect(panel).toContain('flex-wrap: wrap');
    expect(panel).toContain('align-items: flex-end');
    expect(panel).toContain('gap: 28px 64px');
    // The band's own navy fill and padding are gone, so the frame above (which
    // every section shares) is what holds the proof's margins.
    expect(topLevelRuleBody(landing, '.v2-landing__proof')).toBe('');
    expect(landingTsx).toContain('<section className="v2-landing__section v2-landing__proof">');
    // The copy takes one track and the stats the other, and the wrap below
    // ~1140 is what puts them in a column at 390 without a breakpoint.
    expect(topLevelRuleBody(landing, '.v2-landing__proof-copy')).toContain('flex: 1 1 480px');
    const stats = topLevelRuleBody(landing, '.v2-landing__proof-stats');
    expect(stats).toContain('flex: 0 0 auto');
    expect(stats).toContain('flex-wrap: nowrap');
    expect(stats).toContain('gap: 56px');
    expect(topLevelRuleBody(landing, '.v2-landing__proof-num')).toContain('font-size: 56px');
    // The title is row B's h2, not a band-specific size.
    expect(landingTsx).toContain('<h2 className="v2-landing__h2">{t(\'landing.proof.title\')}</h2>');
    expect(landing).not.toContain('proof-title');
    expect(landing).not.toContain('kicker--light');
    expect(landingTsx).not.toContain('kicker--light');
  });

  test('a pricing bullet is a 6px ink square, and Pro carries the 2px cobalt rule', () => {
    const marker = selectorRuleBody(landing, '.v2-landing__price-list li::before');
    expect(marker).toContain('width: 6px');
    expect(marker).toContain('height: 6px');
    expect(marker).toContain('background: var(--v2-text-primary)');
    expect(marker).toContain('margin-top: 7px');
    // Round and accent is the old dot: both gone, so neither can come back
    // alone. `flex: none` keeps the square from being squeezed by a long item.
    expect(marker).not.toContain('border-radius');
    expect(marker).not.toContain('var(--v2-accent)');
    expect(marker).toContain('flex: none');

    // The list is ONE rule: the tiers carry no override of it, because the
    // board's own tier list margin is the base margin.
    expect(landing).not.toContain('.v2-landing__tier .v2-landing__price-list');

    const featured = topLevelRuleBody(landing, '.v2-landing__tier--featured');
    expect(featured).toContain('border: 2px solid var(--v2-accent)');
    expect(featured).toContain('padding: 31px');
    expect(landing).toContain(
      '.v2-landing__tier--featured .v2-landing__btn { font-weight: 700; }',
    );
    expect(topLevelRuleBody(landing, '.v2-landing__tier')).toContain('padding: 32px');
    const btn = landing.match(/\.v2-landing__tier \.v2-landing__btn \{[^}]*\}/)?.[0] ?? '';
    expect(btn).toContain('height: 48px');
    expect(btn).toContain('padding: 0 20px');
    expect(btn).toContain('font-size: 16px');
  });

  test('the enterprise row is a bordered grid, and the price foot is left-aligned', () => {
    const ent = topLevelRuleBody(landing, '.v2-landing__tier-enterprise');
    expect(ent).toContain('grid-template-columns: minmax(0, 1fr) auto');
    expect(ent).toContain('gap: 24px');
    expect(ent).toContain('border: 1px solid var(--v2-border)');
    expect(ent).toContain('border-radius: var(--v2-radius)');
    expect(ent).not.toContain('background');
    // Dropped from the markup with the class: the base 44/15/600 is the board's.
    expect(landingTsx).not.toContain('btn--sm" to={appHref}}>{t(\'landing.actions.talkToUs\')}');
    expect(topLevelRuleBody(landing, '.v2-landing__price-foot')).toContain('text-align: left');
  });

  test('the tint class is dead in both places, so no section carries it back', () => {
    // Row C left it with exactly one user (use cases) and asserted that count.
    // This row removes the last one, so the rule goes too rather than sitting
    // in the sheet as a class nothing can name.
    expect(landingTsx).not.toContain('section--tint');
    expect(landing).not.toContain('section--tint');
  });

  test("the head's sub is architecture's and pricing's, at the board's 20/32", () => {
    const sub = topLevelRuleBody(landing, '.v2-landing__sub');
    expect(sub).toContain('margin: 20px 0 0');
    expect(sub).toContain('max-width: 900px');
    expect(sub).toContain('font-size: 20px');
    expect(sub).toContain('line-height: 32px');
    // The pricing-only variant is gone, so the two heads cannot drift apart.
    expect(landing).not.toContain('.v2-landing__section-sub');
    expect(landingTsx).toContain('<p className="v2-landing__sub">{t(\'landing.pricing.sub\')}</p>');
  });

  test('the phone block carries this row, and the one-column switches sit at 900', () => {
    const phone = mediaAt(landing, '@media (max-width: 680px)');
    expect(phone).toContain('.v2-landing__tile { padding: 18px 20px; }');
    expect(phone).toContain('.v2-landing__proof-inner { padding: 28px 22px; }');
    expect(phone).toContain(
      '.v2-landing__proof-stats { flex: 1 1 100%; justify-content: space-between; gap: 16px; }',
    );
    expect(phone).toContain('.v2-landing__proof-num { font-size: 36px; line-height: 36px; }');
    expect(phone).toContain('.v2-landing__tier { padding: 24px; }');
    expect(phone).toContain('.v2-landing__tier--featured { padding: 23px; }');
    expect(phone).toContain('.v2-landing__tier-price { font-size: 44px; line-height: 44px; }');
    const tablet = mediaAt(landing, '@media (max-width: 900px)');
    expect(tablet).toContain('.v2-landing__tile { grid-template-columns: minmax(0, 1fr); row-gap: 6px; }');
    expect(tablet).toContain(
      '.v2-landing__tier-enterprise { grid-template-columns: minmax(0, 1fr); gap: 14px; justify-items: start; }',
    );
    // The stack stays one box, so it must NOT be in the one-column group.
    expect(tablet).not.toContain('.v2-landing__tiles,');
    expect(tablet).not.toContain('.v2-landing__proof-stats');
  });

  test('every negative tracking this row adds has its zh reset', () => {
    const resetStart = landing.indexOf(':lang(zh) .v2-landing__brand-name');
    const resetBlock = landing.slice(resetStart, landing.indexOf('}', resetStart));
    for (const selector of [
      '.v2-landing__team-title',
      '.v2-landing__tile-title',
      '.v2-landing__tier-enterprise strong',
    ]) {
      expect(topLevelRuleBody(landing, selector)).toContain('letter-spacing: -0.03em');
      expect(resetBlock).toContain(`:lang(zh) ${selector}`);
    }
    // The two selectors this row deletes may not linger in the reset list:
    // a reset for a rule that no longer exists is a claim nothing checks.
    expect(resetBlock).not.toContain('proof-title');
    expect(resetBlock).not.toContain('price-tag');
  });
});

// TASK-167 row E (TASK-196). The last row: the close comes off its navy band
// and onto the page, and the footer becomes the board's wordmark-beside-four-
// columns grid. Three removals ride along — the navy fill, the subtitle and the
// glyph mark — and each is asserted absent rather than merely unmentioned.
describe('TASK-167 row E — the closing CTA and the footer onto Signal', () => {
  const landing = read('../landing/v2-landing.css');
  const landingTsx = read('../landing/V2LandingPage.tsx');

  // `.v2-landing__cta` and `.v2-landing__footer` are ALSO the last lines of the
  // shared 1312 padding-frame selector list at the top of the sheet, so a
  // first-match reader returns that list's body — the padding — instead of the
  // rule this row writes. Take the last match at line start.
  const lastRuleBody = (selector: string): string => {
    const idx = landing.lastIndexOf(`\n${selector} {`);
    expect(idx).toBeGreaterThan(-1);
    const open = landing.indexOf('{', idx);
    return landing.slice(open + 1, landing.indexOf('}', open));
  };

  test('the glyph mark is gone: no <Mark in the component, no rule for it', () => {
    // Rows A and E both touch it; E lands second, so E deletes it. A future
    // edit that wants the glyph back has to write it, not un-comment it.
    expect(landingTsx).not.toContain('<Mark');
    expect(landing).not.toContain('.v2-landing__mark');
    expect(landing).not.toContain('btn-mark');
    // The wordmark is still there, in the bar and in the footer.
    expect(landingTsx).toContain("v2-landing__brand-name");
  });

  test('the close is type on the page, not a navy band', () => {
    const cta = lastRuleBody('.v2-landing__cta');
    expect(cta).toContain('display: flex');
    expect(cta).toContain('align-items: flex-start');
    expect(cta).toContain('gap: 24px');
    expect(cta).toContain('padding-top: 80px');
    expect(cta).toContain('padding-bottom: 80px');
    expect(cta).toContain('border-top: 1px solid var(--v2-border-soft)');
    // The band's fill, centring and its own padding are gone, not overridden.
    expect(cta).not.toContain('background');
    expect(cta).not.toContain('text-align');
    expect(landing).not.toContain('.v2-landing__cta-sub');
    expect(landingTsx).not.toContain('cta-sub');
    // The frame above still gives the close its 1312 measure and side padding.
    // (The frame's selector list is at column 0, one selector per line.)
    expect(landing).toContain('.v2-landing__cta,\n.v2-landing__footer {');
  });

  test('the close title is 64/64 on the display face, and not balanced', () => {
    const title = lastRuleBody('.v2-landing__cta-title');
    expect(title).toContain('var(--v2-font-display, var(--v2-font))');
    expect(title).toContain('font-size: 64px');
    expect(title).toContain('line-height: 64px');
    expect(title).toContain('font-weight: 800');
    expect(title).toContain('letter-spacing: -0.03em');
    expect(title).toContain('color: var(--v2-text-primary)');
    expect(title).toContain('margin: 0');
    expect(title).not.toContain('max-width');
    // The board's note: balance split the sentence ("…has / a chat.").
    expect(title).not.toContain('text-wrap');
  });

  test('one sentence in two blocks: the break is the copy\'s, the name is whole', () => {
    // Two spans joined by {' '} — each starts a line, and the space between two
    // blocks makes no line box, so the heading's accessible name is the
    // sentence and not "…chat. Give…" read as two.
    expect(landingTsx).toContain(
      "<span className=\"v2-landing__cta-line\">{t('landing.finalCta.titleLead')}</span>{' '}",
    );
    expect(landingTsx).toContain(
      "<span className=\"v2-landing__cta-line\">{t('landing.finalCta.titleTail')}</span>",
    );
    expect(landing).toContain('.v2-landing__cta-line { display: block; }');

    const en = JSON.parse(read('../../i18n/locales/en.json'));
    expect(`${en.landing.finalCta.titleLead} ${en.landing.finalCta.titleTail}`)
      .toBe('Your team already has a chat. Give it an agent.');
    const zh = JSON.parse(read('../../i18n/locales/zh-CN.json'));
    expect(Object.keys(zh.landing.finalCta)).toEqual(['titleLead', 'titleTail']);
  });

  test('the old close copy is out of both locales', () => {
    for (const locale of ['en.json', 'zh-CN.json']) {
      const json = JSON.parse(read(`../../i18n/locales/${locale}`));
      expect(Object.keys(json.landing.finalCta)).toEqual(['titleLead', 'titleTail']);
      expect(Object.keys(json.landing.finalCta)).not.toContain('title');
      expect(Object.keys(json.landing.finalCta)).not.toContain('sub');
    }
  });

  test('the footer is two tracks, and the four columns are auto tracks', () => {
    const footer = lastRuleBody('.v2-landing__footer');
    expect(footer).toContain('grid-template-columns: minmax(0, 1fr) auto');
    expect(footer).toContain('column-gap: 64px');
    expect(footer).toContain('padding-top: 48px');
    expect(footer).toContain('padding-bottom: 0');
    expect(footer).toContain('border-top: 1px solid var(--v2-border-soft)');
    expect(footer).toContain('font-size: 13px');
    expect(footer).toContain('line-height: 20px');
    expect(footer).toContain('color: var(--v2-text-tertiary)');
    // The columns are NOT a nested count of the container's tracks: 591.1 + 64
    // + (182.1 + 87.1 + 71.3 + 124.3) with 64s between them is the board's 1312.
    expect(footer).not.toContain('repeat(4');

    const cols = lastRuleBody('.v2-landing__footer-cols');
    expect(cols).toContain('grid-template-columns: repeat(4, auto)');
    expect(cols).toContain('gap: 64px');
    expect(cols).toContain('padding-bottom: 48px');
    expect(lastRuleBody('.v2-landing__footer-col')).toContain('min-width: 0');
  });

  test('the footer wordmark is the 16px one, and its headings are mono', () => {
    // Row A sets 24 in the bar; the footer is 16/20, and (0,2,0) also beats row
    // A's phone 22px.
    expect(landing).toContain(
      '.v2-landing__footer .v2-landing__brand-name { font-size: 16px; line-height: 20px; }',
    );
    const title = lastRuleBody('.v2-landing__footer-title');
    expect(title).toContain('font-family: var(--v2-font-mono)');
    expect(title).toContain('font-size: 12px');
    expect(title).toContain('line-height: 20px');
    expect(title).toContain('font-weight: 500');
    expect(title).toContain('letter-spacing: 0.06em');
    expect(title).toContain('text-transform: uppercase');
    expect(title).toContain('color: var(--v2-text-primary)');
    expect(title).toContain('margin-bottom: 4px');
  });

  test('the legal line spans the footer and is declared before the phone block', () => {
    // Declared after the ≤680 block it would be an equal-specificity base rule
    // beating the phone padding — which is where it used to sit.
    // Base rules only: the phone block's own legal rule is indented, and that
    // indentation is what distinguishes the two declarations of the class.
    expect(landing.match(/^\.v2-landing__footer-legal \{/gm) || []).toHaveLength(1);
    const legalAt = landing.lastIndexOf('\n.v2-landing__footer-legal {');
    expect(legalAt).toBeLessThan(landing.indexOf('@media (max-width: 680px)'));
    const legal = lastRuleBody('.v2-landing__footer-legal');
    expect(legal).toContain('grid-column: 1 / -1');
    expect(legal).toContain('margin: 0');
    expect(legal).toContain('padding: 18px 0 22px');
    expect(legal).toContain('border-top: 1px solid var(--v2-border-soft)');
    expect(legal).toContain('font-size: 12px');
    expect(legal).toContain('line-height: 18px');
  });

  test('the close joins row A\'s button rules instead of restating them', () => {
    expect(landing).toContain('.v2-landing__cta .v2-landing__btn { height: 56px; font-size: 17px; }');
    expect(landing).toContain('.v2-landing__cta .v2-landing__btn--primary { padding: 0 26px; font-weight: 700; }');
    expect(landing).toContain('.v2-landing__cta .v2-landing__btn--ghost { padding: 0 22px; }');
    // The section's one cobalt button, on the page's white: base colours.
    expect(landingTsx).toContain('v2-landing__btn v2-landing__btn--primary" to={appHref}>{primaryLabel}');
    expect(landingTsx).toContain('v2-landing__btn v2-landing__btn--ghost" href={REPO}');
  });

  test('the tablet and phone values, and the two rules the tablet values replace', () => {
    const tablet = mediaAt(landing, '@media (max-width: 900px)');
    expect(tablet).toContain('.v2-landing__cta-title { font-size: 48px; line-height: 50px; }');
    expect(tablet).toContain('.v2-landing__footer { grid-template-columns: minmax(0, 1fr); }');
    expect(tablet).toContain('grid-template-columns: repeat(2, minmax(0, 1fr));');
    expect(tablet).toContain('gap: 28px 24px;');
    expect(tablet).toContain('padding: 24px 0 32px;');

    const phone = mediaAt(landing, '@media (max-width: 680px)');
    expect(phone).toContain('.v2-landing__cta { padding-top: 48px; padding-bottom: 48px; gap: 20px; }');
    expect(phone).toContain('.v2-landing__cta-title { font-size: 36px; line-height: 38px; }');
    expect(phone).toContain('.v2-landing__cta .v2-landing__btn { height: 48px; }');
    expect(phone).toContain('.v2-landing__cta .v2-landing__btn--ghost { padding: 0 18px; font-size: 16px; }');
    expect(phone).toContain('.v2-landing__footer { padding-top: 32px; }');
    expect(phone).toContain('.v2-landing__footer-legal { padding: 16px 0 20px; }');
    // The old phone gaps are gone: the 900 block carries the column gaps now,
    // and a phone rule left behind would beat it on specificity.
    expect(phone).not.toContain('.v2-landing__footer-cols { gap: 28px; }');
    expect(phone).not.toContain('.v2-landing__footer { gap: 24px; }');
  });
});

describe('BYO command boxes wrap at spaces', () => {
  // break-all split the Windows PowerShell line as "common / ly-mcp" at 1440
  // (browser check on #2289). overflow-wrap still breaks a word that cannot
  // fit (the key, a URL), so a 390 screen never clips; it just stops
  // splitting words that could have moved to the next line whole.
  const v2 = readV2Css();
  const byoCss = read('../components/V2AgentBYO.css');
  test('the command box breaks inside a word only when the word cannot fit', () => {
    const rule = ruleBody(byoCss, '.v2-feature--byo .v2-byo__pre');
    expect(rule).toContain('white-space: pre-wrap');
    expect(rule).toContain('overflow-wrap: anywhere');
    expect(rule).not.toContain('word-break: break-all');
  });

  test('a mention item highlights on arrow-key and hover past the button reset', () => {
    // The prefixed rules keep the interaction states explicit. The reset is
    // intentionally low-specificity, so bare component rules can own their
    // declarations without a specificity workaround.
    const active = ruleBody(v2, '.v2-root button.v2-mention-item--active');
    expect(active).toContain('background: var(--v2-surface-hover)');
    const hover = ruleBody(v2, '.v2-root button.v2-mention-item:hover');
    expect(hover).toContain('background: var(--v2-surface-hover)');
    // The dropdown explicitly owns the padding the reset defaults to zero.
    const padded = ruleBody(v2, '.v2-root .v2-mention-dropdown button.v2-mention-item');
    expect(padded).toContain('padding: 7px 9px');
    expect(ruleBody(v2, '.v2-root :where(button:not(.MuiButtonBase-root))'))
      .toContain('background: none');
  });
});

describe('GitHub gig card fits the chat column', () => {
  const css = readV2Css();
  test('bounds card width, wraps long repository text, and releases the avatar inset on phones', () => {
    const card = ruleBody(css, '.v2-gig');
    expect(card).toContain('min-width: 0');
    expect(card).toContain('max-width: 600px');
    expect(card).toContain('overflow-wrap: anywhere');
    const phone = mediaBlockContaining(css, '.v2-msg.v2-msg--card:has(.v2-gig)');
    expect(phone).toContain('padding-left: 0');
  });
});

describe('agent settings surface (D223 lift)', () => {
  const css = read('../agents/v2-agent-settings-surface.css');
  test('the Save action keeps a visible surface over the v2 button reset', () => {
    expect(ruleBody(css, '.v2-agent-settings-page .b-s')).toContain('background: linear-gradient');
  });

  test('segment tabs keep a keyboard focus ring now that the old base rule skips them', () => {
    expect(ruleBody(css, '.v2-agent-settings-page .seg > button:focus-visible, .v2-agent-settings-page .seg > a:focus-visible'))
      .toContain('box-shadow: var(--v2-focus-ring)');
    expect(css).not.toContain('--v2-accent-soft');
  });

  test('disabled lifted controls still dim, since the old :disabled rule skips .b and seg tabs', () => {
    expect(ruleBody(css, '.v2-agent-settings-page .b:disabled, .v2-agent-settings-page .seg > button:disabled'))
      .toContain('opacity: .55');
  });

  test('lifted .b-sm controls keep their 28px size', () => {
    expect(ruleBody(css, '.v2-agent-settings-page .b-sm')).toContain('height: 28px');
  });

  test('message-wake segment wraps its options instead of overflowing the Wake row', () => {
    const segment = ruleBody(css, '.v2-agent-settings-page .wt .seg');
    expect(segment).toContain('display: inline-flex');
    expect(segment).toContain('flex-wrap: wrap');
  });

  test('the avatar header, Identity & access rows and Wake table keep their frame layout', () => {
    expect(ruleBody(css, '.v2-agent-settings-page .ph')).toContain('min-height: 76px');
    expect(ruleBody(css, '.v2-agent-settings-page .lrow')).toContain('grid-template-columns: 180px minmax(0, 1fr) auto');
    expect(ruleBody(css, '.v2-agent-settings-page .wt')).toContain('border-collapse: collapse');
  });

  test('menu and disclosure glyphs keep their frame size instead of stretching or shrinking', () => {
    expect(ruleBody(css, '.v2-agent-settings-page .ib svg.i')).toContain('width: 17px');
    expect(ruleBody(css, '.v2-agent-settings-page details.disc > summary .lb svg.i')).toContain('width: 16px');
    expect(ruleBody(css, '.v2-agent-settings-page .b svg.i, .v2-agent-settings-page .ib svg.i')).toContain('flex: none');
    expect(ruleBody(css, '.v2-agent-settings-page .lrow')).toContain('grid-template-columns: 180px minmax(0, 1fr) auto');
    expect(css).toContain('.v2-agent-settings-page .lrow { grid-template-columns: minmax(0, 1fr) auto;');
    expect(css).toContain('.v2-agent-settings-page .ph { flex-wrap: wrap;');
  });
});

describe('agent settings sections lifted from #s-agent-states', () => {
  const css = read('../agents/v2-agent-settings-surface.css');
  const phone = blockContaining(css, '@media (max-width: 600px)', '.v2-agent-settings-page__stack');
  const targets = blockContaining(css, '@media (max-width: 760px)', '.v2-agent-settings-page__group .b');
  test('every lifted control is a 44px target on phones', () => {
    expect(ruleBody(targets, '.v2-agent-settings-page__group .b, .v2-agent-settings-page__group .b-sm')).toContain('height: 44px');
    expect(ruleBody(targets, '.v2-agent-settings-page__group .sel, .v2-agent-settings-page__group .field:not(.field--area)')).toContain('--box-h: 44px');
    expect(ruleBody(targets, '.v2-agent-settings-page__group .seg > label')).toContain('height: 44px');
  });
  test('setting rows stack on phones and keep their value under the label', () => {
    expect(ruleBody(phone, '.v2-agent-settings-page__group .lrow.v2-agent-settings-page__stack', { within: phone }))
      .toContain('grid-template-columns: minmax(0, 1fr)');
    expect(ruleBody(phone, '.v2-agent-settings-page__group .v2-agent-settings-page__stack > .vl, .v2-agent-settings-page__group .v2-agent-settings-page__stack > .ac', { within: phone }))
      .toContain('grid-row: auto');
    expect(ruleBody(phone, '.v2-agent-settings-page .dbody', { within: phone })).toContain('padding: 0 12px 12px');
  });
  test('grant rows keep the logo column and long reach lines wrap', () => {
    expect(ruleBody(css, '.v2-agent-settings-page .lrow.v2-agent-settings-page__grant')).toContain('grid-template-columns: 28px minmax(0, 1fr) auto');
    expect(ruleBody(css, '.v2-agent-settings-page__grantname .mo')).toContain('overflow-wrap: anywhere');
    expect(ruleBody(css, '.v2-agent-settings-page__grantname')).toContain('min-width: 0');
  });
  test('native controls fill the frame box, and the box carries the focus ring', () => {
    expect(css).toContain('.v2-agent-settings-page .sel input, .v2-agent-settings-page .sel select { all: unset;');
    expect(ruleBody(css, '.v2-agent-settings-page .field:focus-within, .v2-agent-settings-page .sel:focus-within')).toContain('var(--v2-focus-ring)');
    expect(ruleBody(css, '.v2-agent-settings-page .sel:has(.is-unsupported)')).toContain('inset 0 0 0 2px var(--ink)');
  });
  test('a confirming grant keeps its date under the name and gives Yes/Cancel the full row on phones', () => {
    expect(ruleBody(phone, '.v2-agent-settings-page .lrow.v2-agent-settings-page__grant:has(.v2-agent-settings-page__confirm) > .ac', { within: phone })).toContain('display: contents');
    expect(ruleBody(phone, '.v2-agent-settings-page .lrow.v2-agent-settings-page__grant > .ac > .mo', { within: phone })).toContain('grid-column: 2 / -1');
    expect(ruleBody(phone, '.v2-agent-settings-page .lrow.v2-agent-settings-page__grant > .ac > .v2-agent-settings-page__confirm', { within: phone })).toContain('grid-column: 1 / -1');
  });
  test('a select fills its box, so the whole box takes the click, with the value centred', () => {
    const select = ruleBody(css, '.v2-agent-settings-page .field select, .v2-agent-settings-page .sel select');
    expect(select).toContain('height: var(--box-h)');
    expect(select).toContain('line-height: var(--box-h)');
    expect(ruleBody(css, '.v2-agent-settings-page .sel')).toContain('--box-h: 28px; height: var(--box-h)');
    expect(ruleBody(css, '.v2-agent-settings-page .field')).toContain('--box-h: 34px; height: var(--box-h)');
  });
  test('a read-only runtime draws its disabled selects as values, without the box ring or chevron', () => {
    expect(ruleBody(css, '.v2-agent-settings-page .sel:has(:disabled)')).toContain('box-shadow: none');
    expect(ruleBody(css, '.v2-agent-settings-page .sel:has(:disabled) svg.i')).toContain('display: none');
  });
  test('the identity form does not add a box between the list and its rows', () => {
    expect(ruleBody(css, '.v2-agent-settings-page__form')).toContain('display: contents');
  });
  test('the old section sheets are gone', () => {
    expect(fs.existsSync(path.join(__dirname, '../components/V2AgentRuntimeGrants.css'))).toBe(false);
    expect(fs.existsSync(path.join(__dirname, '../components/V2RuntimeControls.css'))).toBe(false);
    expect(read('../agents/v2-agent-settings.css')).not.toMatch(/v2-agent-settings__(identity|listing|owned)/);
    expect(read('../agents/v2-agent-policy.css')).not.toContain('v2-agent-policy__quota');
  });
});

describe('agent Memory tab (TASK-732 lift of d215 #s-memory)', () => {
  const css = read('../agents/V2AgentMemory.css');
  const desktop = blockContaining(css, '@media (min-width: 768px)', '.v2m-grp > summary');
  const phone = blockContaining(css, '@media (max-width: 767px)', '.v2m-mnav ul');
  test('desktop keeps the group nav beside the notes at 200px', () => {
    expect(ruleBody(css, '.v2m-mem')).toContain('grid-template-columns: 200px minmax(0, 1fr)');
  });
  test('the page spans the pane instead of a centred column', () => {
    const page = ruleBody(css, '.v2m-page');
    expect(page).toContain('width: 100%');
    expect(page).toContain('align-self: stretch');
    expect(page).not.toContain('max-width');
  });
  test('the header is the frame agent bar: 76px tall, 28px left padding', () => {
    const ph = ruleBody(css, '.v2m-page .v2p-ph');
    expect(ph).toContain('height: 76px');
    expect(ph).toContain('padding-left: 28px');
  });
  test('phone hides the group nav and makes the groups collapsible rows', () => {
    expect(ruleBody(css, '.v2m-mnav ul', { within: phone })).toContain('display: none');
    expect(ruleBody(css, '.v2m-grp > summary', { within: phone })).toContain('cursor: pointer');
    expect(ruleBody(css, '.v2m-gtitle', { within: phone })).toContain('height: 44px');
  });
  test('desktop group titles do not take pointer input, and the chevron is phone-only', () => {
    expect(ruleBody(css, '.v2m-grp > summary', { within: desktop })).toContain('pointer-events: none');
    expect(ruleBody(css, '.v2m-gtitle .v2m-chev')).toContain('display: none');
  });
  test('the old memory rules are gone from the agent settings sheet', () => {
    expect(read('../agents/v2-agent-settings.css')).not.toContain('v2-agent-memory');
  });
});

describe('task priority and lease signals (TASK-443)', () => {
  const css = readV2Css();
  test('priority remains a monochrome text badge', () => {
    const badge = ruleBody(boardCss, '.v2-feature--board .v2-board__priority');
    expect(badge).toContain('var(--v2-font-mono)');
    expect(badge).toContain('border-radius: 4px');
    expect(badge).toContain('background: none');
    expect(badge).toContain('color: var(--v2-prio-ink)');
    // S4: the frame's .pr1 draws its edge as an inset ring.
    expect(badge).toContain('box-shadow: inset 0 0 0 1px var(--v2-prio-edge)');
    // P0 is the only filled badge: red fill, white label (B-lite, Sam 10-31).
    const urgent = ruleBody(boardCss, '.v2-feature--board .v2-board__priority--p0');
    expect(urgent).toContain('background: var(--v2-prio-p0-bg)');
    expect(urgent).toContain('color: var(--v2-prio-p0-fg)');
    // Status and priority colour are tokens, so the D215 colour choice is a value swap.
    expect(css).toMatch(/--v2-prio-p0-bg:\s*#b42318/);
    expect(css).toMatch(/--v2-prio-p2-fg:\s*#667085/);
    expect(css).toMatch(/--v2-status-live:\s*var\(--v2-accent\)/);
    expect(ruleBody(boardCss, '.v2-feature--board .v2-board__priority--p2')).toContain('color: var(--v2-prio-p2-fg)');
  });
  test('blocked shows through the column dot and P0 badge, not a card rail', () => {
    expect(css).toMatch(/--v2-status-blocked:\s*#d92d20/);
    expect(css).not.toContain('--v2-status-blocked-edge');
    expect(css).not.toMatch(/\.v2-board__card--blocked\s*[,{]/);
    expect(boardCss).not.toMatch(/\.v2-board__card--blocked\s*[,{]/);
    expect(ruleBody(boardCss, '.v2-board__col--blocked .v2-board__col-name')).toContain('color: var(--v2-status-blocked)');
    expect(ruleBody(boardCss, '.v2-feature--board .v2-board__col-dot--blocked')).toContain('background: var(--v2-status-blocked)');
  });
  // D225: a status rail down the side of a card reads as generated UI. A card is
  // told apart by its column and badge, never by an inset side shadow or a
  // coloured border-left. Quote and thread rails are typographic and exempt.
  test('no card selector draws a status rail (inset side shadow or coloured border-left >= 2px)', () => {
    const offenders: string[] = [];
    // Strip comments first: a comment before a rule would otherwise join its selector.
    // The board's cards are styled in their own sheet since S4, so it is read too.
    const bare = `${css}\n${boardCss}`.replace(/\/\*[\s\S]*?\*\//g, '');
    for (const match of bare.matchAll(/([^{}@]+)\{([^{}]*)\}/g)) {
      const selector = match[1].trim();
      const body = match[2];
      if (!/card/i.test(selector) || /quote|thread/i.test(selector)) continue;
      const insetRail = /box-shadow:[^;]*\binset\s+-?[1-9]\d*(?:\.\d+)?px\s+0(?:px)?\s+0/.test(body)
        || /box-shadow:[^;]*\binset\s+0(?:px)?\s+-?[1-9]\d*(?:\.\d+)?px\s+0(?:px)?\s+0/.test(body);
      const leftBorder = /border-(?:left|inline-start)(?:-width)?:\s*([2-9]|\d{2,})(?:\.\d+)?px/.exec(body);
      const leftColoured = leftBorder && !/border-(?:left|inline-start)(?:-color)?:[^;]*(transparent|none)/.test(body);
      if (insetRail || leftColoured) offenders.push(selector);
    }
    expect(offenders).toEqual([]);
  });
  test('live and expired ownership retain distinct dots', () => {
    expect(ruleBody(boardCss, '.v2-feature--board .v2-board__owner-dot--live')).toContain('background: var(--v2-status-live)');
    const expired = ruleBody(boardCss, '.v2-board__owner-dot--expired');
    expect(expired).toContain('border: 1px solid var(--v2-status-idle)');
    expect(expired).toContain('background: none');
  });
});


test('TASK-443 phone ownership sheet keeps its inset and scroll containment', () => {
  const css = readV2Css();
  const sheet = ruleBody(boardCss, '.v2-board .v2-board__detail');
  expect(sheet).toContain('inset: 44px 0 0');
  const modal = ruleBody(css, '.v2-modal');
  expect(modal).toContain('overflow: auto');
  expect(modal).toContain('display: flex');
  expect(modal).toContain('flex-direction: column');
  expect(read('../components/V2PodBoard.tsx')).toContain('className="v2-modal v2-board__detail v2-board__drawer"');
});

test('TASK-699 task detail is a 400px right drawer on desktop and a sheet on phones', () => {
  // d215 .av--20: the claimant and update avatars are 6px-radius tiles with the avatar ring.
  expect(boardCss).toContain('.v2-feature--board .v2-board__detail-updates .v2-board__member-avatar { border-radius: 6px; box-shadow: 0 0 0 1px var(--v2-av-ring); }');
  expect(boardCss).toContain('.v2-feature--board .v2-board__ownership .v2-board__member-avatar,');
  expect(ruleBody(boardCss, '.v2-feature--board .v2-modal.v2-board__drawer')).toContain('width: 400px');
  expect(ruleBody(boardCss, '.v2-feature--board .v2-board__overlay--drawer')).toContain('justify-content: flex-end');
  // S4: the frame draws the drawer over the board with no scrim; phones keep the dim sheet backdrop.
  expect(boardCss).toMatch(/@media \(min-width: 761px\) \{\s*\.v2-feature--board \.v2-board__overlay--drawer \{ background: transparent; \}/);
  expect(ruleBody(boardCss, '.v2-board__overlay')).toContain('background: var(--v2-scrim)');
  expect(read('../components/V2PodBoard.tsx')).toContain('className="v2-modal v2-board__detail v2-board__drawer"');
});


test('TASK-443 lease typography outranks the ownership cell font size', () => {
  expect(ruleBody(boardCss, '.v2-board__ownership .v2-board__lease-value'))
    .toContain('font: 500 12px/16px var(--v2-font-mono)');
  // The frame's kv cell sets its size on the list, not the cell, so the lease font is not outranked.
  expect(ruleBody(boardCss, '.v2-feature--board .v2-board__ownership dd')).not.toContain('font-size');
});

test('TASK-482 sticky bar overlays reserved space with a top border and no shadow', () => {
  const css = read('../components/V2AgentBYO.css');
  const bar = ruleBody(css, '.v2-byo__hosted-offer');
  expect(bar).toContain('position: sticky');
  expect(bar).toContain('bottom: 0');
  expect(bar).toContain('min-height: var(--v2-byo-offer-height)');
  expect(bar).not.toMatch(/(?:^|[;\s])height:/);
  expect(bar).not.toContain('overflow:');
  expect(bar).toContain('margin-top: calc(-1 * var(--v2-byo-offer-height))');
  expect(bar).toContain('border-top: 1px solid var(--v2-border)');
  expect(bar).toContain('background: var(--v2-surface)');
  expect(bar).not.toContain('box-shadow');
  // The frame's layout rule carries no padding; the reserved space is its own
  // rule after it, so the bar's height is still read back by the e2e spec.
  expect(lastRuleBody(css, '.v2-feature--byo .v2-byo__layout')).toContain('padding-bottom: calc(40px + var(--v2-byo-offer-height, 0px))');
  // The bar is the page's last block: its rules sit in the page's own sheet.
  expect(read('../v2.css')).not.toContain('.v2-byo__hosted-offer');
});

test('TASK-482 offer follows the final CTA so existing commands and controls cannot move', () => {
  const source = read('../components/V2AgentBYO.tsx');
  const finalCommand = source.lastIndexOf('className="v2-byo__command"');
  const offer = source.indexOf('role="status" className="v2-byo__hosted-offer"');
  expect(finalCommand).toBeGreaterThan(-1);
  expect(offer).toBeGreaterThan(finalCommand);
  expect(offer).toBeGreaterThan(source.lastIndexOf('className="v2-byo__cta-row"'));
  // Actual before/after top coordinates are asserted by e2e/byo-offer-layout.spec.ts.
});


test('teammate invite cards keep one-column phone controls at the 44px minimum', () => {
  const css = read('../components/V2BringTeammate.css');
  const phone = blockContaining(css, '@media (max-width: 760px)', '.v2-teammate');
  expect(phone).toContain('grid-template-columns: minmax(0, 1fr)');
  expect(phone).toContain('height: 44px');
  expect(phone).toContain('flex-basis: 44px');
  expect(css).toContain('width: calc(100% - 36px)');
  expect(css).toContain('.v2-teammate.v2-teammate--message');
  expect(css).toContain('.v2-teammate .v2-teammate__copy {');
  expect(css).toContain('max-width: 100%');
});

test('standalone teammate invite button keeps desktop and phone touch targets', () => {
  const css = readV2Css();
  const standalone = ruleBody(css, '.v2-chat__new-pod-action--invite > .v2-chat__new-pod-copy');
  expect(standalone).toContain('min-height: 32px');
  expect(standalone).toContain('margin-top: auto');
  expect(css).toMatch(/@media \(max-width: 760px\) \{\s*\.v2-chat__new-pod-action--invite > \.v2-chat__new-pod-copy \{ min-height: 44px;/);
});

describe('run trace layout', () => {
  const css = read('../components/V2RunTrace.css');
  test('long attribution IDs wrap, phone records stack, and links meet touch height', () => {
    expect(css).toContain('overflow-wrap: anywhere');
    expect(css).toContain('min-width: 0');
    expect(css).toContain('min-height: 44px');
    expect(css).toMatch(/@media \(max-width: 760px\)/);
    expect(css).toMatch(/grid-template-columns: minmax\(0, 1fr\)/);
  });
  test('task record downloads wrap at 390 rather than push the page sideways (TASK-562)', () => {
    expect(ruleBody(css, '.v2-task-record__downloads')).toContain('flex-wrap: wrap');
    expect(ruleBody(css, '.v2-task-record__entries')).toContain('list-style: none');
  });
});

test('TASK-531 landing FAQ keeps its measure, rhythm and question style', () => {
  const css = read('../landing/v2-landing.css');
  expect(ruleBody(css, '.v2-landing__faq')).toMatch(/max-width:\s*720px/);
  expect(ruleBody(css, '.v2-landing__faq')).toMatch(/gap:\s*30px/);
  expect(ruleBody(css, '.v2-landing__faq-item')).toMatch(/gap:\s*8px/);
  expect(ruleBody(css, '.v2-landing__faq-item + .v2-landing__faq-item')).toMatch(
    /border-top:\s*1px solid var\(--v2-border-soft\)/,
  );
  expect(ruleBody(css, '.v2-landing__faq-item dt')).toMatch(/font-size:\s*18px/);
  expect(ruleBody(css, '.v2-landing__faq-item dt')).toMatch(/font-weight:\s*600/);
  expect(css).toContain('.v2-landing__faq-item dt::first-letter');
});

test('OpenUI cards keep the approved phone controls and table records', () => {
  const css = read('../cards/uiCard.css');
  expect(css).toContain('@media (max-width:760px)');
  expect(css).toMatch(/\.ui-ft \.ub\{height:44px/);
  expect(css).toContain('.ui-table--records .ui-tw { display:none; }');
  expect(css).toContain('.ui-table--records .ui-recs { display:grid; }');
  expect(css).toContain('.v2-root .v2-msg.v2-ui-card { display:flex; flex-direction:column;');
  expect(css).toContain('.ui.gone{border-style:dashed');
});

test('the card Source line (TASK-607) uses v2 tokens only, one value per token, no dark-only colours', () => {
  const css = read('../cards/uiCard.css');
  const rules = css.split('\n').filter(line => /\.ui-src/.test(line));
  expect(rules.length).toBeGreaterThanOrEqual(4);
  for (const rule of rules.map(line => line.replace(/\[[^\]]*\]/g, ''))) {
    // Colour comes only from v2 tokens (--m muted, --s secondary, --v2-bg). Attribute
    // selectors name the bundled mark's own fills to replace them, so they are stripped first.
    expect(rule).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
    expect(rule).not.toMatch(/data-v2-theme|prefers-color-scheme/);
  }
  expect(css).toContain('.v2-ui-card .ui-src{display:inline-flex;align-items:center;gap:6px;margin-left:auto;min-width:0;font:500 11px/16px var(--mono);color:var(--m)}');
  expect(css).toContain('.v2-ui-card .ui-src-n{color:var(--s)}');
  expect(css).toContain('.v2-ui-card .ui-src-mk>*{display:block;width:16px;height:16px}');
  // The bundled brand fills are replaced, not shown: Sentry's #362D59 is 1.4:1 on the dark card.
  expect(css).toContain('.v2-ui-card .ui-src-mk svg *{fill:currentColor}');
  expect(css).toContain('.v2-ui-card .ui-src-mk svg [fill="#fff"]{fill:var(--v2-bg)}');
  expect(css).toContain('.v2-ui-card .ui-src-mk svg [stroke="#fff"]{stroke:var(--v2-bg);opacity:1}');
  // The aliases resolve to the shared v2 tokens, which carry the theme themselves.
  expect(css).toMatch(/--m:var\(--v2-text-muted\);--s:var\(--v2-text-secondary\)/);
});

describe('v2 board on a phone (TASK-576)', () => {
  test('the board head is the frame\'s one-row 52px top bar, title taking the free width', () => {
    // S4 (d215 .mtop): back, title, search, New task in one row; the title ellipsizes.
    const phone = mediaBlockContaining(boardCss, '.v2-feature--board .v2-board__head');
    const head = ruleBody(boardCss, '.v2-feature--board .v2-board__head', { within: phone });
    expect(head).toContain('height: 52px');
    expect(head).toContain('gap: 8px');
    expect(ruleBody(boardCss, '.v2-board__title-wrap', { within: mediaBlockContaining(boardCss, '.v2-board__title-wrap {') })).toContain('order: 2');
    expect(ruleBody(boardCss, '.v2-feature--board .v2-board__title')).toContain('text-overflow: ellipsis');
    // Exception to the frame: its 32px keys take touches at 44px (chat precedent).
    expect(phone).toContain('.v2-feature--board .v2-board__head > .v2-board__key::after { content: \'\'; position: absolute; inset: -7px; }');
    expect(phone).toContain('width: max(100%, 44px)');
    // No two phone hit areas overlap: keys 12px apart (6px reach each), tabs 44px
    // tall ending at the track edge where the chips' 10px reach begins.
    expect(phone).toContain('.v2-feature--board .v2-board__head > .v2-board__key { position: relative; z-index: 1; }');
    expect(phone).toContain('.v2-feature--board .v2-board__head > .v2-board__new { margin-left: 4px; }');
    expect(phone).toContain('.v2-feature--board .v2-board__tab::after { content: \'\'; position: absolute; top: -14px; right: 0; bottom: -2px; left: 0; }');
    expect(phone).toMatch(/\.v2-feature--board \.v2-board__tabs \{[^}]*padding: 14px 2px 2px;/);
    expect(phone).toMatch(/\.v2-feature--board \.v2-board__tab \{[^}]*height: 28px;/);
    expect(ruleBody(boardCss, '.v2-board__filters', { within: mediaBlockContaining(boardCss, '.v2-board__filters {') })).toContain('padding: 10px 12px 0');
    // Chips sit 8px apart: the P0 chip's 44px area reaches 7px past each edge.
    expect(mediaBlockContaining(boardCss, '.v2-board__filters {')).toContain('.v2-feature--board .v2-board__filters { gap: 8px; }');
    // The drawer's only close control is a 28px key; on a phone it takes touches at 44px.
    expect(phone).toContain('.v2-feature--board .v2-board__drawer-close::after { content: \'\'; position: absolute; inset: -9px; }');
  });

  test('a drawer update keeps its author for screen readers though the frame draws only the face', () => {
    expect(read('../components/V2PodBoard.tsx')).toContain('<span className="v2-board__update-author">{update.author}: </span>');
    const hidden = ruleBody(boardCss, '.v2-board__update-author');
    expect(hidden).toContain('clip-path: inset(50%)');
    expect(hidden).toContain('position: absolute');
  });

  test('the board\'s filled keys keep a hover state', () => {
    expect(boardCss).toContain('.v2-feature--board .v2-board__key--ink:hover { background: var(--v2-ink-hover); }');
    expect(boardCss).toContain('.v2-feature--board .v2-board__key--soft:hover { background: var(--v2-key-b); }');
  });

  test('the board drops the feature body gutter, phone included', () => {
    expect(ruleBody(boardCss, '.v2-feature--board > .v2-feature__body')).toMatch(/padding:\s*0;/);
  });

  test('the board route passes the class that opts it into that override', () => {
    expect(read('../V2App.tsx')).toMatch(
      /<V2PodBoard \/>,\s*false,\s*\/\*[^*]*\*\/\s*false,\s*'v2-feature--board'/,
    );
  });

  test('feature panes reserve the tab bar height so the body stops above the fixed nav', () => {
    const css = readV2Css();
    const phone = mediaBlockContaining(css, 'padding-bottom: 58px');
    expect(ruleBody(phone, '.v2-feature')).toContain('padding-bottom: 58px');
    expect(ruleBody(phone, '.v2-mobile-tabs')).toContain('height: 58px');
  });

  test('hosted meter track keeps its flex width and clips the fill inside the card', () => {
    const teamCss = read('../components/V2YourTeamPage.css');
    expect(ruleBody(teamCss, '.v2-team .v2-team-card__meter-track')).toContain('flex: 1');
    expect(ruleBody(teamCss, '.v2-team .v2-team-card__meter-track')).toContain('min-width: 0');
    expect(ruleBody(teamCss, '.v2-team .v2-team-card__meter-track')).toContain('overflow: hidden');
  });

  test('character avatars keep their hairline ring rule (TASK-679, load-bearing)', () => {
    expect(readV2Css()).toMatch(
      /\.v2-avatar:has\(img\)\.v2-avatar--character:not\(\.v2-avatar--flat\)\s*\{\s*box-shadow:\s*0 0 0 1px var\(--v2-avatar-frame\);/,
    );
  });

  test('feature pages mount the phone tab bar and share one attention count with the rail', () => {
    const page = read('../components/V2FeaturePage.tsx');
    expect(page).toContain("import V2MobileTabs from './V2MobileTabs';");
    expect(page).toContain('const attention = useV2PodAttention();');
    expect(page).toContain('<V2NavRail needsYouCount={attention.count} />');
    expect(page).toContain('<V2MobileTabs needsYouCount={attention.count ?? 0} />');
  });
});

describe('claim run summary (TASK-692)', () => {
  test('the toggle is a real button styled as a control, with its state on aria-expanded', () => {
    const css = readV2Css();
    const toggle = css.match(/\.v2-root button\.v2-claim-run__toggle \{[^}]*\}/);
    expect(toggle).not.toBeNull();
    // S3a: the D215 .sumrow bar — 34px, r9, subtle fill, soft inset ring.
    expect(toggle![0]).toMatch(/box-shadow: inset 0 0 0 1px var\(--v2-border-soft\)/);
    expect(toggle![0]).toContain('height: 34px');
    expect(toggle![0]).toContain('background: var(--v2-bg-subtle)');
    expect(css).toMatch(/\.v2-claim-run__toggle\[aria-expanded='true'\] > \.v2-claim-run__chev \{ transform: rotate\(180deg\); \}/);
    // The chevron is a state mark: text-muted (4.76:1 on the bar), not --ph (2.46:1).
    expect(ruleBody(css, '.v2-claim-run__toggle > .v2-claim-run__chev')).toContain('color: var(--v2-text-muted)');
  });
});

describe('pod board column scroll (TASK-698)', () => {
  const css = readV2Css();
  test('the board route scrolls inside its columns, not the page', () => {
    expect(css).not.toContain('.v2-feature--board');
    // The feature body was the scroller and its legacy wrapper had auto height, so the
    // columns' max-height:100% resolved to nothing (85.5x at 1440, measured 12f608b71).
    const body = ruleBody(boardCss, '.v2-feature--board .v2-feature__body');
    expect(body).toContain('display: flex');
    expect(body).toContain('overflow: hidden');
    const legacy = ruleBody(boardCss, '.v2-feature--board .v2-feature__legacy');
    expect(legacy).toContain('width: 100%');
    expect(legacy).toContain('min-height: 0');
    expect(legacy).toContain('display: flex');
    expect(lastRuleBody(boardCss, '.v2-feature--board .v2-board')).toContain('flex: 1 1 auto');
    // S4: the column clips (d215 .col) and its body is the scroller.
    const col = ruleBody(boardCss, '.v2-feature--board .v2-board__col');
    expect(col).toContain('min-height: 0');
    expect(col).toContain('overflow: hidden');
    expect(ruleBody(boardCss, '.v2-feature--board .v2-board__col-body')).toContain('overflow-y: auto');
  });
  test('a long focus list is bounded so the columns keep room below it', () => {
    const focus = ruleBody(boardCss, '.v2-board__focus[open]');
    expect(focus).toContain('max-height: 40vh');
    expect(focus).toContain('overflow-y: auto');
  });

  // TASK-702: on a phone the header Invite is glyph-only, or its label takes
  // the pod name's width and the title truncates to a few characters.
  test('the header Invite hides its label on a phone, keeping it for screen readers', () => {
    const block = mediaBlockContaining(readV2Css(), '.v2-pod-header__invite span');
    expect(block).toMatch(/\.v2-pod-header__invite span\s*\{[^}]*clip-path:\s*inset\(50%\)/);
    expect(block).toMatch(/\.v2-pod-header__invite\s*\{[^}]*width:\s*32px/);
    // The ghost override drops the key's shadow, so the phone restates the focus ring.
    expect(block).toContain('.v2-root button.v2-pod-header__invite:focus-visible { box-shadow: 0 0 0 3px var(--v2-accent-soft), 0 0 0 1px var(--v2-accent); }');
    // 32px keys take touches at 44px. The inset runs from the padding box,
    // inside a 1px border, so it is -7px: 30 + 2 x 7 = 44 (-6px measured 42 in a browser).
    // The header keys and the composer keys shared one rule until D223 lifted
    // them into separate chat files (S3b, S3c); each half keeps the same shape.
    const phoneHead = mediaBlockContaining(readV2Css(), '.v2-root button.v2-thread__back::after');
    for (const key of ['v2-thread__back', 'v2-pod-header__invite', 'v2-thread__inspector-toggle', 'v2-composer__plus', 'v2-composer__send']) {
      const keyBlock = mediaBlockContaining(readV2Css(), `.v2-root button.${key}::after`);
      expect(keyBlock).toMatch(/::after \{\s*content: '';\s*position: absolute;[^}]*inset: -7px;\s*\}/);
      // z-index keeps every key's hit area above later positioned siblings.
      const raised = keyBlock.match(/([^{}]*)\{ position: relative; z-index: 1; \}/);
      expect(raised).not.toBeNull();
      expect(raised![1]).toContain(`.v2-root button.${key}`);
    }
    // The 12px gap is what keeps neighbouring 44px areas from overlapping.
    expect(phoneHead).toMatch(/\.v2-pod-header \.v2-thread__header-row \{[^}]*gap: 12px;/);
  });

  test('the board keeps three columns plus a 120px done rail, and tabs only on phones (TASK-687)', () => {
    const css = boardCss;
    expect(css).toMatch(/\.v2-board__columns \{[^}]*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\) 120px/);
    expect(css).toMatch(/\.v2-board__tabs \{ display: none; \}/);
    // Card actions stay on the id row (off the title); card buttons keep a visible focus ring.
    expect(css).toMatch(/\.v2-board__card-actions \{ position: absolute; right: 6px; top: 6px;/);
    expect(css).toMatch(/button\.v2-board__card-main:focus-visible[^{]*\{[^}]*outline: 2px solid/);
    // The column body is the scroller; the page itself does not scroll.
    const colBody = ruleBody(css, '.v2-feature--board .v2-board__col-body');
    expect(colBody).toContain('overflow-y: auto');
    expect(colBody).toContain('flex: 1');
    expect(colBody).toContain('min-height: 0');
    // Phones get the tab bar back: scope to the 390 frame's block.
    const mobile = css.slice(css.indexOf('/* ── 2. The 390 frame'));
    expect(mobile).toMatch(/@media \(max-width: 760px\) \{[\s\S]*\.v2-board__tabs \{ position: relative; display: inline-flex;/);
    // The phone tabs are the frame's segment: a tinted track with a raised active key.
    // The track is drawn 12px below the bar by ::before, so the tabs' hit areas can reach into that gap.
    expect(mobile).toMatch(/\.v2-board__tabs \{ position: relative; display: inline-flex;[^}]*margin: 0 12px; gap: 2px; padding: 14px 2px 2px;/);
    expect(mobile).toMatch(/\.v2-board__tabs::before \{[^}]*top: 12px;[^}]*background: var\(--v2-surface-tint\);/);
    expect(mobile).toMatch(/\.v2-board__tab\.is-active \{ background: var\(--v2-surface\)/);
  });
});

describe('Connect lifted from the d215 frame (R05)', () => {
  const v2 = read('../v2.css');
  const connectCss = read('../components/V2ConnectPage.css');
  const connect = read('../components/V2ConnectPage.tsx');

  test('the page imports its own sheet and v2.css carries no Connect rule', () => {
    expect(connect).toContain("import './V2ConnectPage.css';");
    // `v2-connect__` and the bare root; `v2-connector*` is a different surface.
    expect(v2).not.toMatch(/\.v2-connect(__|[\s,{:])/);
  });

  // Deviation from the frame: Copy is a 28px key, so on a phone an invisible
  // ::after ring makes its hit area 44px. With the key's 1px border, `inset`
  // measures from the 26px padding box, so -9px is what reaches 44.
  test('on a phone, Copy keeps its 28px key and gains a 44px hit ring', () => {
    const key = ruleBody(connectCss, '.v2-connect .v2-connect__copy');
    expect(key).toContain('height: 28px');
    expect(key).toContain('border: 1px solid var(--v2-key-edge)');
    expect(key).toContain('position: relative');
    const phone = mediaBlockContaining(connectCss, '.v2-connect .v2-connect__copy::after');
    const ring = ruleBody(connectCss, '.v2-connect .v2-connect__copy::after', { within: phone });
    expect(ring).toContain('content: ""');
    expect(ring).toContain('position: absolute');
    expect(ring).toContain('inset: -9px');
  });

  test('on a phone, links and the agent lane acts are 44px tall', () => {
    const phone = mediaBlockContaining(connectCss, '.v2-connect .v2-connect__link');
    expect(ruleBody(connectCss, '.v2-connect .v2-connect__link', { within: phone })).toContain('min-height: 44px');
    expect(selectorRuleBody(phone, '.v2-connect .v2-connect__cta, ')).toContain('height: 44px');
    // The same rule must size both keys, the CTA and the secondary, not the CTA alone.
    expect(phone).toContain('.v2-connect .v2-connect__cta, .v2-connect .v2-connect__lane > .v2-connect__secondary, .v2-connect .v2-connect__secondary { align-self: stretch; height: 44px;');
  });

  // The v2.css :lang(zh) reset (TASK-055) scans only v2.css, so the entry that
  // left it with this page is held here: every negative-tracking selector in
  // the sheet has a zh reset in the same sheet.
  test('zh-CN: every negative-tracking Connect title is reset under :lang(zh)', () => {
    const negative = [...connectCss.matchAll(/\n([^\n{}]+) \{[^}]*letter-spacing:\s*-[^;]+;/g)]
      .flatMap((m) => m[1].split(',').map((sel) => sel.trim()))
      .filter(Boolean);
    expect(negative).toEqual(['.v2-connect .v2-connect__lane h2']);
    for (const sel of negative) {
      expect(ruleBody(connectCss, `.v2-root:lang(zh) ${sel}`)).toContain('letter-spacing: 0');
    }
  });
});

describe('Your team lifted from the d215 frame (R06)', () => {
  const v2 = read('../v2.css');
  const teamCss = read('../components/V2YourTeamPage.css');
  const team = read('../components/V2YourTeamPage.tsx');

  test('the page imports its own sheet and v2.css carries no Your team rule', () => {
    expect(team).toContain("import './V2YourTeamPage.css';");
    // `v2-team__`, `v2-team-card` and the bare root; `v2-teammate` is
    // V2BringTeammate's own surface (V2BringTeammate.css), not this page's.
    expect(v2).not.toMatch(/\.v2-team(__|-card|[\s,{:.])/);
  });

  // The keys and the avatar mark paint a box-shadow. Class-only selectors
  // (0,2,0) leave `.v2-root button:focus-visible` (0,2,1) free to paint the
  // focus ring over it; a `button.` prefix would tie it and, loading later,
  // erase the ring.
  test('the keyed controls stay class-only so the shared focus ring outranks their shadow', () => {
    expect(teamCss).not.toMatch(/button\.v2-team(__byo|__hire|-card__answer|-card__talk|-card__mark)/);
    expect(selectorRuleBody(teamCss, '\n.v2-team .v2-team__byo, .v2-team .v2-team-card__talk {')).toContain('box-shadow: var(--v2-key-inset)');
  });

  test('on a phone, every drawn act and the avatar mark are 44px', () => {
    const phone = mediaBlockContaining(teamCss, '.v2-team .v2-team__grid');
    expect(selectorRuleBody(phone, '.v2-team .v2-team__byo, .v2-team .v2-team__hire, ')).toContain('height: 44px');
    expect(ruleBody(teamCss, '.v2-team .v2-team-card__mark', { within: phone })).toContain('width: 44px');
    expect(ruleBody(teamCss, '.v2-team .v2-team-card__mark', { within: phone })).toContain('height: 44px');
  });

  // Deviation from the frame: the two text links (Have an invitation code?,
  // 20px; Connected agents, 16px) are not drawn. On a phone an invisible ring
  // 14px above and below makes each hit area at least 44px.
  test('on a phone, the text links gain a 44px hit ring', () => {
    expect(ruleBody(teamCss, '.v2-team button.v2-team__link')).toContain('position: relative');
    const phone = mediaBlockContaining(teamCss, '.v2-team button.v2-team__link::after');
    const ring = ruleBody(teamCss, '.v2-team button.v2-team__link::after', { within: phone });
    expect(ring).toContain('content: ""');
    expect(ring).toContain('position: absolute');
    expect(ring).toContain('inset: -14px 0');
  });

  // Undrawn controls in the phone block that follows the base rules: the code
  // input matches its 44px buttons, and the Connected agents ring (14px below
  // the link) clears the first chip row.
  test('on a phone, the code input is 44px and the internal ring clears the chips', () => {
    const phone = mediaBlockContaining(teamCss, '.v2-team .v2-team__redeem-input');
    expect(ruleBody(teamCss, '.v2-team .v2-team__redeem-input', { within: phone })).toContain('height: 44px');
    expect(ruleBody(teamCss, '.v2-team .v2-team__internal', { within: phone })).toContain('gap: 14px');
    // The override must come after the base rules or the base wins.
    expect(teamCss.indexOf(phone)).toBeGreaterThan(teamCss.indexOf('.v2-team .v2-team__redeem-input {'));
    expect(teamCss.indexOf(phone)).toBeGreaterThan(teamCss.indexOf('.v2-team .v2-team__internal {'));
  });

  // The v2.css :lang(zh) reset (TASK-055) scans only v2.css, so the entries
  // that left it with this page are held here: every negative-tracking
  // selector in the sheet has a zh reset in the same sheet.
  test('zh-CN: every negative-tracking Your team title is reset under :lang(zh)', () => {
    const negative = [...teamCss.matchAll(/\n([^\n{}]+) \{[^}]*letter-spacing:\s*-[^;]+;/g)]
      .flatMap((m) => m[1].split(',').map((sel) => sel.trim()))
      .filter(Boolean);
    expect(negative).toEqual([
      '.v2-team .v2-team__title',
      '.v2-team .v2-team-card__name',
      '.v2-team .v2-team__empty-title',
    ]);
    const start = teamCss.indexOf('.v2-root:lang(zh) .v2-team .v2-team__title');
    expect(start).toBeGreaterThan(-1);
    const reset = teamCss.slice(start, teamCss.indexOf('}', start));
    expect(reset).toContain('letter-spacing: 0');
    for (const sel of negative) expect(reset).toContain(`.v2-root:lang(zh) ${sel}`);
  });
});

describe('chat sheets lifted out of v2.css (S3)', () => {
  const chatSheets = ['chat-message', 'chat-pane', 'chat-composer', 'chat-inspector', 'chat-states']
    .map((name) => read(`../chat/${name}.css`));

  test('the rules the landing demo renders stay in v2.css, which is all the landing loads', () => {
    const v2Only = read('../v2.css');
    expect(v2Only).toMatch(/\n\.v2-msg \{/);
    expect(v2Only).toMatch(/\n\.v2-decision-card__options \{/);
    expect(v2Only).toMatch(/\n\.v2-decision-card__option \{/);
    // Selectors only: a comment may name the class to say it stayed behind.
    for (const sheet of chatSheets) expect(sheet.replace(/\/\*[\s\S]*?\*\//g, '')).not.toContain('.v2-decision-card');
  });

  test('the phone thread foot keys take touches at 44px, measured inside their 1px border', () => {
    expect(chatSheets[1]).toContain(".v2-root .v2-thread-replies__foot .v2p-b-sm::after { content: ''; position: absolute; inset: -7px; }");
  });

  test('a UI card posted as a thread reply keeps its own stack gap', () => {
    expect(chatSheets[1]).toContain('.v2-thread .v2-thread-replies .v2-msg.v2-ui-card { gap: 4px; }');
  });

  test('every token the chat sheets read is defined', () => {
    for (const sheet of chatSheets) expect(sheet).not.toMatch(/var\(--v2-text\)/);
  });
});
