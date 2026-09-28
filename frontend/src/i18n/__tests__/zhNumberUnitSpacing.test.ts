import fs from 'fs';
import path from 'path';

// zh-CN spacing around numerals, in both directions. Two rulings, one rule.
//
// TASK-179 (lily-shen, 2026-09-27): zh writes a number and its unit together —
// 「24小时」, 「{{n}}天前」 — which is also what the browser's own zh-CN
// Intl.RelativeTimeFormat and NumberFormat produce (ux-lead's 75076). The catalog
// was 31 values the other way, so the convention gets a guard rather than a
// reviewer's eye.
//
// TASK-180 (lily-shen's card choice, 2026-09-28 — "Apply the rule, both sides"):
// the same rule applies to every numeral next to hanzi, not only to the unit case.
// 159 further spaces were closed across 103 values.
//
// Which placeholders count as numerals is the load-bearing question, and it CANNOT
// be decided from this catalog: ``{{agents}}`` is a count in `yourTeam.head.meta`
// and a name list joined with ' and ' in `inspector.workspace.nothingWorking_other`.
// A first cut of the sweep declared `agents` a numeral by name and closed
// 「Scout 可以使用」 in the Tools panel; `V2ConnectorTools.test.tsx` caught it. So the
// default is opaque, the numeral names are declared here, and the coverage test
// below makes a new interpolation fail rather than inherit whichever silence looks
// convenient.
const NUMERAL_PLACEHOLDERS = [
  // bare numbers, or numbers formatted with grouping separators (Intl.NumberFormat)
  'count', 'formattedCount', 'uses', 'maxUses', 'complete', 'total', 'attempt',
  'revision', 'position', 'cap', 'turns', 'notes', 'days', 'signups', 'active',
  'working', 'needsYou', 'minutes', 'calls',
  // a formatted duration, closed because the ruling names this key explicitly:
  // tools.budgetWindow renders 「每1小时可调用5次」
  'window',
];

// A name, a date, a formatted duration, or an unproven value. The ruling keeps the
// space wherever hanzi meets one of these. `age` and `time` are durations from a
// formatter (relativeTime / timeAgo), not bare numbers, so they are not the
// subject of this rule — neither is `projects`, whose value no consumer in the
// shell proves either way.
const OPAQUE_PLACEHOLDERS = [
  'age', 'by', 'pod', 'email', 'provider', 'podName', 'creator', 'date', 'agentName',
  'name', 'second', 'first', 'handle', 'author', 'affiliations', 'username', 'code',
  'label', 'taskId', 'agent', 'machine', 'time', 'section', 'platform', 'projects',
  'connector', 'user', 'workspace', 'channel', 'tool', 'tools', 'member', 'agents',
];

// The exception runs the safe way: a name that is usually opaque and is a number
// here, named by key. `agents` is a count in yourTeam.head.meta (counts.agents) and
// a name list in the inspector, so it cannot be declared for the catalog as a whole.
const NUMERAL_BY_KEY: Array<[string, string]> = [['yourTeam.head.meta', 'agents']];

// A digit is this rule's numeral only when it stands alone. `Apache-2.0 许可` and
// `D1 回访` keep their space: the digits belong to a Latin token there, and the
// ruling keeps the space wherever hanzi meets a Latin word or unit.
const INSIDE_LATIN_TOKEN = /[A-Za-z0-9._-]/;

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

type Boundary = { side: 'before' | 'after'; insertion: string; precededBy: string };

// Every place a numeral is separated from a hanzi by spaces. Both sides are
// collected and each carries the insertion's name and the character in front of
// it, because `2.0` and `Apache-2.0` are the same digits with different answers.
const boundaryEvents = (value: string): Boundary[] => {
  const events: Boundary[] = [];
  const numeral = String.raw`(?:\d[\d,.]*|\{\{[a-zA-Z]+\}\})`;
  const name = (token: string) => (token.startsWith('{{') ? token.slice(2, -2) : 'DIGIT');
  for (const match of value.matchAll(new RegExp(`([\\u4e00-\\u9fff]) +(?=(${numeral}))`, 'g'))) {
    events.push({ side: 'after', insertion: name(match[2]), precededBy: match[1] });
  }
  for (const match of value.matchAll(new RegExp(`(${numeral}) +(?=[\\u4e00-\\u9fff])`, 'g'))) {
    events.push({
      side: 'before',
      insertion: name(match[1]),
      precededBy: match.index === undefined ? '' : value[match.index - 1] || '',
    });
  }
  return events;
};

const isNumeral = (key: string, event: Boundary): boolean => {
  if (event.insertion === 'DIGIT') return !INSIDE_LATIN_TOKEN.test(event.precededBy);
  if (NUMERAL_BY_KEY.some(([prefix, placeholder]) => key.startsWith(prefix) && placeholder === event.insertion)) return true;
  return NUMERAL_PLACEHOLDERS.includes(event.insertion);
};

