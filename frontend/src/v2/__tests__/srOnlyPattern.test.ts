import fs from 'fs';
import path from 'path';

/**
 * The visually-hidden pattern, pinned at its source rather than per host.
 *
 * `.v2-demo__sr` is a `<label>` for the demo composer's text input. It carries
 * `position: absolute; width: 1px; height: 1px` and, until this guard, no
 * `white-space: nowrap` — so the label text wrapped into a column of lines while
 * `position: absolute` (auto offsets) held the box at its static position, and
 * that height, not the box's paint, joined the host's scrollable overflow.
 * Measured consequence (sprint-review, code gate on #2018): a wheel overscroll
 * at the landing footer scrolled the WINDOW 401px — html scrollHeight 1301 at a
 * 1440x900 viewport, 1301 - 900 = 401.
 *
 * #2018 fenced that one instance with `position: relative` on the landing
 * scroller. That is per-host; the rule itself is shared, and `DemoWorkspace` is
 * a component, so the next host inherited the same 401px. This is the source
 * fix, and the census below is what keeps it fixed: the two other copies in the
 * frontend already declared the whole pattern, which is exactly how the gap was
 * found (`.v2-demo__sr` was the one member of the set missing declarations).
 *
 * Tier: presence, not layout. jsdom has no layout engine, so nothing here can
 * assert the 401px itself — the same limit `v2-layout-invariants.test.ts`
 * states, and the reason a presence test is the right instrument until a
 * browser-layout tier exists.
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
      const looksHidden = /position:\s*absolute;/.test(body)
        && /width:\s*1px;/.test(body)
        && /height:\s*1px;/.test(body)
        && /overflow:\s*hidden;/.test(body)
        && /clip:\s*rect\(/.test(body);
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
const REQUIRED = ['padding: 0', 'margin: -1px', 'white-space: nowrap', 'border: 0'];

const rules = visuallyHiddenRules();

describe('the visually-hidden pattern has one shape', () => {
  it('finds the copies rather than an empty set', () => {
    // Guards the census itself: a rename or a restructure that made the scan
    // find nothing would otherwise make every assertion below vacuously green.
    expect(rules.map((r) => r.selector)).toEqual(
      expect.arrayContaining([
        '.v2-demo__sr',
        '.v2-landing__install-status',
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

  it('clips the demo label outright, in addition to painting nothing', () => {
    // `clip: rect(...)` still leaves the box's height in scrollable overflow in
    // engines that clip only the paint; `clip-path: inset(50%)` removes it.
    // The demo label is the one that sits at the BOTTOM of a tall document,
    // where that residue is what pushed the window past its own footer.
    const demo = rules.find((r) => r.selector === '.v2-demo__sr');
    expect(demo).toBeDefined();
    expect(declarations(demo?.body ?? '')).toContain('clip-path: inset(50%)');
  });
});
