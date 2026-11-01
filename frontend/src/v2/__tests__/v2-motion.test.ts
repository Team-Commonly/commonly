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

describe('v2 motion: chat', () => {
  const chatMessageCss = fs.readFileSync(path.join(v2Dir, 'chat', 'chat-message.css'), 'utf8');
  const chatPaneCss = fs.readFileSync(path.join(v2Dir, 'chat', 'chat-pane.css'), 'utf8');
  const rule = (css: string, selector: string): string => {
    const start = css.indexOf(`${selector} {`);
    expect(start).toBeGreaterThan(-1);
    return css.slice(start, css.indexOf('}', start) + 1);
  };
  const keyframes = (css: string, name: string): string => {
    const start = css.indexOf(`@keyframes ${name} {`);
    expect(start).toBeGreaterThan(-1);
    return css.slice(start, css.indexOf('}\n}', start) + 3);
  };

  test('a live message enters over --v2-dur on the one curve, by opacity and 4px of transform only', () => {
    expect(rule(chatMessageCss, '.v2-msg--enter')).toContain('animation: v2-msg-enter var(--v2-dur) var(--v2-ease) backwards;');
    const frames = keyframes(chatMessageCss, 'v2-msg-enter');
    expect(frames).toContain('opacity: 0;');
    expect(frames).toContain('transform: translateY(4px);');
    expect(frames.replace(/opacity: 0;|transform: translateY\(4px\);/g, '')).not.toMatch(/[a-z-]+:\s*[^;]+;/);
  });

  test('content replacing the loader fades in over --v2-dur, opacity only', () => {
    expect(rule(chatPaneCss, '.v2-chat__messages--reveal')).toContain('animation: v2-chat-reveal var(--v2-dur) var(--v2-ease) backwards;');
    expect(keyframes(chatPaneCss, 'v2-chat-reveal')).toMatch(/from \{ opacity: 0; \}/);
  });

  test('Show more opens by size over --v2-dur and closes over --v2-dur-fast, with no max-height', () => {
    const fold = rule(chatMessageCss, '.v2-msg__prose--fold');
    expect(fold).toContain('interpolate-size: allow-keywords;');
    expect(fold).toContain('block-size: auto;');
    expect(fold).toContain('transition: block-size var(--v2-dur) var(--v2-ease);');
    const closed = rule(chatMessageCss, '.v2-msg__prose--closed');
    expect(closed).toContain('block-size: 132px;');
    expect(closed).toContain('transition-duration: var(--v2-dur-fast);');

    const code = rule(chatMessageCss, '.v2-msg__collapse pre');
    expect(code).toContain('block-size: auto;');
    expect(code).toContain('transition: block-size var(--v2-dur) var(--v2-ease);');
    expect(rule(chatMessageCss, '.v2-msg__collapse--closed pre')).toContain('transition-duration: var(--v2-dur-fast);');

    const folds = [fold, closed, code, rule(chatMessageCss, '.v2-msg__collapse--closed pre')].join('\n');
    expect(folds).not.toMatch(/max-height/);
  });

  test('the Show more chevron turns on the same tokens: open over --v2-dur, back over --v2-dur-fast', () => {
    expect(rule(chatMessageCss, '.v2-msg__showmore svg')).toContain('transition: transform var(--v2-dur-fast) var(--v2-ease);');
    expect(rule(chatMessageCss, ".v2-msg__showmore[aria-expanded='true'] svg")).toContain('transition-duration: var(--v2-dur);');
  });
});
