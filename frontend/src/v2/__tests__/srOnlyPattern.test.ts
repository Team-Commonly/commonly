import fs from 'fs';
import path from 'path';

/**
 * The visually-hidden pattern, pinned at its source rather than per host.
 *
 * `.v2-demo__sr` is a `<label>` for the demo composer's text input: an
 * absolutely positioned 1px box. ux-lead measured the consequence on the live
 * landing page (UX-GATE on #2018, finding 9) — the document ran 1301px tall at
 * a 1440x900 viewport and a wheel overscroll at the footer scrolled the window
 * — and named this box, which has no positioned ancestor inside the scroller,
 * as what extends the document. They marked it pre-existing: #2018 did not
 * introduce it.
 *
 * WHAT THE GUARD IS FOR, and it needs no causal claim: this was the only member
 * of the frontend's visually-hidden family missing declarations the two other
 * members already carried. That asymmetry is the finding. `.v2-landing__install-status`
 * and `.v2-board__focus-live` declared the whole set; this one did not.
 *
 * THE CAUSE IS LEFT OPEN. sprint-review's browser harness (code gate on #2024)
 * could not reproduce the reported mechanism: with a 1px height and overflow
 * clipping, the box measures 1px whether or not its label text wraps, in four
 * variants including a scrollable host. So the explanation this file first
 * carried — that the wrapped label's height joined the host's scrollable
 * overflow — is withdrawn rather than restated, and `clip-path` is carried as
 * pattern conformance rather than as a certified fix. What remains true is the
 * report (ux-lead's, on the live page), the asymmetry, and the rule's shape.
 *
 * #2018 fenced one instance with `position: relative` on the landing scroller.
 * That is per-host; the rule itself is shared, and `DemoWorkspace` is a
 * component, so the next host inherited the same box. This is the source fix;
 * the census below is what keeps the family from diverging again.
 *
 * Tier: presence, not layout. jsdom has no layout engine, so nothing here can
 * assert a scroll height — the same limit `v2-layout-invariants.test.ts` states,
 * and the reason a presence test is the right instrument until a browser-layout
 * tier exists. The 401px is ux-lead's browser measurement; it is quoted, not
 * reproduced.
 */

const SRC_DIR = path.resolve(__dirname, '..', '..');

const cssFiles = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return cssFiles(full);
    return entry.name.endsWith('.css') ? [full] : [];
  });

interface HiddenRule {
  selector: string;
  body: string;
  file: string;
}

// A rule body has no nested braces, so `[^{}]*` is sufficient; a selector can
// never span a brace, so the match starts at the right rule even inside @media.
// Comments are stripped first: a comment sitting above a selector is captured as
// part of it (measured — the demo rule's own explanatory comment became its
// selector), and a brace inside a comment would break the walk entirely.
const visuallyHiddenRules = (): HiddenRule[] => {
  const found: HiddenRule[] = [];
  cssFiles(SRC_DIR).forEach((file) => {
    const css = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const rule = /([^{}]+)\{([^{}]*)\}/g;
    let match = rule.exec(css);
    while (match !== null) {
      const body = match[2];
      // Found by the DEFECT'S PRECONDITION — an absolutely positioned 1px box
      // that clips its own content — not by the clipping idiom. `clip: rect()`
      // is deprecated, and a copy written with `clip-path` alone (or with
      // neither idiom, which is the defect itself) must still be discovered.
      // Measured at this head: the four candidate keys (this one, this one plus
      // `clip: rect(`, this one plus `clip-path`, and `position: absolute` +
      // 1px with no overflow clause) all return the same FOUR rules out of
      // 2,970 in src/, so the broader key costs nothing today and cannot be the
      // reason a future copy is missed. The `clip-path` key disagreed until
      // TASK-220 — it returned three, because `.v2-board__focus-live` carried
      // `clip: rect()` alone. That is exactly the copy a narrower key would
      // have missed, which is why the key is the DEFECT’S PRECONDITION and not
      // the idiom.
      const looksHidden = /position:\s*absolute;/.test(body)
        && /width:\s*1px;/.test(body)
        && /height:\s*1px;/.test(body)
        && /overflow:\s*hidden;/.test(body);
      if (looksHidden) {
        found.push({
          selector: match[1].trim(),
          body,
          file: path.relative(SRC_DIR, file),
        });
      }
      match = rule.exec(css);
    }
  });
  return found;
};

const declarations = (body: string): string[] =>
  body.split(';').map((d) => d.trim().replace(/\s+/g, ' ')).filter(Boolean);

// Every copy must carry ALL of these, not most of them: the failure is silent
// and layout-only, so a copy that drops one is a defect with no other symptom.
// This is the set the two unaffected members already declared — the guard is
// derived from them, not from the box whose cause is open.
//
// A copy that drops `overflow: hidden` is NOT discovered by any key above: that
// copy's text is visible, which is a loud defect rather than this silent one.
// `text-indent: -9999px` hiding is out of scope (0 rules in src/ today, measured)
// because it creates no absolutely positioned box.
const REQUIRED = ['padding: 0', 'margin: -1px', 'white-space: nowrap', 'border: 0',
  // TASK-220. `clip-path` joins the set now that every copy carries it. It was
  // held out while three rows were mid-flight and the family was non-uniform
  // (#2024, #2042, #2046); holding it out is what left the one declaration that
  // matters here unpinned on the copies that already had it — drop it from any
  // of them and nothing red. `clip: rect()` is deprecated and `clip-path` is
  // what actually clips in current engines, so a copy with the old idiom alone
  // is the defect this file exists to find.
  'clip-path: inset(50%)'];

const rules = visuallyHiddenRules();

describe('the visually-hidden pattern has one shape', () => {
  it('finds the copies rather than an empty set', () => {
    // Guards the census itself: a rename or a restructure that made the scan
    // find nothing would otherwise make every assertion below vacuously green.
    expect(rules.map((r) => r.selector)).toEqual(
      expect.arrayContaining([
        '.v2-demo__sr',
        '.v2-landing__install-status',
        '.v2-landing__wedge-sr',
        '.v2-board__focus-live',
      ]),
    );
  });

  it('declares the whole pattern on every copy, not part of it', () => {
    const missing = rules.flatMap(({ selector, body, file }) => {
      const declared = declarations(body);
      return REQUIRED
        .filter((decl) => !declared.includes(decl))
        .map((decl) => `${file} -> ${selector} is missing \`${decl}\``);
    });
    expect(missing).toEqual([]);
  });
});
