import en from '../../i18n/locales/en.json';
import zhCN from '../../i18n/locales/zh-CN.json';
import fs from 'fs';
import path from 'path';

const SOURCES = [
  path.join(__dirname, '../components/V2ConnectorsPage.tsx'),
  path.join(__dirname, '../components/V2ConnectorTools.tsx'),
  path.join(__dirname, '../utils/localizeRelativeTime.ts'),
];

const source = SOURCES
  .map((filePath) => fs.readFileSync(filePath, 'utf8'))
  .join('\n');

const USED_KEYS = [...new Set(
  [...source.matchAll(/t\(\s*['"]((?:connectors|tools)\.[^'"]+)/g)].map((match) => match[1]),
)].sort();

const SHARED_TIME_KEYS = [...new Set(
  [...source.matchAll(/t\(\s*['"](time\.[^'"]+)/g)].map((match) => match[1]),
)].sort();

const lookup = (bundle: Record<string, unknown>, key: string): unknown => (
  key.split('.').reduce<unknown>((value, part) => (
    value && typeof value === 'object' ? (value as Record<string, unknown>)[part] : undefined
  ), bundle)
);

describe('Connectors and Tools locale coverage', () => {
  test('every component translation key exists in both shipped locales', () => {
    expect(USED_KEYS.length).toBeGreaterThan(150);
    for (const key of USED_KEYS) {
      expect(lookup(en, key)).toEqual(expect.any(String));
      expect(lookup(zhCN, key)).toEqual(expect.any(String));
    }
  });

  test('both pages use one shared time family', () => {
    expect(SHARED_TIME_KEYS.length).toBeGreaterThan(0);
    for (const key of SHARED_TIME_KEYS) {
      expect(lookup(en, key)).toEqual(expect.any(String));
      expect(lookup(zhCN, key)).toEqual(expect.any(String));
    }
    expect(lookup(en, 'connectors.time')).toBeUndefined();
    expect(lookup(en, 'tools.time')).toBeUndefined();
    expect(lookup(zhCN, 'connectors.time')).toBeUndefined();
    expect(lookup(zhCN, 'tools.time')).toBeUndefined();
  });

  test('rendered time and fallback copy does not bypass translation keys', () => {
    const rawEnglishTemplates = [
      /`started \$\{/,
      /`since \$\{/,
      /`added \$\{/,
      /`paused \$\{/,
      /`Slack answered \$\{/,
      /`\$\{title\} · linked to/,
      /\|\| 'Untitled pod'/,
      /\|\| 'another pod'/,
      /\|\| 'This Slack workspace'/,
      /\? `@\$\{[^}]+\}` : 'your Slack user'/,
    ];
    for (const pattern of rawEnglishTemplates) expect(source).not.toMatch(pattern);
  });
});
