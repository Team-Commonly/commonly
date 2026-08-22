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

  test('chat text holds a readable measure WITHOUT centering (craft audit rule 2, corrected)', () => {
    // ~150 chars/line was the defect; the first fix centered the whole
    // message column and left it misaligned with the full-width composer and
    // header — worse than the disease. The correct mechanic caps the text
    // measure only, rows left-anchored. Both halves are load-bearing: the
    // cap must exist, and the centering must never come back.
    const body = ruleBody(v2, '.v2-msg__body');
    expect(v2).toContain('max-width: 76ch');
    expect(v2).not.toContain('.v2-chat__messages > *');
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
    // The desktop sidebar leaves only ~240px inside its gutter (less than the
    // mobile drawer). A four-column grid keeps Community beside the existing
    // filters without horizontal scrolling or wrapping in either locale.
    // Pattern updated 2026-08-13 (Sam's raggedness flag): three EQUAL
    // segments + one content-sized, capped Community column — the per-label
    // hand-tuned fractions read as four random widths. The invariant's intent
    // (one row, no wrap) is unchanged.
    const rule = ruleBody(v2, '.v2-pods__filters');
    expect(rule).toContain('display: grid');
    expect(rule).toContain('grid-template-columns: repeat(3, minmax(0, 1fr)) fit-content(92px)');
    expect(rule).toContain('overflow: visible');
    expect(ruleBody(v2, '.v2-pods__filter')).toContain('text-overflow: ellipsis');
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

  test('the bare reactions row collapses instead of reserving a blank band', () => {
    // A no-chips row holds only the opacity-0 hover "+", but it used to keep
    // 24px + 6px of layout space under EVERY message — the phantom band that
    // pushed approval cards visibly away from their trigger text (2026-08-13).
    // Both halves are load-bearing: height 0 removes the band; the absolute
    // add-wrap keeps the trigger reachable without re-expanding the row. The
    // rule looks inert in isolation — do not "clean it up".
    expect(ruleBody(v2, '.v2-msg__reactions--bare')).toContain('height: 0');
    expect(ruleBody(v2, '.v2-msg__reactions--bare .v2-msg__reaction-add-wrap')).toContain(
      'position: absolute',
    );
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
});
