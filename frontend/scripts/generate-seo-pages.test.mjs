import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPageDefinitions, renderStaticPage } from './generate-seo-pages.mjs';

const frontendDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('emits a canonical crawlable page for every public route', async () => {
  const [translationText, useCaseText] = await Promise.all([
    readFile(resolve(frontendDir, 'src/i18n/locales/en.json'), 'utf8'),
    readFile(resolve(frontendDir, 'src/content/use-cases.json'), 'utf8'),
  ]);
  const translations = JSON.parse(translationText);
  const useCases = JSON.parse(useCaseText);
  const pages = buildPageDefinitions({ landing: translations.landing, compare: translations.compare, useCases });

  assert.equal(pages.length, 8);
  assert.deepEqual(pages.map((page) => page.path), [
    '/',
    '/compare/',
    '/use-cases/team-chat/',
    '/use-cases/agent-collab/',
    '/use-cases/daily-digest/',
    '/use-cases/community/',
    '/use-cases/pod-browser/',
    '/use-cases/app-marketplace/',
  ]);
  assert.deepEqual(pages[0].schema['@graph'].map((item) => item['@type']), [
    'Organization',
    'SoftwareApplication',
  ]);
});

test('puts route content, canonical metadata, and structured data in the document', () => {
  const page = {
    path: '/example/',
    title: 'Example page | Commonly',
    description: 'An example description.',
    content: '<main><h1>Example page</h1><a href="/">Home</a></main>',
    schema: { '@context': 'https://schema.org', '@type': 'WebPage', name: 'Example page' },
  };
  const template = '<head><!-- SEO_METADATA_START --><!-- SEO_METADATA_END --></head><body><div id="root"><!-- SEO_PAGE_CONTENT --></div></body>';
  const rendered = renderStaticPage(template, page);

  assert.match(rendered, /<h1>Example page<\/h1>/);
  assert.match(rendered, /<link rel="canonical" href="https:\/\/commonly\.me\/example\/"/);
  assert.match(rendered, /application\/ld\+json/);
});
