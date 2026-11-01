import fs from 'fs';
import path from 'path';

// TASK-730 (D223): the artboard's 390 frame is a 52px top bar over a single
// column. jsdom has no layout engine, so this pins the presence of the rules
// that carry it, the same way v2-layout-invariants.test.ts does.

const css = fs.readFileSync(path.join(__dirname, '../v2.css'), 'utf8');
// The block is the tail of the sheet, from its marker comment to the end.
const phone = css.slice(css.indexOf('D223 (TASK-730 shell)'));

describe('D223 phone shell', () => {
  test('feature pages get a 52px top bar with the display title', () => {
    expect(phone).toMatch(/\.v2-feature__header\s*\{[^}]*min-height:\s*52px/);
    expect(phone).toMatch(/\.v2-feature__header\s+\.v2-feature__title\s*\{[^}]*font:\s*800 21px\/1 var\(--v2-font-display\)/);
  });

  test('the page body is one tight column and settings leads with the same bar', () => {
    expect(phone).toMatch(/\.v2-feature__body\s*\{[^}]*padding:\s*12px 12px 16px/);
    expect(phone).toMatch(/\.v2-settings__title\s*\{[^}]*min-height:\s*52px/);
  });

  test('the block comes last in the sheet, so it outranks the earlier phone rules', () => {
    const at = css.indexOf('D223 (TASK-730 shell)');
    expect(at).toBeGreaterThan(css.indexOf('.v2-settings__title {'));
    expect(css.indexOf('.v2-feature__body {')).toBeLessThan(at);
  });
});
