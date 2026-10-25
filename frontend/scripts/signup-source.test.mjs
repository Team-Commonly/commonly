import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { renderStaticPage, buildPageDefinitions } from './generate-seo-pages.mjs';

const script = await readFile(new URL('../public/signup-source.js', import.meta.url), 'utf8');
const key = 'commonly.signupSource.v1';

function visit(storage, url, referrer = '') {
  const location = new URL(url);
  vm.runInNewContext(script, {
    window: { location, localStorage: {
      getItem: (k) => storage.get(k) || null, setItem: (k, v) => storage.set(k, v),
    } }, document: { referrer }, URL, URLSearchParams, Date,
  });
  return JSON.parse(storage.get(key));
}

test('captures first public-page touch without query, fragment, or credentials', () => {
  const storage = new Map();
  const first = visit(storage, 'https://commonly.me/guides/a?ref=X&email=secret#invite=secret',
    'https://name:password@search.example/result?q=secret#secret');
  assert.equal(first.landingPath, '/guides/a');
  assert.equal(first.referrer, 'https://search.example/result');
  assert.equal(first.ref, 'x');
  assert.ok(Number.isFinite(Date.parse(first.firstSeenAt)));
  assert.deepEqual(visit(storage, 'https://commonly.me/v2/register?ref=later'), first);
  assert.equal(JSON.stringify(first).includes('secret'), false);
});

test('a direct first visit stays direct; old browsers retain their existing clean ref', () => {
  const storage = new Map();
  assert.equal(visit(storage, 'https://commonly.me/').ref, undefined);
  assert.equal(visit(storage, 'https://commonly.me/v2?ref=later').ref, undefined);
  const old = new Map([['commonly.firstTouchRef', JSON.stringify({ ref: 'HN' })]]);
  assert.equal(visit(old, 'https://commonly.me/').ref, 'hn');
});

test('blocked storage cannot block a public page', () => {
  assert.doesNotThrow(() => vm.runInNewContext(script, {
    window: { localStorage: { getItem() { throw Error('blocked'); } } },
  }));
});

test('static SEO pages preserve the capture script after removing the React entry', async () => {
  const root = new URL('../', import.meta.url);
  const [index, en, useCases, guides] = await Promise.all([
    readFile(new URL('index.html', root), 'utf8'),
    readFile(new URL('src/i18n/locales/en.json', root), 'utf8'),
    readFile(new URL('src/content/use-cases.json', root), 'utf8'),
    readFile(new URL('src/content/guides.json', root), 'utf8'),
  ]);
  const translations = JSON.parse(en);
  const pages = buildPageDefinitions({ landing: translations.landing, compare: translations.compare,
    useCases: JSON.parse(useCases), guides: JSON.parse(guides) });
  // Use the same built-template entry shape as the generator's existing tests.
  const template = index.replace('<script type="module" src="/src/index.tsx"></script>',
    '<script type="module" crossorigin src="/assets/index-example.js"></script>');
  for (const page of pages) {
    const html = renderStaticPage(template, page);
    assert.ok(html.includes('<script src="/signup-source.js"></script>'), page.path);
  }
});
