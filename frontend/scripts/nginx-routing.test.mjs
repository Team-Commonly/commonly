import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const frontendDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('unknown public routes are real 404s while documented app routes retain SPA fallback', async () => {
  const config = await readFile(resolve(frontendDir, 'nginx.conf'), 'utf8');
  const notFoundPage = await readFile(resolve(frontendDir, 'public/404.html'), 'utf8');

  assert.match(config, /absolute_redirect\s+off;/);
  assert.match(config, /location \/ \{\s*try_files \$uri \$uri\/ =404;/s);
  assert.match(config, /error_page\s+404\s+\/404\.html;/);
  assert.match(config, /location = \/404\.html\s*\{\s*internal;/s);
  assert.doesNotMatch(config, /error_page\s+404\s+\/index\.html/);
  assert.match(config, /location ~ \^\/\(\?:v2\(\?:\/\|\$\).*try_files \$uri \$uri\/ \/index\.html;/s);
  assert.match(config, /login\/\?\$/);
  assert.match(config, /pods\(\?:\/\|\$\)/);
  assert.match(notFoundPage, /<title>Page not found \| Commonly<\/title>/);
  assert.match(notFoundPage, /<h1>We couldn’t find that page<\/h1>/);
  assert.match(notFoundPage, /href="\/guides\/"/);
});
