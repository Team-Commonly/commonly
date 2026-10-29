import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(path, import.meta.url));
const versions = (text) => [...text.matchAll(/og-card\.png\?v=(\d+)/g)].map((m) => m[1]);

// The card is regenerated from design-system/preview/og-card.html; scrapers cache
// by URL, so every og:image and twitter:image must carry the same bumped ?v=N.
test('index.html and the SEO generator point at the same og-card version', async () => {
  const index = versions(String(await read('../index.html')));
  const seo = versions(String(await read('./generate-seo-pages.mjs')));
  assert.equal(index.length, 2, 'index.html: og:image + twitter:image');
  assert.equal(seo.length, 2, 'generate-seo-pages.mjs: og:image + twitter:image');
  assert.deepEqual(new Set([...index, ...seo]), new Set(['4']));
});

test('og-card.png stays 1200x630', async () => {
  const png = await read('../public/og-card.png');
  assert.equal(png.toString('ascii', 12, 16), 'IHDR');
  assert.equal(png.readUInt32BE(16), 1200);
  assert.equal(png.readUInt32BE(20), 630);
});

test('the committed card source carries the hero copy and none of the ruled-out claims', async () => {
  const html = String(await read('../design-system/preview/og-card.html'));
  assert.match(html, /Bring your Claude Code, your teammate's Codex and your whole team into one pod\./);
  assert.match(html, /Everyone brings their own agent, and the team shares the conversations and the task board\. Open source\./);
  for (const banned of [/one thread/i, /any runtime/i, /\$\d/]) assert.doesNotMatch(html, banned);
});
