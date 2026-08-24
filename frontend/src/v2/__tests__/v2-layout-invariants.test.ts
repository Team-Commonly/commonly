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
 *   - The showcase page clipped ~500px including its footer CTA because it
 *     inherited the `.v2-root` app-shell `overflow:hidden` and never added its
 *     own scroll override (#575).
 *
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

const cssVariable = (css: string, name: string): string | undefined => (
  new RegExp(`${name}\\s*:\\s*([^;]+);`).exec(css)?.[1].trim()
);

describe('v2 layout invariants (CSS rule presence)', () => {
  const v2 = read('../v2.css');
  const tokens = read('../../../design-system/tokens.css');
  const showcase = read('../showcase/v2-showcase.css');
  const aprofile = read('../agents/v2-agent-profile.css');
  const landing = read('../landing/v2-landing.css');

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

  test('runtime vocabulary stays off Your Team cards (ADR-022 D1, ratified)', () => {
    // The chip shipped in violation of the ratified rule; the craft audit
    // (finding 2) removed it. This pins the removal against reintroduction.
    expect(v2).not.toContain('.v2-team-card__runtime {');
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
    expect(v2).toContain('--v2-page-bg: #f8f8fb');
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
  });

  test('the conversation column is FULL-WIDTH — no measure cap, one left edge (rule 2, v5)', () => {
    // Fifth mechanism, ruled by Sam 2026-08-23: the Slack model. With a
    // line cap, leftover space must pool somewhere — center was rejected,
    // and left-anchor pools it all on the right — so the cap itself goes.
    // No revision may reintroduce a conversation measure token: that is
    // the corner-of-the-triangle debate re-opening by accident.
    expect(v2).not.toContain('--v2-conv-measure');
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

  test('the showcase page is its own scroll container (not clipped by the app shell)', () => {
    expect(ruleBody(showcase, '.v2-root.v2-showcase')).toContain('overflow-y: auto');
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

  test('the first-run setup CTA beats the global inherited anchor color', () => {
    // `.v2-root a { color: inherit }` outranks a bare class selector. The
    // first browser pass rendered blue text on the blue CTA until this
    // compound selector matched/exceeded the reset specificity.
    const rule = ruleBody(
      v2,
      '.v2-root a.v2-first-run__setup,\n.v2-root button.v2-first-run__hello',
    );
    expect(rule).toContain('background: var(--v2-accent)');
    expect(rule).toContain('color: #fff');
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

  test('accent treatment is a wash, never a message rail', () => {
    // Accent rails made otherwise ordinary cards look like generic callouts.
    // Message mentions retain their semantic wash, while quote edges stay
    // neutral structural affordances.
    expect(v2).not.toMatch(/border-left:\s*[^;]*var\(--v2-accent\)/);
    const mention = ruleBody(v2, '.v2-msg--mention');
    expect(mention).toContain('background: var(--v2-accent-soft)');
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

  test('compare head does not combine section padding with its own max-width', () => {
    // `.v2-landing__section` centres a 1120px column via percentage padding
    // resolved against the PARENT. An element carrying both that class and its
    // own max-width keeps the padding and caps the box, collapsing the text to
    // a ribbon — shipped live on /compare. Constrain the children instead.
    const landingCss = read('../landing/v2-landing.css');
    expect(ruleBody(landingCss, '.v2-compare__head')).not.toContain('max-width');
    expect(ruleBody(landingCss, '.v2-compare__head > *')).toContain('max-width');
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
});
