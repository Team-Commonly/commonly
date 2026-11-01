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

// The board and drawer moments: the claim glide, the 390 leave, the lease ring
// that waits for the landing, and drawers that slide in from the right.
describe('v2 motion: board and drawers', () => {
  const boardCss = fs.readFileSync(path.join(v2Dir, 'components', 'V2PodBoard.css'), 'utf8');
  const cxCss = fs.readFileSync(path.join(v2Dir, 'connectors', 'connectors.css'), 'utf8');
  const keyframes = (css: string, name: string): string => {
    const start = css.indexOf(`@keyframes ${name} {`);
    if (start < 0) return '';
    let depth = 0;
    for (let i = css.indexOf('{', start); i < css.length; i += 1) {
      if (css[i] === '{') depth += 1;
      if (css[i] === '}') { depth -= 1; if (!depth) return css.slice(start, i + 1); }
    }
    return '';
  };

  test('a live claim names the cards of the columns involved and glides on the slow token', () => {
    expect(boardCss).toContain(':root.v2-board-glide .v2-feature--board .v2-board__col[data-glide] .v2-board__card { view-transition-name: var(--v2-task-vt); }');
    expect(boardCss).toContain(':root.v2-board-glide::view-transition-group(*) { animation-duration: var(--v2-dur-slow); animation-timing-function: var(--v2-ease); }');
  });

  test('the lease ring waits for the landing and stops under reduced motion', () => {
    expect(boardCss).toMatch(/:root\.v2-board-glide \.v2-feature--board \.v2-board__owner-dot--live::after,\n:root\.v2-board-glide \.v2-feature--board \.v2-board__col-dot--claimed\.is-live::after \{ animation: none; \}/);
    expect(boardCss).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\n  \.v2-feature--board \.v2-board__col-dot--claimed\.is-live::after,\n  \.v2-feature--board \.v2-board__owner-dot--live::after \{ animation: none; \}/);
    // A column dot loops only while a lease in it is live.
    expect(boardCss).not.toMatch(/\.v2-board__col-dot--claimed::after/);
  });

  test('at 390 a card leaves its tab by 8px toward the new one over --v2-dur, and the count ticks', () => {
    expect(boardCss).toContain('.v2-feature--board .v2-board__card.is-leaving { pointer-events: none; animation: v2-board-leave-next var(--v2-dur) var(--v2-ease) forwards; }');
    expect(keyframes(boardCss, 'v2-board-leave-next')).toContain('to { opacity: 0; transform: translateX(8px); }');
    expect(keyframes(boardCss, 'v2-board-leave-prev')).toContain('to { opacity: 0; transform: translateX(-8px); }');
    expect(boardCss).toContain('.v2-board__tab-count.is-ticking { display: inline-block; animation: v2-board-tick var(--v2-dur-fast) var(--v2-ease); }');
  });

  test('the board drawer slides from the right, slow in and fast out, and its phone scrim fades', () => {
    expect(boardCss).toContain('.v2-feature--board .v2-modal.v2-board__drawer { animation: v2-board-drawer-in var(--v2-dur-slow) var(--v2-ease); }');
    expect(boardCss).toContain('.v2-feature--board .v2-modal.v2-board__drawer[data-leaving] { animation: v2-board-drawer-out var(--v2-dur-fast) var(--v2-ease) forwards; }');
    expect(keyframes(boardCss, 'v2-board-drawer-in')).toContain('from { transform: translateX(100%); }');
    expect(keyframes(boardCss, 'v2-board-drawer-out')).toContain('to { transform: translateX(100%); }');
    expect(boardCss).toContain('.v2-board__overlay--drawer::before { content: \'\'; position: absolute; inset: 0; background: var(--v2-scrim); animation: v2-board-scrim-in var(--v2-dur-slow) var(--v2-ease); }');
    expect(boardCss).toContain('.v2-board__overlay--drawer[data-leaving]::before { animation: v2-board-scrim-out var(--v2-dur-fast) var(--v2-ease) forwards; }');
  });

  test('the connector drawer slides from the right, slow in and fast out, without scrolling sideways', () => {
    expect(cxCss).toContain('.v2-cx-drawer { animation: v2-cx-drawer-in var(--v2-dur-slow) var(--v2-ease); }');
    expect(cxCss).toContain('.v2-cx-drawer.is-leaving { pointer-events: none; animation: v2-cx-drawer-out var(--v2-dur-fast) var(--v2-ease) forwards; }');
    expect(keyframes(cxCss, 'v2-cx-drawer-in')).toContain('from { transform: translateX(100%); }');
    expect(keyframes(cxCss, 'v2-cx-drawer-out')).toContain('to { transform: translateX(100%); }');
    expect(cxCss).toContain('.v2-cx-body { overflow-x: hidden; }');
  });

  test('these moments move transform and opacity only', () => {
    const names = ['v2-board-leave-next', 'v2-board-leave-prev', 'v2-board-tick', 'v2-board-drawer-in', 'v2-board-drawer-out', 'v2-board-scrim-in', 'v2-board-scrim-out'];
    const blocks = [...names.map((name) => keyframes(boardCss, name)), keyframes(cxCss, 'v2-cx-drawer-in'), keyframes(cxCss, 'v2-cx-drawer-out')];
    blocks.forEach((block) => {
      expect(block).not.toBe('');
      const props = Array.from(block.matchAll(/([a-z-]+)\s*:/g)).map((match) => match[1]);
      expect(props.filter((prop) => prop !== 'transform' && prop !== 'opacity')).toEqual([]);
    });
  });

  test('board and connector transitions use the tokens, never a hard-coded time', () => {
    const transitions = `${boardCss}\n${cxCss}`.match(/transition:[^;}]*/g) || [];
    transitions.forEach((decl) => expect(decl).not.toMatch(/\d(ms|s)\b/));
  });
});
