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

test('/pricing and /pricing/ redirect to the pricing section', async () => {
  const config = await readFile(resolve(frontendDir, 'nginx.conf'), 'utf8');

  assert.match(config, /location = \/pricing \{\s*return 301 \/#pricing;\s*\}/s);
  assert.match(config, /location = \/pricing\/ \{\s*return 301 \/#pricing;\s*\}/s);
});

test('HTML and inherited NGINX locations enforce the same image source policy', async () => {
  const config = await readFile(resolve(frontendDir, 'nginx.conf'), 'utf8');
  assert.match(config, /map \$host \$upload_image_origins \{/);
  // Every map value is an API origin for that frontend host. A new map arm
  // cannot quietly permit a third-party image host via the variable.
  const originMap = config.match(/map \$host \$upload_image_origins \{([^}]+)\}/)?.[1];
  assert.ok(originMap);
  assert.deepEqual(originMap.trim().split('\n').map((line) => line.trim()), [
    'localhost "http://localhost:5000";',
    '127.0.0.1 "http://localhost:5000";',
    '~^app-dev\\.(.+)$ "https://api-dev.$1 http://api-dev.$1";',
    '~^app\\.(.+)$ "https://api.$1 http://api.$1";',
    'default "https://api.$host http://api.$host";',
  ]);
  const policy = /add_header Content-Security-Policy "img-src 'self' \$upload_image_origins data: blob:" always;/g;
  // Server, index.html, signup-source.js and the hashed asset location need
  // their own copy where Cache-Control overrides inherited headers.
  assert.equal([...config.matchAll(policy)].length, 4);
  assert.doesNotMatch(config, /img-src[^"\n]*\*/);
  const imagePolicies = [...config.matchAll(/Content-Security-Policy "img-src ([^"\n]+)"/g)];
  assert.equal(imagePolicies.length, 4);
  for (const [, sources] of imagePolicies) {
    assert.deepEqual(sources.split(/\s+/), ["'self'", '$upload_image_origins', 'data:', 'blob:']);
  }
  const chatRoom = await readFile(resolve(frontendDir, 'src/components/ChatRoom.tsx'), 'utf8');
  assert.doesNotMatch(chatRoom, /logo:\s*['"]https?:\/\//);
  assert.doesNotMatch(chatRoom, /src\s*=\s*['"]https?:\/\//);
});

test('unhashed signup capture script revalidates instead of inheriting six-month immutable caching', async () => {
  const config = await readFile(resolve(frontendDir, 'nginx.conf'), 'utf8');
  const block = config.match(/location = \/signup-source\.js \{([^}]+)\}/)?.[1];
  assert.ok(block);
  assert.match(block, /Cache-Control "no-cache, must-revalidate"/);
  assert.match(block, /expires -1;/);
  assert.match(block, /try_files \$uri =404;/);
});
