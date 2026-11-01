import fs from 'fs';
import path from 'path';

// D220: the motion contract from the d215 motion spec. Tokens, one global
// reduced-motion switch, folds by size, and no blanket transitions.
const v2Dir = path.join(__dirname, '..');
const v2css = fs.readFileSync(path.join(v2Dir, 'v2.css'), 'utf8');

const cssFiles = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const full = path.join(dir, entry.name);
  if (entry.isDirectory()) return entry.name === '__tests__' ? [] : cssFiles(full);
  return entry.name.endsWith('.css') ? [full] : [];
});

describe('v2 motion (D220)', () => {
  test('the tokens are one curve and three durations on :root', () => {
    const root = /:root \{\n  --v2-dur-fast: 120ms;\n  --v2-dur: 200ms;\n  --v2-dur-slow: 320ms;\n  --v2-ease: cubic-bezier\(0\.2, 0, 0, 1\);\n\}/;
    expect(v2css).toMatch(root);
  });

  test('reduced motion is one global switch that also reaches portals and view transitions', () => {
    const block = v2css.slice(v2css.lastIndexOf('@media (prefers-reduced-motion: reduce) {'));
    // Unscoped: a .v2-root prefix would miss portals such as the avatar crop dialog.
    expect(block).toMatch(/^@media \(prefers-reduced-motion: reduce\) \{\n  \*,\n  \*::before,\n  \*::after \{/);
    expect(block).toContain('animation-duration: 0.01ms !important;');
    expect(block).toContain('animation-iteration-count: 1 !important;');
    expect(block).toContain('transition-duration: 0.01ms !important;');
    expect(block).toContain('::view-transition-old(*),');
    expect(block).toContain('animation: none !important;');
    // The fold body is a pseudo-element the wildcards miss; it needs its own rule.
    expect(block).toContain('  ::details-content {\n    transition-duration: 0.01ms !important;\n  }');
  });

  test('details folds open by size over --v2-dur and close over --v2-dur-fast', () => {
    expect(v2css).toContain('.v2-root details {\n  interpolate-size: allow-keywords;\n}');
    const closed = v2css.slice(v2css.indexOf('.v2-root details::details-content {'));
    expect(closed).toContain('block-size: 0;');
    expect(closed).toContain('block-size var(--v2-dur-fast) var(--v2-ease)');
    expect(closed).toContain('content-visibility var(--v2-dur-fast) var(--v2-ease) allow-discrete');
    const open = v2css.slice(v2css.indexOf('.v2-root details[open]::details-content {'));
    expect(open).toContain('block-size: auto;');
    expect(open).toContain('transition-duration: var(--v2-dur);');
  });

  test('no v2 stylesheet uses a blanket transition', () => {
    const offenders = cssFiles(v2Dir).filter((file) => /transition(-property)?:\s*all\b/.test(fs.readFileSync(file, 'utf8')));
    expect(offenders.map((file) => path.relative(v2Dir, file))).toEqual([]);
  });
});
