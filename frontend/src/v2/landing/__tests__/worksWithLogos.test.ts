/**
 * Every Works with tile carries a mark. A mark is a downloaded file, so it is
 * treated as untrusted until this suite has read it, and each one has one config
 * line and a provenance row, so any one can come out on its own.
 */
import fs from 'fs';
import path from 'path';

const PAGE = fs.readFileSync(path.join(__dirname, '..', 'V2LandingPage.tsx'), 'utf8');
const CSS = fs.readFileSync(path.join(__dirname, '..', 'v2-landing.css'), 'utf8');
const PUBLIC = path.resolve(__dirname, '../../../../public');
const DIR = path.join(PUBLIC, 'logos/works-with');
const DOC = fs.readFileSync(
  path.resolve(__dirname, '../../../../../docs/design/landing-works-with-provenance.md'),
  'utf8',
);

const listOf = (name: string): string[] => [
  ...new RegExp(`const ${name} = \\[([^\\]]*)\\]`).exec(PAGE)![1].matchAll(/'(\w+)'/g),
].map((match) => match[1]);

const config = /const WORKS_WITH_LOGOS[^=]*= \{\n([\s\S]*?)\n\};/.exec(PAGE)![1];
const lines = config.split('\n');
const shipped = fs.readdirSync(DIR);

// External references hide in several attributes, so the check names each door.
// xmlns declarations are namespaces, not fetches, and stay out of the url scan.
const UNSAFE: Array<[string, RegExp]> = [
  ['script', /<script/i],
  ['foreignObject', /<foreignObject/i],
  ['embedded image', /<image\b/i],
  ['use', /<use\b/i],
  ['style block', /<style/i],
  ['import', /@import/i],
  ['event handler', /[\s/"']on[a-z]+\s*=/i],
  ['href', /\b(?:xlink:)?href\s*=/i],
  ['non-local url()', /url\(\s*["']?(?!#)/i],
  ['external src', /\bsrc\s*=/i],
];

describe('works-with logos', () => {
  test('every tile has a mark, and pi and the held apps stay off', () => {
    const configured = lines.map((line) => /^ {2}(\w+):/.exec(line)![1]);
    const listed = [...listOf('WORKS_WITH_AGENTS'), ...listOf('WORKS_WITH_APPS')];
    expect(listed.filter((key) => key !== 'hosted').sort()).toEqual([...configured].sort());
    expect(listOf('WORKS_WITH_APPS')).toEqual(['linear', 'github', 'telegram', 'slack']);
    expect(listed).not.toEqual(expect.arrayContaining(['pi']));
    for (const key of ['sentry', 'atlassian', 'airtable', 'notion']) {
      expect(listed).not.toContain(key);
    }
  });

  test('the Apps row carries one note, and it names only the read-only apps', () => {
    expect(PAGE).toContain("t('landing.worksWith.appsNote')");
    const read = (name: string) => JSON.parse(
      fs.readFileSync(path.resolve(__dirname, `../../../i18n/locales/${name}.json`), 'utf8'),
    ).landing.worksWith;
    expect(read('en').appsNote).toBe('Agents get read access to Linear and GitHub.');
    expect(read('zh-CN').appsNote).toBe('智能体对 Linear 和 GitHub 只有读取权限。');
    for (const [locale, chat] of [['en', 'Chat'], ['zh-CN', '聊天']]) {
      const { items } = read(locale);
      expect(items.linear.label).toBeUndefined();
      expect(items.github.label).toBeUndefined();
      expect(items.telegram.label).toBe(chat);
      expect(items.slack.label).toBe(chat);
      expect(items.notion).toBeUndefined();
    }
  });

  test('one config line per logo, naming only files that ship', () => {
    for (const line of lines) expect(line).toMatch(/^ {2}\w+: \{ .* \},$/);
    const named = [...config.matchAll(/\/logos\/works-with\/([^']+)'/g)].map((match) => match[1]);
    expect([...new Set(named)].sort()).toEqual([...shipped].sort());
  });

  test('the hosted tile draws our own mark, not a vendor file', () => {
    expect(PAGE).toContain("{id === 'hosted' && <CommonlyMark />}");
  });

  test.each(shipped)('%s is clean, untouched by anything active, and has a provenance row', (file) => {
    const svg = fs.readFileSync(path.join(DIR, file), 'utf8');
    expect(svg.trimStart().startsWith('<svg')).toBe(true);
    for (const [name, pattern] of UNSAFE) {
      expect({ name, found: pattern.test(svg) }).toEqual({ name, found: false });
    }
    expect(DOC).toContain(file);
  });

  test('the unsafe check catches each door it names', () => {
    const samples = [
      '<svg><script>x</script></svg>',
      '<svg><foreignObject/></svg>',
      '<svg><image/></svg>',
      '<svg><use/></svg>',
      '<svg><style>a{}</style></svg>',
      '<svg><path onload="x"/></svg>',
      '<svg/onload="x"></svg>',
      '<svg><a href="https://x"/></svg>',
      '<svg><a xlink:href="https://x"/></svg>',
      '<svg><path fill="url(https://x)"/></svg>',
    ];
    for (const sample of samples) expect(UNSAFE.some(([, pattern]) => pattern.test(sample))).toBe(true);
    expect(UNSAFE.some(([, pattern]) => pattern.test('<svg xmlns="http://www.w3.org/2000/svg"><path clip-path="url(#a)"/></svg>'))).toBe(false);
  });

  test('marks read in both themes: a pair swaps, and a mono file is inked for each', () => {
    expect(CSS).toContain('.v2-landing__works-logo--mono { filter: brightness(0); }');
    expect(CSS).toContain(':root[data-v2-theme="dark"] .v2-landing__works-logo--on-dark { display: block; }');
    expect(CSS).toMatch(/\.v2-landing__works-logo--tone \{ filter: grayscale\(1\) [^}]*contrast\(20\); \}/);
    expect(CSS).toMatch(/:root\[data-v2-theme="dark"\] \.v2-landing__works-logo--tone \{ filter: [^}]*invert\(1\); \}/);
    expect(CSS).toMatch(/:root:not\(\[data-v2-theme="light"\]\) \.v2-landing__works-logo--tone \{ filter: [^}]*invert\(1\); \}/);
    expect(CSS).toContain(':root[data-v2-theme="dark"] .v2-landing__works-logo--mono { filter: brightness(0) invert(1); }');
    expect(CSS).toContain(':root:not([data-v2-theme="light"]) .v2-landing__works-logo--mono { filter: brightness(0) invert(1); }');
  });

  test('the provenance page keeps no retired promise', () => {
    expect(DOC).not.toMatch(/same[- ]day/i);
  });
});
