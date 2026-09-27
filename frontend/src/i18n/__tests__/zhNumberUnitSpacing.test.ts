import fs from 'fs';
import path from 'path';

// TASK-179, lily-shen's ruling (2026-09-27): zh writes a number and its unit
// together — 「24小时」, 「{{n}}天前」 — which is also what the browser's own zh-CN
// Intl.RelativeTimeFormat and NumberFormat produce (ux-lead's 75076). The catalog
// was 31 values the other way, so the convention gets a guard rather than a
// reviewer's eye: this fails on the next value that reintroduces a space.
//
// The detector is deliberately narrow. It is a number — literal digits or a
// {{placeholder}} — followed by spaces and then a unit. A space after a
// placeholder that is followed by an ordinary word stays (「{{count}} 个智能体」):
// that is the placeholder boundary, not the number↔unit one.

const UNITS = ['分钟', '小时', '个月', '天', '周', '月', '年', '秒'];
const AMOUNT = String.raw`(?:\d+|\{\{[a-zA-Z]+\}\})`;
const spacedAmount = new RegExp(`${AMOUNT} +(?=(?:${UNITS.join('|')}))`);
const attachedAmount = new RegExp(`${AMOUNT}(?=(?:${UNITS.join('|')}))`);

type Tree = { [key: string]: string | Tree };

const flatten = (tree: Tree, prefix = ''): Array<[string, string]> => Object.entries(tree).flatMap(([key, value]) => {
  const fullKey = prefix ? `${prefix}.${key}` : key;
  return typeof value === 'string' ? [[fullKey, value] as [string, string]] : flatten(value, fullKey);
});

const zhValues = flatten(JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'locales', 'zh-CN.json'), 'utf8'),
));

describe('zh-CN number and unit spacing', () => {
  it('never separates a number from its unit', () => {
    expect(zhValues.filter(([, value]) => spacedAmount.test(value)).map(([key]) => key)).toEqual([]);
  });

  it('is not green because the detector matches nothing', () => {
    // Vacuity control. The same detector has to be able to fire — on a
    // hand-written spaced pair and on the attached pairs this catalog does
    // contain — or the test above would pass just as well if the regex were
    // blind, which is the failure it cannot otherwise report (TASK-164's
    // null==null pass was this shape).
    expect(spacedAmount.test('24 小时')).toBe(true);
    expect(spacedAmount.test('24小时')).toBe(false);
    expect(attachedAmount.test('24小时')).toBe(true);
    expect(zhValues.filter(([, value]) => attachedAmount.test(value)).length).toBeGreaterThan(0);
  });
});
