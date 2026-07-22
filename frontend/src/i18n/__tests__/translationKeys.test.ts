import fs from 'fs';
import path from 'path';

type TranslationTree = { [key: string]: string | TranslationTree };

const eslintConfig = require('../../../.eslintrc.js');

const flattenKeys = (tree: TranslationTree, prefix = ''): string[] => (
  Object.entries(tree).flatMap(([key, value]) => {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    return typeof value === 'string' ? [fullKey] : flattenKeys(value, fullKey);
  })
);

const readJson = (fileName: string): TranslationTree => JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'locales', fileName), 'utf8'),
);

const literalTranslationKeys = (source: string): string[] => {
  const keys = new Set<string>();
  const tCall = /\bt\(\s*(['"`])([^'"`]+)\1/g;
  const transProp = /\bi18nKey\s*=\s*(['"])([^'"]+)\1/g;

  for (const pattern of [tCall, transProp]) {
    let match = pattern.exec(source);
    while (match) {
      if (match[1] !== '`' || !match[2].includes('${')) keys.add(match[2]);
      match = pattern.exec(source);
    }
  }

  return [...keys];
};

describe('i18n migration manifest', () => {
  const manifestOverride = eslintConfig.overrides.find(
    (override: { rules?: Record<string, unknown> }) => override.rules?.['i18next/no-literal-string'],
  );
  const migratedFiles: string[] = manifestOverride?.files || [];
  const enKeys = new Set(flattenKeys(readJson('en.json')));
  const zhKeys = new Set(flattenKeys(readJson('zh-CN.json')));
  const hasKey = (keys: Set<string>, key: string): boolean => (
    keys.has(key) || keys.has(`${key}_one`) || keys.has(`${key}_other`)
  );

  it('keeps English and Simplified Chinese key paths identical', () => {
    expect([...zhKeys].sort()).toEqual([...enKeys].sort());
  });

  it('resolves every literal translation key used by a migrated component', () => {
    expect(migratedFiles.length).toBeGreaterThan(0);

    const missing: string[] = [];
    for (const relativePath of migratedFiles) {
      const source = fs.readFileSync(path.join(__dirname, '../../..', relativePath), 'utf8');
      for (const key of literalTranslationKeys(source)) {
        if (!hasKey(enKeys, key)) missing.push(`${relativePath}: en:${key}`);
        if (!hasKey(zhKeys, key)) missing.push(`${relativePath}: zh-CN:${key}`);
      }
    }

    expect(missing).toEqual([]);
  });

  it('keeps the deferred message bubble outside the migrated-file manifest', () => {
    expect(migratedFiles).not.toContain('src/v2/components/V2MessageBubble.tsx');
  });
});
