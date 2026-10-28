import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml, limitText, renderMatrix } from '../compat/render.js';

const results = (detail) => ({
  schema: 'seats-compat/1',
  generatedAt: '2026-10-25T00:00:00.000Z',
  host: { os: 'linux 6.1', platform: 'linux', arch: 'x64', node: 'v22.0.0' },
  checks: [{ id: 'detect', title: 'detect() finds <the> binary' }, { id: 'refusal', title: 'refusal' }],
  targets: [{ target: 'evil@1"><img src=x>', cli: 'evil', version: '1', note: '<b>note</b>' }],
  rows: [
    { target: 'evil@1"><img src=x>', check: 'detect', status: 'pass', detail: 'ok', ms: 3 },
    { target: 'evil@1"><img src=x>', check: 'refusal', status: 'fail', detail, ms: 9 },
  ],
});

test('the renderer escapes a <script> in a detail string, everywhere it appears', () => {
  const html = renderMatrix(results('reply was <script>alert("x")</script> & more'));
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt; &amp; more/);
  assert.doesNotMatch(html, /<img src=x>/);
  assert.doesNotMatch(html, /<b>note<\/b>/);
  assert.doesNotMatch(html, /detect\(\) finds <the>/);
  // The only <script tag would be one we wrote; we write none.
  assert.equal((html.match(/<script/gi) || []).length, 0);
});

test('the page is self-contained, mobile-ready, and shows a details row for a failure', () => {
  const html = renderMatrix(results('provider answered 503'));
  assert.doesNotMatch(html, /\b(?:src|href)=["']?(?:https?:)?\/\//i, 'no external assets');
  assert.doesNotMatch(html, /<link\b/i);
  assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
  assert.match(html, /overflow-x:auto/, 'the grid scrolls inside its box at 390px, not the page');
  assert.match(html, /@media \(max-width:480px\)/);
  assert.match(html, /<tr class="d"><td colspan="3"><div class="dd"><ul><li><strong>refusal<\/strong> fail: <code>provider answered 503<\/code>/);
  assert.match(html, /1 pass<\/li><li class="fail">1 fail/);
});

test('a missing row renders as missing rather than vanishing', () => {
  const doc = results('x');
  doc.rows = doc.rows.slice(0, 1);
  assert.match(renderMatrix(doc), /class="c missing"/);
  assert.equal(escapeHtml(`'"<>&`), '&#39;&quot;&lt;&gt;&amp;');
});

const limitDoc = (status) => ({
  ...results('x'),
  checks: [{ id: 'retry-status', title: 'retry status' }, { id: 'refusal', title: 'refusal' }],
  targets: [{ target: 'opencode@1.19.4', cli: 'opencode', version: '1.19.4' }],
  rows: [
    {
      target: 'opencode@1.19.4', check: 'retry-status', status, detail: '4 provider requests and no session/update', ms: 9,
      limit: { note: 'retries a 5xx and sends no session/update', fixedIn: '@opencode/cli ≥2.0.15' },
    },
    { target: 'opencode@1.19.4', check: 'refusal', status: 'fail', detail: 'boom', ms: 1 },
  ],
});

test('a failure its target declares renders as a limit of that version, with where it is fixed', () => {
  const html = renderMatrix(limitDoc('fail'));
  assert.match(html, /<td class="c limit" title="retry status: limit \(limit of opencode@1\.19\.4: retries a 5xx and sends no session\/update\. Fixed in @opencode\/cli ≥2\.0\.15\)/);
  assert.match(html, /<span aria-hidden="true">!<\/span><span class="sr">limit<\/span>/);
  assert.match(html, /<li><strong>retry-status<\/strong> limit <span class="limit">limit of opencode@1\.19\.4: retries a 5xx and sends no session\/update\. Fixed in @opencode\/cli ≥2\.0\.15<\/span>: <code>4 provider requests/);
  // An undeclared failure on the same row stays a failure.
  assert.match(html, /<td class="c fail" title="refusal: fail — boom"/);
  assert.match(html, /<li class="fail">1 fail<\/li><li class="limit">1 limit<\/li>/);
  assert.equal(limitText({ target: 't@1', limit: { note: 'n' } }), 'limit of t@1: n');
});

test('a declared limit that does not reproduce renders as a pass that says so', () => {
  const html = renderMatrix(limitDoc('pass'));
  assert.match(html, /<td class="c pass"/);
  assert.match(html, /<li class="fail">1 fail<\/li><li class="limit">0 limit<\/li>/);
  assert.match(html, /\(declared limit of opencode@1\.19\.4: retries a 5xx and sends no session\/update\. Fixed in @opencode\/cli ≥2\.0\.15; it did not reproduce\)/);
});

test('a limit note is escaped like every other value', () => {
  const doc = limitDoc('fail');
  doc.rows[0].limit = { note: '<img src=x onerror=1>', fixedIn: '"><script>' };
  const html = renderMatrix(doc);
  assert.doesNotMatch(html, /<img src=x/);
  assert.equal((html.match(/<script/gi) || []).length, 0);
});
