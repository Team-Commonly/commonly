// @ts-nocheck
// Timing claims in the product copy, only where measured ("copy: timing claims
// only where measured", Cofounder's rulings 2026-10-17). Each one cites its
// measurement here, so the next reviewer does not have to rediscover it, and
// any new seconds claim in the English copy has to come through this file.
const en = require('../i18n/locales/en.json');
const zh = require('../i18n/locales/zh-CN.json');

const leaves = (node, path = []) => Object.entries(node).flatMap(([k, v]) => (
  v && typeof v === 'object' ? leaves(v, [...path, k]) : [[[...path, k].join('.'), String(v)]]
));

describe('timing claims in the copy', () => {
  // Click to live: QA hosted walk 5 timed "Run it here" clicked to provisioned
  // at 2.54 s (install 1.83 + provision 0.63); walk 4: 2.47 s.
  // ~/.commonly/state/notes/qa-hosted-oob-5/report.md, timing table.
  test('click to live says "a few seconds", in both languages', () => {
    expect(en.agentByo.mode.hostedMeta).toBe('Live in a few seconds — no terminal, no keys');
    expect(en.agentByo.compact.lead).toContain('live a few seconds after you press the button');
    expect(zh.agentByo.mode.hostedMeta).toContain('几秒');
    expect(zh.agentByo.compact.lead).toContain('几秒');
  });

  // Reply time: n=8 from two walks by one tester, asks a-d in the comparison
  // table of the same report. Walk 5: 10.5, 13.4, 7.8, 8.0 s; walk 4: 14.3,
  // 10.4 (the retry), 8.0, 10.4 s; mean 10.35 s. If a later walk measures
  // well off ten, this line changes. The zh says "about", never "within": two
  // of the eight were over 13 s.
  test('reply time says "about ten seconds", never a ceiling', () => {
    expect(en.agentByo.hosted.latencyHint).toBe('Replies typically land in about ten seconds.');
    expect(zh.agentByo.hosted.latencyHint).toBe('回复通常需要10秒左右。');
    expect(zh.agentByo.hosted.latencyHint).not.toMatch(/内/);
  });

  test('no other English copy makes a seconds claim', () => {
    const cited = new Set(['agentByo.mode.hostedMeta', 'agentByo.compact.lead', 'agentByo.hosted.latencyHint']);
    const claims = leaves(en)
      .filter(([key, value]) => !cited.has(key)
        && /\b(within|in|a few|several|~?\s?\d+) seconds?\b|\bin seconds\b/i.test(value))
      .map(([key]) => key);
    expect(claims).toEqual([]);
  });
});
