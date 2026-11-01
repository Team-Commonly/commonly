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

  test('the title clips to one line, and the whole block stays inside the 760px query', () => {
    const title = phone.match(/\.v2-feature__header\s+\.v2-feature__title\s*\{([^}]*)\}/);
    expect(title).not.toBeNull();
    expect(title![1]).toContain('white-space: nowrap');
    expect(title![1]).toContain('overflow: hidden');
    expect(title![1]).toContain('text-overflow: ellipsis');
    const mediaAt = phone.indexOf('@media (max-width: 760px)');
    expect(mediaAt).toBeGreaterThan(-1);
    expect(phone.indexOf('.v2-feature__header {')).toBeGreaterThan(mediaAt);
    expect(phone.indexOf('.v2-feature__header .v2-feature__title')).toBeGreaterThan(mediaAt);
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

  test('agent settings and memory pages get the same 52px bar inside the 760px query', () => {
    const agentCss = fs.readFileSync(path.join(__dirname, '../agents/v2-agent-settings.css'), 'utf8');
    const tail = agentCss.slice(agentCss.indexOf('D223 (TASK-730)'));
    expect(tail).toMatch(/\.v2-agent-settings > \.v2-page-head,\s*\.v2-agent-settings > \.v2-agent-memory__head\s*\{[^}]*min-height:\s*52px/);
    const at = agentCss.indexOf('D223 (TASK-730)');
    expect(agentCss.slice(0, at).lastIndexOf('@media')).toBe(agentCss.lastIndexOf('@media (max-width: 760px)', at));
  });
});
