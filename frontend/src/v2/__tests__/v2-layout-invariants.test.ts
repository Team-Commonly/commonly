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
  const start = css.indexOf(`${selector} {`);
  if (start === -1) return '';
  const end = css.indexOf('}', start);
  return end === -1 ? '' : css.slice(start, end);
};

describe('v2 layout invariants (CSS rule presence)', () => {
  const v2 = read('../v2.css');
  const showcase = read('../showcase/v2-showcase.css');
  const aprofile = read('../agents/v2-agent-profile.css');
  const landing = read('../landing/v2-landing.css');

  test('Your Team card name owns its line so the category chip cannot crush it', () => {
    const rule = ruleBody(v2, '.v2-team-card__name');
    expect(rule).toContain('flex: 1 0 100%');
    expect(rule).toContain('min-width: 0');
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

  test('the first-run card and message pane shrink to the mobile content width', () => {
    // The rail remains visible on phones, leaving ~326px at a 390px viewport.
    // A fixed-width onboarding card would overflow behind the rail; both the
    // card cap and reduced transcript gutter are load-bearing for that layout.
    expect(ruleBody(v2, '.v2-first-run')).toContain('width: min(720px, 100%)');
    expect(v2).toContain('.v2-chat__messages {\n    padding-inline: 14px');
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
});
