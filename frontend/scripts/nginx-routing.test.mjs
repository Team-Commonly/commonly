import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const frontendDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { publicHitScript } = await import('./generate-seo-pages.mjs');

test('unknown public routes are real 404s while documented app routes retain SPA fallback', async () => {
  const config = await readFile(resolve(frontendDir, 'nginx.conf'), 'utf8');
  const notFoundPage = await readFile(resolve(frontendDir, 'public/404.html'), 'utf8');

  assert.match(config, /absolute_redirect\s+off;/);
  assert.match(config, /location \/ \{\s*try_files \$uri \$uri\/ =404;/s);
  assert.match(config, /error_page\s+404\s+\/404\.html;/);
  assert.match(config, /location = \/404\.html\s*\{\s*internal;/s);
  assert.doesNotMatch(config, /error_page\s+404\s+\/index\.html/);
  // The fallback is the noindex app shell, not the prerendered homepage (F396).
  assert.match(config, /location ~ \^\/\(\?:v2\(\?:\/\|\$\).*try_files \$uri \$uri\/ \/app\.html;/s);
  assert.doesNotMatch(config, /try_files[^;]*\/index\.html;/);
  assert.match(config, /privacy\/\?\$\|terms\/\?\$/);
  assert.match(config, /login\/\?\$/);
  assert.match(config, /pods\(\?:\/\|\$\)/);
  assert.match(notFoundPage, /<title>Page not found \| Commonly AI<\/title>/);
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
  // Server, index.html, app.html, signup-source.js and the hashed asset location
  // need their own copy where Cache-Control overrides inherited headers.
  assert.equal([...config.matchAll(policy)].length, 5);
  assert.doesNotMatch(config, /img-src[^"\n]*\*/);
  const imagePolicies = [...config.matchAll(/Content-Security-Policy "img-src ([^"\n]+)"/g)];
  assert.equal(imagePolicies.length, 5);
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

test('the app shell, like index.html, is never browser-cached (F396)', async () => {
  const config = await readFile(resolve(frontendDir, 'nginx.conf'), 'utf8');
  const block = config.match(/location = \/app\.html \{([^}]+)\}/)?.[1];
  assert.ok(block);
  assert.match(block, /Cache-Control "no-cache, no-store, must-revalidate" always/);
  assert.match(block, /expires -1;/);
});

// F400: every public page counts its view with one inline script. A policy that
// limits scripts (script-src, or default-src) blocks it unless it names the
// script's hash, and the counts would stop with no error anywhere. The hash is
// of the production build, whose API base is api.commonly.me.
const scriptLimitingPolicies = (config) => [...config.matchAll(/Content-Security-Policy "([^"\n]+)"/g)]
  .map(([, policy]) => policy)
  // Directive names are case-insensitive; script-src-attr governs only inline handlers.
  .filter((policy) => /(^|;)\s*(script-src|script-src-elem|default-src)(?=\s|;|$)/i.test(policy));
const assertPoliciesAllowPublicHit = (config) => {
  const script = publicHitScript('https://api.commonly.me');
  const body = script.slice(script.indexOf('>') + 1, script.lastIndexOf('</script>'));
  const hash = `'sha256-${createHash('sha256').update(body).digest('base64')}'`;
  for (const policy of scriptLimitingPolicies(config)) {
    assert.ok(policy.includes(hash), `a script-limiting Content-Security-Policy must allow the public-hit script with ${hash}`);
  }
};

test('a policy that limits scripts names the inline public-hit script by hash (F400)', async () => {
  const config = await readFile(resolve(frontendDir, 'nginx.conf'), 'utf8');
  assertPoliciesAllowPublicHit(config);
  // The guard trips on a policy that would block the script, and only on one that limits scripts.
  assert.throws(() => assertPoliciesAllowPublicHit(`add_header Content-Security-Policy "default-src 'self'" always;`), /public-hit/);
  assert.throws(() => assertPoliciesAllowPublicHit(`add_header Content-Security-Policy "img-src 'self'; script-src 'self'" always;`), /public-hit/);
  assert.throws(() => assertPoliciesAllowPublicHit(`add_header Content-Security-Policy "Script-Src 'self'" always;`), /public-hit/);
  assert.doesNotThrow(() => assertPoliciesAllowPublicHit(`add_header Content-Security-Policy "img-src 'self' data:" always;`));
  assert.doesNotThrow(() => assertPoliciesAllowPublicHit(`add_header Content-Security-Policy "script-src-attr 'none'" always;`));
});
