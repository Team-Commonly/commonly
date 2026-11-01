// @ts-nocheck
// Timing claims in the product copy, only where measured ("copy: timing claims
// only where measured", 2026-10-17). Each one cites its
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
  // QA report qa-hosted-oob-5, timing table.
  test('click to live says "a few seconds", in both languages', () => {
    expect(en.agentByo.mode.hostedMeta).toBe('Nothing to install. Live in a few seconds. Beta: {{turns}} turns a day.');
    expect(en.agentByo.compact.lead).toBe('Live in a few seconds. Beta: {{agents}} hosted agent per account, {{turns}} turns a day.');
    expect(zh.agentByo.mode.hostedMeta).toContain('几秒');
    expect(zh.agentByo.compact.lead).toContain('几秒');
  });

  test('no other English copy makes a seconds claim', () => {
    const cited = new Set(['agentByo.mode.hostedMeta', 'agentByo.compact.lead']);
    const claims = leaves(en)
      .filter(([key, value]) => !cited.has(key)
        && /\b(within|in|a few|several|~?\s?\d+) seconds?\b|\bin seconds\b/i.test(value))
      .map(([key]) => key);
    expect(claims).toEqual([]);
  });
});
