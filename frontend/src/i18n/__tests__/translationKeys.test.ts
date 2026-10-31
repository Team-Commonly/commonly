import fs from 'fs';
import path from 'path';
import { LANGUAGE_REGISTRY } from '..';

type TranslationTree = { [key: string]: string | TranslationTree };

const eslintConfig = require('../../../.eslintrc.js');
const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/;

const flattenKeys = (tree: TranslationTree, prefix = ''): string[] => (
  Object.entries(tree).flatMap(([key, value]) => {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    return typeof value === 'string' ? [fullKey] : flattenKeys(value, fullKey);
  })
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
  const languageKeys = LANGUAGE_REGISTRY.map(({ code, translation }) => ({
    code,
    keys: new Set(flattenKeys(translation)),
  }));
  const hasKey = (keys: Set<string>, key: string): boolean => (
    keys.has(key) || [...keys].some((candidate) => candidate.replace(PLURAL_SUFFIX, '') === key)
  );

  // Catalog description maps are locale-only: English renders the server's
  // description, and a locale without a map falls back to it. See V2ConnectorsPage.
  const LOCALE_ONLY_PREFIX = 'connectors.catalogDescriptions.';

  it('keeps every registered language base key path identical', () => {
    const normalize = (keys: Set<string>) => [...new Set([...keys]
      .filter((key) => !key.startsWith(LOCALE_ONLY_PREFIX))
      .map((key) => key.replace(PLURAL_SUFFIX, '')))];
    const baseKeys = normalize(languageKeys[0].keys).sort();
    for (const { keys } of languageKeys) expect(normalize(keys).sort()).toEqual(baseKeys);
  });

  it('provides every CLDR plural form required by each language', () => {
    const pluralBases = new Set(languageKeys.flatMap(({ keys }) => [...keys])
      .filter((key) => PLURAL_SUFFIX.test(key)).map((key) => key.replace(PLURAL_SUFFIX, '')));
    const missing = (language: string, keys: Set<string>) => [...pluralBases].flatMap((base) => (
      new Intl.PluralRules(language).resolvedOptions().pluralCategories
        .filter((category) => !keys.has(`${base}_${category}`))
        .map((category) => `${language}:${base}_${category}`)
    ));

    expect(languageKeys.flatMap(({ code, keys }) => missing(code, keys))).toEqual([]);
  });

  it('resolves every literal translation key used by a migrated component', () => {
    expect(migratedFiles.length).toBeGreaterThan(0);

    const missing: string[] = [];
    for (const relativePath of migratedFiles) {
      const source = fs.readFileSync(path.join(__dirname, '../../..', relativePath), 'utf8');
      for (const key of literalTranslationKeys(source)) {
        for (const { code, keys } of languageKeys) {
          if (!hasKey(keys, key)) missing.push(`${relativePath}: ${code}:${key}`);
        }
      }
    }

    expect(missing).toEqual([]);
  });

  it('keeps the retired chat and bubble files out of the migrated-file manifest', () => {
    expect(migratedFiles).not.toContain('src/v2/components/V2PodChat.tsx');
    expect(migratedFiles).not.toContain('src/v2/components/V2MessageBubble.tsx');
    expect(migratedFiles).toContain('src/v2/components/V2Thread.tsx');
  });
});
