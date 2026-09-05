import fs from 'fs';
import path from 'path';

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

// Grab the body of the first `<selector> { ... }` block. Selectors here have no
// nested braces, so a naive slice to the next `}` is sufficient.
const ruleBody = (css: string, selector: string): string => {
  // Prefer a selector at the start of a CSS line. A descendant selector can
  // contain the same text (`.parent .target {`) and is not the rule being
  // pinned.
  const lineStart = css.indexOf(`\n${selector} {`);
  const start = lineStart === -1 ? css.indexOf(`${selector} {`) : lineStart + 1;
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

const cssVariable = (css: string, name: string): string | undefined => (
  new RegExp(`${name}\\s*:\\s*([^;]+);`).exec(css)?.[1].trim()
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
  const v2 = read('../v2.css');
  const tokens = read('../../../design-system/tokens.css');
  const aprofile = read('../agents/v2-agent-profile.css');
  const landing = read('../landing/v2-landing.css');
  const podChat = read('../components/V2PodChat.tsx');
  const podBoard = read('../components/V2PodBoard.tsx');
  const activityPage = read('../components/V2ActivityPage.tsx');
  const v2App = read('../V2App.tsx');
  const app = read('../../App.tsx');
  const appStyles = read('../../App.css');
  const settingsPage = read('../components/V2SettingsPage.tsx');
  const avatar = read('../components/V2Avatar.tsx');
  const billingPanel = read('../components/V2BillingPanel.tsx');
  const appsManagement = read('../../components/AppsManagement.tsx');

  test('Your Team card name owns its line so the category chip cannot crush it', () => {
    const rule = ruleBody(v2, '.v2-team-card__name');
    expect(rule).toContain('flex: 1 0 100%');
    expect(rule).toContain('min-width: 0');
  });

  test('Your Team card name WRAPS — a primary identifier never one-line-ellipsizes (craft audit rule 1)', () => {
    // At 1440px half the fleet's names truncated ("Commonly…", "Pod Summ…").
    // The name wraps to two lines; single-line nowrap+ellipsis was the defect.
    const rule = ruleBody(v2, '.v2-team-card__name');
    expect(rule).toContain('white-space: normal');
    expect(rule).toContain('-webkit-line-clamp: 2');
    expect(rule).not.toContain('white-space: nowrap');
  });

  test('sidebar pod name WRAPS — it never loses to its own timestamp (craft audit finding 8)', () => {
    // "Sharpen — pod m…", "Team Orchestra…": the name shared its line with the
    // relative time and ellipsized at desktop width. Same primary-identifier
    // rule as the team-card name: wrap to two lines, and the timestamp lives
    // on the snippet row so it never competes with the name at all.
    const title = ruleBody(v2, '.v2-pods__item-title');
    expect(title).toContain('-webkit-line-clamp: 2');
    expect(title).not.toContain('white-space: nowrap');
    expect(v2).toContain('.v2-pods__item-snippet-row');
  });

  test('the unread dot stays clear of the rounded row corner (name-wrap side effect)', () => {
    // The title-row is align-items: flex-start (for the 2-line name wrap),
    // which parks the dot flush at the row's top-right — inside the row's
    // border-radius + overflow:hidden clip, where the rounding visibly
    // shaved it (reported live 2026-08-22). Both margins are load-bearing:
    // top centers it on the first text line, right clears the 10px curve.
    // jsdom cannot see corner clipping — presence pin per this file's rule.
    const dot = ruleBody(v2, '.v2-pods__item-dot');
    expect(dot).toContain('margin-top: 6px');
    expect(dot).toContain('margin-right: 4px');
  });

  test('grouped messages keep the avatar column so text never shifts (craft audit rule 3)', () => {
    // Consecutive same-author messages within the grouping window drop the
    // header row; the ghost cell must match the .v2-msg grid's 38px avatar
    // column or grouped text mis-aligns with headed text by exactly the
    // avatar width — a defect jsdom cannot see.
    expect(ruleBody(v2, '.v2-msg')).toContain('grid-template-columns: 38px');
    expect(ruleBody(v2, '.v2-msg__avatar-ghost')).toContain('width: 38px');
    expect(v2).toContain('.v2-msg--grouped');
  });

  test('direct-agent liveness stays above the composer as a stable, readable row', () => {
    // A successful DM POST is not proof of an active seat. This row keeps
    // liveness and the bounded reply wait outside the scrollable transcript
    // and outside the textarea, so both remain visible while composing.
    const status = ruleBody(v2, '.v2-chat__agent-room-status');
    expect(status).toContain('margin: 8px 24px 0');
    expect(status).toContain('font-size: 12px');
    const waiting = ruleBody(v2, '.v2-chat__agent-room-status--wait');
    expect(waiting).toContain('background: var(--v2-surface-hover)');
    expect(waiting).toContain('font-family: var(--v2-font-mono)');
  });

  test('runtime vocabulary stays off Your Team cards (ADR-022 D1, ratified)', () => {
    // The chip shipped in violation of the ratified rule; the craft audit
    // (finding 2) removed it. This pins the removal against reintroduction.
    expect(v2).not.toContain('.v2-team-card__runtime {');
  });

  test('touch inputs are 16px — iOS auto-zoom never fires and never strands the page zoomed', () => {
    // Every input under 16px makes iOS Safari zoom on focus and stay zoomed
    // on blur (Sam, 2026-08-26). The floor lives in the touch media block and
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
    expect(v2).toMatch(/\.v2-activity__queue-actions,\n\.v2-activity__queue-row button,[\s\S]*?\{\n\s*display: flex;[\s\S]*?gap: 6px;/);
    expect(v2).toMatch(/@media \(max-width: 640px\)[\s\S]*?\.v2-activity__queue-actions \{ grid-column: 2; \}[\s\S]*?\.v2-activity__queue-actions \{ flex-wrap: wrap; \}/);
    expect(v2).toMatch(/@media \(max-width: 640px\)[\s\S]*?\.v2-root \.v2-activity__queue-actions button \{ min-height: 44px; \}/);
  });

  test('DecisionRequest options are full-width content with one recommended primary choice', () => {
    // The first build left options inside the narrow actions column. Generic
    // queue-button CSS then made every non-recommended option blue while the
    // recommended one looked secondary — exactly backwards for a fork card.
    const decisionActions = ruleBody(v2, '.v2-activity__queue-row--decision .v2-activity__queue-actions');
    expect(decisionActions).toContain('grid-column: 1 / -1');
    expect(decisionActions).toContain('justify-content: flex-start');

    const neutralOption = ruleBody(v2, '.v2-root .v2-activity__queue-actions button.v2-activity__option');
    expect(neutralOption).toContain('border: 1px solid var(--v2-border)');
    expect(neutralOption).toContain('background: var(--v2-surface)');
    expect(neutralOption).toContain('border-radius: 999px');

    const recommendedOption = ruleBody(v2, '.v2-root .v2-activity__queue-actions button.v2-activity__option--recommended');
    expect(recommendedOption).toContain('background: var(--v2-ink)');
    expect(recommendedOption).toContain('color: var(--v2-on-ink)');
    expect(v2).toContain('.v2-activity__option-description');
  });

  test('the mobile inspector is a drawer, never display:none — the header avatars button must do something', () => {
    // Below 1024px the pane used display:none while V2Layout still mounted it
    // on tap: the avatar-stack button looked broken and members/files were
    // unreachable on phones (Sam, 2026-08-26). The pane's presence in the DOM
    // is the open state, so the drawer needs no extra toggle class.
    // Slice the 1023px block out rather than regex across it — a lazy
    // [\s\S]*? happily crosses media-block boundaries and matches unrelated
    // rules pages later.
    const start = v2.indexOf('@media (max-width: 1023px)');
    expect(start).toBeGreaterThan(-1);
    const block = v2.slice(start, v2.indexOf('@media', start + 10));
    expect(block).toContain('.v2-pane--inspector');
    expect(block).toContain('position: fixed');
    expect(block).not.toContain('display: none');
    // The 760px secondary-pane eraser out-specifies the drawer (0-4-0 vs
    // 0-1-0); the inspector must be in its :not chain or the drawer is a
    // mounted-but-invisible pane again — the exact live bug, twice.
    expect(v2).toContain(':not(.v2-pods-aside):not(.v2-pane--inspector)');
  });

  test('v2 claims the page canvas — the V1 dark body cannot show through', () => {
    // App.tsx stamps `modern-ui` (V1 dark gradient) on <body> unconditionally;
    // .v2-root paints only its own box. Without this override the V1 dark
    // showed on load flash, overscroll, and gaps (Sam, 2026-08-24). The
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
    // Rev 2 (Sam re-sighted the flash, 2026-08-26): the script-gate had a
    // timing window — delayed head-script execution painted the prerender.
    // Hidden-by-default has none: #seo-page is display:none from the first
    // byte, and <noscript> reveals it only for text-only crawlers. The
    // noscript override must carry !important to beat the base rule.
    expect(indexHtml).toContain('#seo-page { display: none; }');
    expect(indexHtml).toMatch(/<noscript><style>#seo-page \{ display: block !important; \}<\/style><\/noscript>/);
  });

  test('the conversation column is FULL-WIDTH — no measure cap, one left edge (rule 2, v5)', () => {
    // Fifth mechanism, ruled by Sam 2026-08-23: the Slack model. With a
    // line cap, leftover space must pool somewhere — center was rejected,
    // and left-anchor pools it all on the right — so the cap itself goes.
    // No revision may reintroduce a conversation measure token: that is
    // the corner-of-the-triangle debate re-opening by accident.
    expect(v2).not.toContain('--v2-conv-measure');
    // v6 (2026-09-01): the var ban was not enough — #1367 reintroduced the
    // cap as a LITERAL (`max-width: 75ch`) via a craft audit that called it
    // a P0, and even claimed this test guarded it. Sam's third ruling:
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
    expect(ruleBody(v2, '.v2-chat__composer > *')).toContain('margin-inline: 0');
    // Nothing in the column may escape the shared edge (Sam, 2026-08-23:
    // mentions and threads sat off-grid while messages aligned).
    // Mentions: the wash bleed must equal the padding (the old -12px against
    // 10px padding put mention TEXT 2px off-grid), widening the wash by one
    // padding per side into the pane gutter.
    expect(ruleBody(v2, '.v2-chat__messages > .v2-msg--mention'))
      .toContain('margin-inline: -10px');
    expect(ruleBody(v2, '.v2-chat__messages > .v2-msg--mention'))
      .toContain('width: calc(100% + 20px)');
    // Threads: card + rail travel inside one block-level child, indented
    // to the message TEXT column like an attachment (38px avatar + 12px
    // gap), whose bottom margin terminates the rail before the next
    // outer message.
    expect(ruleBody(v2, '.v2-thread-block')).toContain('margin-left: 50px');
    // Indent + width must sum to 100%: the column's `> *` width:100% plus
    // the 50px indent pushed every thread 50px past the pane's right edge,
    // making the transcript horizontally swipeable — worst on phones
    // (Sam, 2026-08-24; measured 350 vs 326 scrollWidth at 390px).
    expect(ruleBody(v2, '.v2-thread-block')).toContain('width: calc(100% - 50px)');
    expect(v2).toMatch(/@media \(max-width: 640px\)[\s\S]*?\.v2-thread-block \{[\s\S]*?width: calc\(100% - 24px\)/);
    // Belt-and-braces: the transcript itself never scrolls sideways.
    expect(ruleBody(v2, '.v2-chat__messages')).toContain('overflow-x: hidden');
    expect(ruleBody(v2, '.v2-thread-block')).toContain('margin-bottom');
  });

  test('motion timing is tokenized and all three existing V2 animations consume it', () => {
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

    expect(ruleBody(v2, '.v2-chat__typing-dots > span')).toContain('var(--motion-breath)');
    expect(ruleBody(v2, '.v2-inspector__now-pulse')).toContain('var(--motion-pulse)');
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
    expect(ruleBody(v2, '.v2-team__grid')).toContain('minmax(min(320px, 100%), 1fr)');
  });

  test('the agent profile page overrides the app-shell overflow too (sibling invariant)', () => {
    // Any full-page `.v2-root.<surface>` must set its own scroll, or the base
    // `.v2-root { height:100vh; overflow:hidden }` clips it. This is the general
    // rule the showcase bug taught us; keep the known-good example pinned.
    expect(ruleBody(aprofile, '.v2-root.v2-aprofile')).toContain('overflow-y: auto');
  });

  test('the nav rail pane lets its language dropdown escape the pane clip', () => {
    // The rail is 76px wide; its language menu is a wider floating popover.
    // Base `.v2-pane { overflow: hidden }` clips it to the rail edge, so the
    // menu rendered cut-off "outside the sidebar" (2026-07-23). `.v2-pane--rail`
    // must override to overflow: visible so the menu floats over the pods sidebar.
    expect(ruleBody(v2, '.v2-pane--rail')).toContain('overflow: visible');
  });

  test('team-card actions wrap on narrow screens so the agent name keeps width', () => {
    // At <=560px the Profile+Talk-to actions row must wrap to its own line —
    // inline, it squeezes the flex body to zero and the agent NAME disappears
    // (2026-07-05 mobile smoke; same crush family as the #568 chip bug).
    const idx = v2.indexOf('.v2-team-card__actions {\n    flex-basis: 100%');
    expect(idx).toBeGreaterThan(-1);
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
    expect(settingsPage).toContain('<SettingsSection id="plan" title="Plan">');
    expect(settingsPage).toContain('<SettingsSection id="devices" title="Devices">');
    expect(settingsPage).toContain('<SettingsSection id="api-token" title="API token">');
    expect(settingsPage).toContain('<SettingsSection id="connected-apps" title="Connected apps">');
    expect(settingsPage).toContain('<SettingsSection id="language" title="Language">');
    expect(settingsPage).toContain('className="v2-settings__avatar"');
    expect(settingsPage).toContain('src={currentUser?.profilePicture || undefined}');
    expect(settingsPage).toContain('<AppsManagement variant="settings" />');
    expect(settingsPage).toContain('<V2BillingPanel showHeading={false} />');
    expect(settingsPage).toContain('<V2DevicesPanel showHeading={false} />');
    expect(ruleBody(v2, '.v2-settings__avatar')).toContain('width: 40px');
    expect(ruleBody(v2, '.v2-settings__avatar')).toContain('border-radius: var(--v2-radius-sm)');
    expect(ruleBody(v2, '.v2-settings__avatar img')).toContain('border-radius: var(--v2-radius-sm)');
    expect(avatar).toContain("borderRadius: 'inherit'");
    expect(v2App).toMatch(/path="settings\/devices"\s+element=\{<Navigate to="\/v2\/settings" replace \/>\}/);
    expect(v2App).toMatch(/path="profile"\s+element=\{<Navigate to="\/v2\/settings" replace \/>\}/);
    expect(v2App).toContain('path="profile/:id"');
    expect(v2App).toContain('<UserProfile />');
    expect(app).toContain('<Route path="/settings/devices" element={<Navigate to="/v2/settings" replace />} />');
  });

  test('Settings section labels navigate to their own anchored sections', () => {
    expect(settingsPage).toContain('className="v2-settings__nav"');
    expect(settingsPage).toContain('className={`v2-settings__nav-link${activeSection === id');
    expect(settingsPage).toContain('href={`#${settingsSectionId(id)}`}');
    expect(ruleBody(v2, '.v2-settings__section')).toContain('scroll-margin-top: 24px');
    expect(ruleBody(v2, '.v2-root a.v2-settings__nav-link:focus-visible')).toContain('outline: 2px solid var(--v2-accent)');
    expect(ruleBody(v2, '.v2-root a.v2-settings__nav-link--active')).toContain('background: var(--v2-bg-subtle)');
    expect(ruleBody(v2, '.v2-settings__nav')).toContain('position: sticky');
  });

  test('Settings saves a display name while keeping the handle read-only and exposing the email change affordance', () => {
    expect(settingsPage).toContain('className="v2-settings__account-fields"');
    expect(settingsPage).toContain('await updateProfile({ displayName: nextName });');
    expect(settingsPage).toContain('value={accountUsername} readOnly aria-readonly="true"');
    expect(settingsPage).toContain('className="v2-settings__email-control"');
    expect(settingsPage).toContain('id="v2-settings-email" type="email" value={email} onChange={(event) => setEmail(event.target.value)}');
    expect(settingsPage).toContain('type="button">Change</button>');
    expect(settingsPage).not.toContain('Email changes go through re-verification; ask us for now.');
    expect(settingsPage).not.toContain('v2-settings__nav-note');
    expect(ruleBody(v2, '.v2-settings__account-fields')).toContain('grid-template-columns: repeat(2, minmax(0, 1fr))');
    expect(ruleBody(v2, '.v2-settings__account-fields > .v2-settings__account-email')).toContain('grid-column: 1 / -1');
    expect(ruleBody(v2, '.v2-settings__account-fields input')).toContain('border-radius: var(--v2-radius-sm)');
    expect(ruleBody(v2, '.v2-settings__email-control')).toContain('display: flex');
    const accountForm = ruleBody(v2, '.v2-settings form.v2-settings__account');
    expect(accountForm).toContain('padding: 0');
    expect(accountForm).toContain('background: transparent');
    expect(accountForm).toContain('box-shadow: none');
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
    const badge = ruleBody(v2, '.v2-settings__section .v2-billing__badge');
    expect(badge).toContain('background: #ffffff');
    expect(badge).toContain('font-family: var(--v2-font-mono)');
    expect(ruleBody(v2, '.v2-settings__section .v2-billing__badge--pro')).toContain('background: var(--v2-accent)');
  });

  test('Settings flattens connected apps and folds Developer Tips under the form', () => {
    expect(appsManagement).toContain("const isSettingsVariant = variant === 'settings'");
    expect(appsManagement).toContain('{!isSettingsVariant && <WebhookIcon color="primary" />}');
    expect(appsManagement).toContain('{!isSettingsVariant && <SettingsIcon color="primary" />}');
    expect(appsManagement).toContain('className="apps-management__developer-tips"');
    expect(appsManagement).toContain('{!isSettingsVariant && (');
    expect(appsManagement).toContain('? <Box className={className}>{children}</Box>');
    expect(ruleBody(v2, '.v2-settings .apps-management--settings .apps-management__section + .apps-management__section')).toContain('border-top: 1px solid var(--v2-border-soft)');
    expect(ruleBody(v2, '.v2-settings .apps-management--settings .apps-management__integration')).toContain('border: 1px solid var(--v2-border)');
  });

  test('the Community offer stays visible below the independently scrolling pod list', () => {
    // The list owns overflow-y; the offer is its flex sibling. Preventing the
    // card from shrinking is what keeps the Join HQ action reachable when the
    // sidebar contains many pods.
    expect(ruleBody(v2, '.v2-pods__community')).toContain('flex-shrink: 0');
  });

  test('the four pod filters stay on one row in the narrow sidebar', () => {
    // Third mechanism (Sam, 2026-08-23): content-sized chips. The equal-grid
    // versions allocated width backwards (wide boxes for short words, a
    // capped box for the longest) and scattered zh-CN's four 2-character
    // labels across phantom cells. Chips hug their labels with uniform
    // padding, so both locales read as one segmented control. The intent
    // Superseded 2026-08-23 (Sam): equal cells beat one row. Four equal
    // chips can't share the 239px rail (EN "Community" needs 84px alone),
    // so equal means the same 2×2 grid the community-tabs below use.
    const rule = ruleBody(v2, '.v2-pods__filters');
    expect(rule).toContain('display: grid');
    expect(rule).toContain('grid-template-columns: repeat(2, minmax(0, 1fr))');
    expect(rule).toContain('overflow: visible');
    // The `.v2-root button.` prefix is load-bearing: the global button reset
    // (0-1-1) zeroes padding on a bare-class rule (0-1-0), which shipped as
    // 25px chips hugging bare text — the third hit of this exact trap.
    const chip = ruleBody(v2, '.v2-root button.v2-pods__filter');
    expect(chip).toContain('white-space: nowrap');
    expect(chip).toContain('padding: 0 10px');
    // The active rule must FOLLOW the base chip rule: both weigh 0-2-1, so
    // source order decides the selected chip's color — the wrong order
    // shipped grey-on-blue (measured live 2026-08-23).
    const active = ruleBody(v2, '.v2-root button.v2-pods__filter--active');
    expect(active).toContain('color: var(--v2-surface)');
    expect(v2.indexOf('.v2-root button.v2-pods__filter--active'))
      .toBeGreaterThan(v2.indexOf('.v2-root button.v2-pods__filter {'));
  });

  test('mention treatment is a neutral wash, never a message rail', () => {
    // Accent rails made otherwise ordinary cards look like generic callouts.
    // Message rows retain a neutral semantic wash, while quote edges stay
    // neutral structural affordances.
    expect(v2).not.toMatch(/border-left:\s*[^;]*var\(--v2-accent\)/);
    const mention = ruleBody(v2, '.v2-msg--mention');
    expect(mention).toContain('background: var(--v2-surface-hover)');
    expect(mention).toContain('border-radius: var(--v2-radius-sm)');
  });

  test('quote edges share the same neutral 3px structural weight', () => {
    expect(ruleBody(v2, '.v2-msg__content blockquote')).toContain('border-left: 3px solid var(--v2-border)');
    expect(ruleBody(v2, '.v2-msg__quote')).toContain('border-left: 3px solid var(--v2-border)');
    expect(ruleBody(v2, '.v2-board__detail-updates li')).toContain('border-left: 3px solid var(--v2-border)');
  });

  test('pod rows reserve one preview line and a locale-shaped time slot', () => {
    const row = ruleBody(v2, '.v2-pods__item');
    const snippet = ruleBody(v2, '.v2-pods__item-snippet');
    const time = ruleBody(v2, '.v2-pods__item-time');

    expect(row).toContain('height: 64px');
    expect(row).toContain('overflow: hidden');
    expect(snippet).toContain('height: 16px');
    expect(snippet).toContain('white-space: nowrap');
    expect(snippet).toContain('text-overflow: ellipsis');
    // Relative time comes from the viewer's browser locale, so a fixed English
    // pixel width will eventually clip a clock. Keep its intrinsic width and
    // let the already-ellipsized title absorb the remaining line.
    expect(time).toContain('flex-shrink: 0');
    expect(time).toContain('white-space: nowrap');
    expect(time).not.toContain('width:');
    expect(v2).toContain('.v2-pods__row--pinned .v2-pods__item-time');
  });

  test('the inspector activity pulse uses semantic tokens, not raw color literals', () => {
    const pulse = ruleBody(v2, '.v2-inspector__now-pulse');
    expect(pulse).toContain('var(--v2-success-ring-strong)');
    expect(v2.slice(v2.indexOf('@keyframes v2-now-pulse'), v2.indexOf('.v2-inspector__now-meta')))
      .toContain('var(--v2-success-ring)');
  });

  test('v2 focus treatment reuses the shared focus-ring token', () => {
    expect(ruleBody(v2, '.v2-board__field input:focus')).toContain('box-shadow: var(--v2-focus-ring)');
  });

  test('board cards scroll intact and titles stay scannable in full columns', () => {
    // A board column is a height-constrained flex container. The cards have
    // overflow:hidden for rounded clipping, which otherwise permits the
    // default flex-shrink:1 to crush full columns into unreadable slivers.
    expect(ruleBody(v2, '.v2-board__card')).toContain('flex-shrink: 0');
    expect(ruleBody(v2, '.v2-board__col-empty')).toContain('flex-shrink: 0');

    const title = ruleBody(v2, '.v2-board__card-title');
    expect(title).toContain('display: -webkit-box');
    expect(title).toContain('-webkit-line-clamp: 3');
    expect(title).toContain('-webkit-box-orient: vertical');
    expect(title).toContain('overflow: hidden');
  });

  test('craft-pass board action chips keep their 32px target and 12px type', () => {
    // These compact controls are repeated on every board card and in the
    // detail dialog. A declaration on the shared selector keeps both paths
    // aligned and guards the 25px control regression measured at 390px.
    const chip = ruleBody(v2, '.v2-root button.v2-board__card-move');
    expect(chip).toContain('min-height: 32px');
    expect(chip).toContain('font-size: 12px');
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

  test('the chat heartbeat subtitle is guarded by an installed agent', () => {
    // A zero-agent pod has nobody expected to heartbeat; showing "No recent"
    // there was a false failure state. Pin both the predicate and its render
    // guard so a later copy-only edit cannot restore the dangling separator.
    expect(podChat).toContain('const liveState = agents.length > 0');
    expect(podChat).toContain('{liveState && <span className="v2-chat__goal-meta"> · {liveState}</span>}');
  });

  test('the Community sub-tabs and Discover rows shrink inside the narrow sidebar', () => {
    // Joined/Discover adds a second segmented row beneath the four main
    // filters. Equal minmax(0, 1fr) tracks keep both locale labels on one line,
    // while the Discover card gives its copy column the only shrinkable track.
    const tabs = ruleBody(v2, '.v2-pods__community-tabs');
    const row = ruleBody(v2, '.v2-pods__discover-row');
    expect(tabs).toContain('display: grid');
    expect(tabs).toContain('repeat(2, minmax(0, 1fr))');
    expect(tabs).toContain('overflow: hidden');
    expect(row).toContain('34px minmax(0, 1fr) auto');
  });

  test('Activity cards have shrinkable desktop and mobile layout guards', () => {
    // The recap is a feature-wide page, but it is still reachable at 390px.
    // The zero-min grid tracks are the load-bearing no-horizontal-overflow
    // rule; jsdom cannot observe the scrollbar they prevent.
    expect(ruleBody(v2, '.v2-activity__agent-grid'))
      .toContain('repeat(2, minmax(0, 1fr))');
    expect(ruleBody(v2, '.v2-activity__queue-row'))
      .toContain('28px minmax(0, 1fr) auto');
    expect(v2).toMatch(/@media \(max-width: 640px\)[\s\S]*?\.v2-activity__agent-grid \{[\s\S]*?grid-template-columns: minmax\(0, 1fr\)/);
    expect(v2).toMatch(/@media \(max-width: 640px\)[\s\S]*?\.v2-activity__queue-row \{[\s\S]*?28px minmax\(0, 1fr\)/);
    // Board rows do not inherit the queue icon column. At 390px that left
    // only one character of a task title — an overflow-free but unusable
    // primary identifier, which violates the craft baseline rule.
    expect(v2).toMatch(/@media \(max-width: 640px\)[\s\S]*?\.v2-activity__board-row \{[\s\S]*?grid-template-columns: minmax\(0, 1fr\)/);
  });

  test('Activity queue actions distinguish an action from the thread handoff', () => {
    expect(ruleBody(v2, '.v2-root .v2-activity__queue-actions button')).toContain('background: var(--v2-ink)');
    expect(ruleBody(v2, '.v2-root .v2-activity__queue-actions button.v2-activity__queue-action--secondary')).toContain('background: var(--v2-surface-hover)');
    expect(ruleBody(v2, '.v2-root .v2-activity__queue-actions button.v2-activity__queue-action--thread')).toContain('background: transparent');
  });

  test('DecisionRequest options remain 44px touch targets when they wrap at 390px', () => {
    // Options are agent-authored data, not compact task metadata. Keep the
    // recommended state and the free-text escape hatch visible in the CSS
    // source because jsdom has no layout engine to catch a narrow regression.
    expect(ruleBody(v2, '.v2-root .v2-activity__queue-actions button.v2-activity__option--recommended'))
      .toContain('background: var(--v2-ink)');
    expect(ruleBody(v2, '.v2-activity__decision-other')).toContain('flex-basis: 100%');
    expect(v2).toMatch(/@media \(max-width: 640px\)[\s\S]*?\.v2-root \.v2-activity__queue-actions button \{ min-height: 44px; \}/);
  });

  test('the shared filter segment uses an unmistakable token-backed selected state', () => {
    const active = ruleBody(v2, '.v2-root button.v2-filter-segment__item--active');

    expect(active).toContain('background: var(--v2-accent)');
    expect(active).toContain('border-color: var(--v2-accent)');
    expect(active).toContain('color: var(--v2-surface)');
    expect(active).toContain('font-weight: 700');
    expect(active).not.toContain('var(--v2-accent-soft)');
  });

  test('starter prompts wrap within the mobile chat pane', () => {
    // At 390px the rail leaves a narrow main pane. Both the row and each chip
    // need explicit shrink/wrap rules or the longest prompt creates horizontal
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
    expect(panel).toContain('width: min(760px, 100%)');
    expect(actions).toContain('repeat(2, minmax(0, 1fr))');
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
    const reduced = landing.slice(landing.indexOf('prefers-reduced-motion'));
    expect(reduced).toContain('flex-wrap: wrap');
    expect(reduced).toContain("animation: none");
    expect(reduced).toContain(".v2-landing__trusted-set[aria-hidden='true']");
  });

  test('landing adapter code scrolls inside its card instead of widening the page', () => {
    // Preformatted adapter commands have a wide min-content size. Without a
    // zero-width grid minimum + shrinkable card, the mobile landing page grows
    // wider than the viewport even though the <pre> itself scrolls.
    expect(ruleBody(landing, '.v2-landing__adapters')).toContain('minmax(0, 1fr)');
    expect(ruleBody(landing, '.v2-landing__adapter')).toContain('min-width: 0');
  });

  test('reaction chips baseline-align emoji ink with the count (not box-centering)', () => {
    // align-items: center centers the spans' layout boxes, but Apple Color
    // Emoji ink extends below the baseline while digit ink does not, so the
    // count visibly rides high on desktop (2026-08-05, Sam's HQ screenshot).
    // Baseline alignment + a 22px emoji line box (chip inner height, which is
    // the only thing vertically centering the pair once baseline is on) is
    // the fix; both halves are load-bearing and invisible to jsdom.
    expect(ruleBody(v2, '.v2-root button.v2-msg__reaction')).toContain('align-items: baseline');
    expect(ruleBody(v2, '.v2-msg__reaction-emoji')).toContain('line-height: 22px');
  });

  test('message actions live in ONE hover cluster, and its picker opens downward', () => {
    // 2026-08-23 (Sam's placement rulings): Reply, Thread, and the reaction
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

  test('create-pod panel no longer ships audience options (ADR-016 / #768)', () => {
    // Creation asks name + purpose only; visibility is a later act. If option
    // buttons ever come back to this panel they MUST carry the
    // `.v2-root button.` prefix — the global reset (0-2-1) beats a bare class
    // and renders them as plain prose, which shipped once (#870).
    expect(v2).not.toMatch(/\.v2-pods__create-option[^\n]*\{/);
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
    const filledControls = [
      '.v2-root button.v2-chat__send',
      '.v2-root button.v2-chat__send--execute',
      '.v2-root button.v2-chat__mode-option--active',
      '.v2-root button.v2-first-run__hello',
      '.v2-syscard__cta',
      '.v2-inspector__action--primary',
      '.v2-root a.v2-inspector__btn--primary',
      '.v2-root button.v2-approval__btn--approve',
    ];

    test('all eight filled controls use ink, never cobalt', () => {
      for (const selector of filledControls) {
        const rule = selectorRuleBody(v2, selector);
        expect(rule).toContain('var(--v2-ink)');
        expect(rule).not.toContain('var(--v2-accent)');
      }
    });

    test('chat and inspector surfaces do not paint with accent-soft', () => {
      const prefixes = [
        '.v2-chat',
        '.v2-msg',
        '.v2-inspector',
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

    test('hover under chat and inspector changes fill only, never accent color, border, or shadow', () => {
      const prefixes = [
        '.v2-chat',
        '.v2-msg',
        '.v2-inspector',
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

    test('the nine allowed cobalt marks remain explicit', () => {
      for (const selector of [
        '.v2-thread-card__dot',
        '.v2-thread-card--addressed .v2-thread-card__count',
        '.v2-msg__mention',
        '.v2-msg__content a',
        '.v2-inspector__link',
        '.v2-root button.v2-approval__result-link',
        '.v2-root button.v2-chat__new-pod-copy',
        '.v2-root .v2-chat__new-pod-error button',
        '.v2-chat__composer-input-wrap:focus-within',
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
    // REV 3 (Sam, 2026-08-23): the whole thread block is indented to the
    // message TEXT column like an attachment (margin-left 50px, pinned in
    // the column test above), so the rail sits AT the block edge — margin 0
    // — and card, rail, and message text share one line. Rev 2's
    // avatar-centre axis (margin 14 → x = 15) is superseded: the block no
    // longer starts at the avatar edge, so there is no avatar to aim at.
    const rail = ruleBody(v2, '.v2-thread-replies');
    expect(rail).toContain('margin-left: 0');
    expect(rail).toContain('padding-left: 12px');
    expect(rail).toContain('border-left: 2px solid #eef0f6');

    // ONE inner column for every reply: 16 + 12 + 24 + 8 = x = 60. Reusing the
    // channel's 38px+12px grid is what opened a second text column, so the
    // override is the fix and pinning it is the point.
    const railRow = ruleBody(v2, '.v2-thread-replies .v2-msg');
    expect(railRow).toContain('grid-template-columns: 24px minmax(0, 1fr)');
    expect(railRow).toContain('gap: 8px');

    // 390 (rev 3): the block's 50px attachment indent tightens to 24px,
    // the rail stays on the block edge, and the inner padding tightens.
    expect(v2).toMatch(/@media \(max-width: 640px\)[\s\S]*?\.v2-thread-block\s*\{[\s\S]*?margin-left: 24px/);
    expect(v2).toMatch(/@media \(max-width: 640px\)[\s\S]*?\.v2-thread-replies\s*\{[\s\S]*?margin-left: 0[\s\S]*?padding-left: 8px/);
  });

  test('the thread card has no shadow and no accent at rest', () => {
    // Two separate brief constraints that both fail silently: a shadow reads
    // as "slightly wrong depth" and an accent at rest destroys the ONE signal
    // the card has for being addressed.
    // Selector carries the `.v2-root button.` prefix ON PURPOSE: the global
    // reset `.v2-root button:not(.MuiButtonBase-root)` is 0-2-1 and sets
    // `color: inherit`, so a bare class rule loses and the card renders at
    // body colour. Pinning the prefixed selector means dropping the prefix
    // fails here rather than silently in production (#870's trap).
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
    // message by default (Sam's report, 2026-08-23).
    expect(v2).toMatch(/@media \(max-width: 640px\)[\s\S]*?\.v2-msg--reveal \.v2-msg__actions[\s\S]*?opacity: 1/);
    expect(v2).toMatch(/@media \(max-width: 640px\)[\s\S]*?\.v2-root button\.v2-msg__action[\s\S]*?height: 44px/);
    const cardAction = ruleBody(v2, '.v2-root button.v2-thread-card__reply');
    expect(cardAction).toContain('min-height: 44px');
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
    const resetBlock = v2.slice(resetStart, v2.indexOf('}', resetStart));
    expect(resetBlock).toContain('letter-spacing: 0');
    for (const sel of negative) {
      const bare = sel.replace(/^\.v2-root /, '');
      expect(resetBlock).toContain(`.v2-root:lang(zh) ${bare}`);
    }
  });

  test('zh-CN: body copy takes line-height 1.6 and a 12px floor under :lang(zh) (TASK-055)', () => {
    // Measured in a real browser: .v2-msg__content rendered Chinese at 1.55,
    // the composer hint at 1.45/11px. CJK glyphs fill the em box, so Latin
    // leading leaves no white between lines and 11px is below legibility.
    const lhStart = v2.indexOf('.v2-root:lang(zh) .v2-msg__content,');
    expect(lhStart).toBeGreaterThan(-1);
    const lhBlock = v2.slice(lhStart, v2.indexOf('}', lhStart));
    expect(lhBlock).toContain('line-height: 1.6');
    for (const sel of ['.v2-msg__content', '.v2-chat__composer-hint', '.v2-inspector__pod-meta']) {
      expect(lhBlock).toContain(`.v2-root:lang(zh) ${sel}`);
    }
    const floorStart = v2.indexOf('.v2-root:lang(zh) .v2-chat__composer-hint,\n.v2-root:lang(zh) button.v2-inspector__tab');
    expect(floorStart).toBeGreaterThan(-1);
    expect(v2.slice(floorStart, v2.indexOf('}', floorStart))).toContain('font-size: 12px');
  });

  // Connectors v2 (Wren spec §5): platform tint tokens must exist in BOTH
  // token files (the same-PR rule), and the tile class must consume them.
  it('chat message text has NO measure cap (Sam overruled craft finding 6, 2026-09-01)', () => {
    // #1367 pinned a 75ch cap here as the audit's P0. Sam overruled it —
    // third full-width ruling; worst case was a large screen with the
    // sidebar collapsed. The rule-2 v6 assertion above owns the ban; this
    // test flips to the same polarity so the two can never disagree.
    const block = v2.match(/\.v2-msg__content \{[^}]*\}/);
    expect(block).not.toBeNull();
    expect(block![0]).not.toMatch(/max-width:\s*\d+ch/);
  });

  it('the BEND-1 feature type step exists in v2.css and tokens.css together', () => {
    const ds = fs.readFileSync(path.join(__dirname, '../../../design-system/tokens.css'), 'utf8');
    expect(v2).toContain('--v2-fs-feature: 17px');
    expect(ds).toContain('--c-fs-feature: 17px');
    expect(v2).toContain('var(--v2-fs-feature)');
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

  it('featured team card stacks below 640px — the name column never one-chars (spec §5, #568 class)', () => {
    const mq = v2.match(/@media \(max-width: 640px\) \{[\s\S]*?\n\}/);
    expect(mq).not.toBeNull();
    expect(mq![0]).toContain('.v2-team-feature');
    expect(mq![0]).toContain('grid-template-columns: 44px minmax(0, 1fr)');
  });

  it('platform tint tokens stay in v2.css and tokens.css, while Signal rows use the cobalt mark', () => {
    const ds = fs.readFileSync(path.join(__dirname, '../../../design-system/tokens.css'), 'utf8');
    for (const pf of ['telegram', 'slack', 'discord', 'whatsapp']) {
      expect(v2).toContain(`--v2-platform-${pf}-soft`);
      expect(ds).toContain(`--c-platform-${pf}-soft`);
    }
    expect(ruleBody(v2, '.v2-connector-row__dot--live, .v2-connector-row__dot--pending')).toContain('var(--v2-accent)');
    expect(v2).not.toContain('.v2-connector__tile--telegram');
  });

  it('Signal connectors pin the row grid, aside, colour grammar, and phone collapse', () => {
    expect(ruleBody(v2, '.v2-connector-row')).toContain('grid-template-columns: 200px minmax(0, 1fr) 200px 120px');
    expect(ruleBody(v2, '.v2-connectors__content')).toContain('grid-template-columns: minmax(0, 1fr) 400px');
    const connectors = ruleBody(v2, '.v2-connectors');
    expect(connectors).toContain('min-height: calc(100vh - 86px)');
    expect(connectors).not.toContain('max-width');
    expect(ruleBody(v2, '.v2-connectors__header p')).not.toContain('var(--v2-font-mono)');
    expect(ruleBody(v2, '.v2-connector-row__glyph')).toContain('width: 20px');
    expect(ruleBody(v2, '.v2-connector-row__glyph')).toContain('color: inherit');
    expect(ruleBody(v2, '.v2-connector-row--not-yet .v2-connector-row__glyph')).toContain('color: var(--v2-text-placeholder)');
    expect(ruleBody(v2, '.v2-connector-row__detail')).toContain('white-space: nowrap');
    expect(ruleBody(v2, '.v2-connector-row__dot--live, .v2-connector-row__dot--pending')).toContain('var(--v2-accent)');
    expect(ruleBody(v2, '.v2-connector-row__dot--idle')).toContain('var(--v2-border-soft)');
    const connectorCss = v2.slice(v2.indexOf('/* ── Connectors'), v2.indexOf('/* Activity queue'));
    expect(connectorCss).not.toContain('var(--v2-success)');
    expect(connectorCss).not.toContain('var(--v2-warning)');
    expect(connectorCss).not.toContain('var(--v2-danger)');
    expect(connectorCss).toMatch(/@media \(max-width: 760px\) \{[\s\S]*?\.v2-connector-row \{ grid-template-columns: minmax\(0, 1fr\) auto;/);
    expect(connectorCss).toMatch(/@media \(max-width: 760px\) \{[\s\S]*?\.v2-connectors__content \{ grid-template-columns: minmax\(0, 1fr\);/);
    expect(connectorCss).toMatch(/@media \(max-width: 760px\) \{[\s\S]*?\.v2-connectors \{ min-height: 0; gap: 24px; margin: -12px -18px 0;/);
    expect(connectorCss).toMatch(/\.v2-root button\.v2-connector-row__selection \{ grid-column: 1 \/ -1;/);
    expect(connectorCss).toMatch(/\.v2-root button\.v2-connector-row__selection \.v2-connector-row__details \{ grid-column: 1 \/ -1; grid-row: 2;/);
  });

  describe('TASK-122 Phase A — the ruled restyle (Sam, 2026-09-03; spec on TASK-122)', () => {
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
      expect(ruleBody(v2, '.v2-feature')).toContain('background: #ffffff');
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

    test('Needs-you rows are stable on hover: transparent border, fill-only hover, no dividers', () => {
      const row = ruleBody(v2, '.v2-activity__queue-row');
      expect(row).toContain('border: 1px solid transparent');
      expect(row).toContain('border-radius: var(--v2-radius)');
      expect(v2).not.toContain('.v2-activity__queue-row + .v2-activity__queue-row');
      const hover = ruleBody(v2, '.v2-activity__queue-row:hover');
      const declarations = hover.slice(hover.indexOf('{') + 1).split(';').map((d) => d.trim()).filter(Boolean);
      expect(declarations.length).toBeGreaterThan(0);
      for (const declaration of declarations) expect(declaration).toMatch(/^background/);
      // Pending decision/approval rows sit one step up; a ruled decision settles back down.
      const pending = ruleBody(v2, '.v2-activity__queue-row--decision,\n.v2-activity__queue-row--approval');
      expect(pending).toContain('box-shadow: var(--v2-shadow-pending)');
      expect(cssVariable(v2Root, '--v2-shadow-pending')).toBe(cssVariable(tokens, '--c-shadow-pending'));
      expect(ruleBody(v2, '.v2-activity__queue-row--settled')).toContain('box-shadow: none');
      expect(activityPage).toContain("' v2-activity__queue-row--settled'");
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
      // <select> is outside the global halo's element list, so the pod picker carries its own.
      expect(ruleBody(v2, '.v2-activity__compose-pod select:focus-visible')).toContain('box-shadow: var(--v2-focus-ring)');
    });

    test('ink primary: filled Activity buttons are ink, and blue stays off them', () => {
      expect(cssVariable(v2Root, '--v2-ink')).toBe('#101828');
      expect(cssVariable(tokens, '--c-ink')).toBe('#101828');
      const send = ruleBody(v2, '.v2-root .v2-activity__compose button');
      expect(send).toContain('var(--v2-ink)');
      expect(send).not.toContain('var(--v2-accent)');
      expect(ruleBody(v2, '.v2-root .v2-activity__queue-actions button')).not.toContain('var(--v2-accent)');
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
  });

});