const offenders = (side: 'before' | 'after'): string[] => zhValues.flatMap(([key, value]) => (
  boundaryEvents(value)
    .filter((event) => event.side === side && isNumeral(key, event))
    .map((event) => `${key} [${event.insertion}]`)
));

describe('zh-CN number and unit spacing', () => {
  it('never separates a number from its unit', () => {
    expect(zhValues.filter(([, value]) => spacedAmount.test(value)).map(([key]) => key)).toEqual([]);
  });

  it('never separates a hanzi from the numeral that follows it', () => {
    // 「在过去 {{days}}天」 → 「在过去{{days}}天」
    expect(offenders('after')).toEqual([]);
  });

  it('never separates a numeral from the hanzi that follows it', () => {
    // 「{{count}} 条更新」 → 「{{count}}条更新」
    expect(offenders('before')).toEqual([]);
  });

  it('declares every placeholder that reaches a boundary, so a new one cannot be exempt', () => {
    // The test that keeps the two lists honest: a placeholder that is neither
    // declared a numeral nor declared opaque fails here, which forces a call-site
    // read instead of letting a new interpolation inherit silence. Without it the
    // guard is green for any name it has not been taught.
    const declared = [...NUMERAL_PLACEHOLDERS, ...OPAQUE_PLACEHOLDERS];
    const undeclared = Array.from(new Set(zhValues.flatMap(([key, value]) => (
      boundaryEvents(value).map((event) => (
        NUMERAL_BY_KEY.some(([prefix, placeholder]) => key.startsWith(prefix) && placeholder === event.insertion)
          ? ''
          : event.insertion
      ))
    )))).filter((insertion) => insertion !== '' && insertion !== 'DIGIT' && !declared.includes(insertion));
    expect(undeclared).toEqual([]);
    expect(declared.length).toBeGreaterThan(40);
  });

  it('keeps the space wherever hanzi meets a Latin word, measured against the catalog', () => {
    // The ruling's other half, and what stops the fix above from generalising into
    // "delete every space": 242 values space a hanzi↔Latin boundary and 0 do not,
    // so it is pinnable. It is also the reason {{age}} and {{time}} are exempt —
    // a formatter's duration is not a bare numeral.
    const latin = '[A-Za-z]{2,}';
    const unspaced = new RegExp(`[\\u4e00-\\u9fff](?=${latin})|(?<=${latin})[\\u4e00-\\u9fff]`);
    const spaced = new RegExp(`[\\u4e00-\\u9fff] +(?=${latin})|(?<=${latin}) +[\\u4e00-\\u9fff]`);
    expect(zhValues.filter(([, value]) => unspaced.test(value)).map(([key]) => key)).toEqual([]);
    expect(zhValues.filter(([, value]) => spaced.test(value)).length).toBeGreaterThan(200);
  });

  it('is not green because the detector matches nothing', () => {
    // Vacuity control. The same detector has to be able to fire — on a hand-written
    // spaced pair and on the attached pairs this catalog does contain — or the test
    // above would pass just as well if the regex were blind, which is the failure it
    // cannot otherwise report (TASK-164's null==null pass was this shape).
    expect(spacedAmount.test('24 小时')).toBe(true);
    expect(spacedAmount.test('24小时')).toBe(false);
    expect(attachedAmount.test('24小时')).toBe(true);
    expect(zhValues.filter(([, value]) => attachedAmount.test(value)).length).toBeGreaterThan(0);

    // The same control for the TASK-180 detectors. It has to show four things: that
    // they fire on the shape, that each declared exemption is what suppresses them
    // (not a blind pattern), that the by-key exception is load-bearing, and that a
    // digit inside a Latin token is not a numeral — the last one being a real
    // false close the first cut made to `landing.footer.copyright`.
    const found = (key: string, value: string) => boundaryEvents(value)
      .filter((event) => isNumeral(key, event)).length;
    expect(found('podChat.thread.moreReplies', '还有 {{count}} 项')).toBe(2);
    expect(found('agentProfile.pods.activeAgo', '活跃于 {{time}}')).toBe(0);
    expect(found('inspector.workspace.nothingWorking_other', '没有需要你处理的事项。{{agents}} 正在工作。')).toBe(0);
    expect(found('yourTeam.head.meta', '{{agents}} 个智能体 · {{working}} 个工作中')).toBe(2);
    expect(found('landing.footer.copyright', '代码采用 Apache-2.0 许可')).toBe(0);
    expect(found('adminAnalytics.funnel.table.returnedD1', 'D1 回访')).toBe(0);
    expect(found('auth.reset.errors.tooShort', '密码至少需要 8 个字符。')).toBe(2);
    // and the catalog still holds events on both sides for the detectors to find, so
    // a green run means "none left" rather than "nothing scanned".
    expect(zhValues.filter(([, value]) => boundaryEvents(value).some((e) => e.side === 'before')).length)
      .toBeGreaterThan(0);
    expect(zhValues.filter(([, value]) => boundaryEvents(value).some((e) => e.side === 'after')).length)
      .toBeGreaterThan(0);
  });
});
