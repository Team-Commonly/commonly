/**
 * TASK-205, the CSS half. A nav anchor used to land the section's heading under
 * the frosted sticky bar: the page's sections carry no top padding (#2019 set
 * `.v2-landing__section { padding-top: 0 }`), so the bar sits over whatever the
 * scroller leaves at the top of the viewport. The inset belongs on the SCROLLER
 * (`.v2-root.v2-landing`) rather than as `scroll-margin` on each section, which
 * is what makes hash navigation, `scrollIntoView` and keyboard focus all clear
 * the bar rather than just the first of the three.
 *
 * The second half is motion: `scroll-behavior: smooth` sat unconditionally on
 * the base rule, which outranks the no-preference block at the foot of the file
 * (0,2,0 against 0,1,0), so a visitor who had asked for reduced motion still got
 * a ~1.4s animated jump. Deleted rather than overridden, so smooth scrolling has
 * exactly one source.
 *
 * These are presence pins. A real browser is what proves the landing, and the
 * gate for that is ux-lead's; what is checkable here is that the rule exists,
 * that it clears the bar it must clear, and that nothing re-adds a second,
 * unconditional source of smooth scrolling.
 */
import fs from 'fs';
import path from 'path';
import { blockContaining } from '../../lib/cssBlocks';

const CSS = fs.readFileSync(path.join(__dirname, '..', 'v2-landing.css'), 'utf8');
/** Comments quote the declarations these tests count, so they are read without them. */
const BARE = CSS.replace(/\/\*[\s\S]*?\*\//g, '');

/** The body of the first rule whose selector list is exactly `selector {`. */
const ruleBody = (css: string, selector: string): string => {
  const at = css.indexOf(`${selector} {`);
  if (at === -1) throw new Error(`no rule for ${selector}`);
  const open = css.indexOf('{', at);
  const close = css.indexOf('}', open);
  if (close === -1) throw new Error(`unbalanced braces in the rule for ${selector}`);
  return css.slice(open + 1, close);
};

/** A declaration's value inside a rule body, or a throw naming the miss. */
const declaration = (body: string, property: string): number => {
  const match = new RegExp(`(?:^|[;{\\s])${property}:\\s*(\\d+)px\\s*;`).exec(body);
  if (!match) throw new Error(`${property} is not a px declaration in: ${body.replace(/\s+/g, ' ')}`);
  return Number(match[1]);
};

/**
 * TASK-221: these two reads used to run at module scope through a private,
 * throwing brace walker. A renamed marker then failed the suite at IMPORT —
 * jest counted the suite but not its 3 assertions, so the total went DOWN
 * instead of red (measured 981 -> 978 on #2038's mutant). Each read now happens
 * inside the test that needs it, through the shared bounded reader, which
 * returns '' rather than throwing: a missing marker is a failed assertion and
 * stays in the total. The block is identified by the selector it must carry,
 * so a marker that moves cannot match a neighbouring block.
 */
const phoneBlock = (): string =>
  blockContaining(BARE, '@media (max-width: 680px)', '.v2-root.v2-landing');
const noPreferenceBlock = (): string =>
  blockContaining(BARE, '@media (prefers-reduced-motion: no-preference)', 'scroll-behavior: smooth');

describe('the landing scroller reserves the sticky bar (TASK-205)', () => {
  test('the scroller carries the inset, not each section', () => {
    const scroller = ruleBody(BARE, '.v2-root.v2-landing');
    const bar = ruleBody(BARE, '.v2-landing__bar');
    const inset = declaration(scroller, 'scroll-padding-top');

    // The invariant, so raising the bar fails here rather than silently putting
    // the heading back under it: the inset has to clear the bar, not equal it.
    expect(inset).toBeGreaterThan(declaration(bar, 'height'));
    expect(inset).toBe(112);
  });

  test('the phone block drops the inset with the bar', () => {
    // The bar is 64 below 680, and the same specificity as the base rule
    // (0,2,0) later in the file is what makes this win.
    const inset = declaration(ruleBody(phoneBlock(), '.v2-root.v2-landing'), 'scroll-padding-top');
    const bar = ruleBody(phoneBlock(), '.v2-landing__bar');

    expect(inset).toBeGreaterThan(declaration(bar, 'height'));
    expect(inset).toBe(88);
  });

  test('smooth scrolling has exactly one source, and it is the no-preference block', () => {
    const declarations = BARE.match(/scroll-behavior/g) ?? [];
    expect(declarations).toHaveLength(1);
    expect(noPreferenceBlock()).toContain('scroll-behavior: smooth');
    // The base rule is the one that used to carry it, and the one that outranked
    // the block above.
    expect(ruleBody(BARE, '.v2-root.v2-landing')).not.toContain('scroll-behavior');
  });
});
