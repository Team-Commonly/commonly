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

test('the two unpublished guides redirect to a live page, and no guide is built at their paths', async () => {
  const config = await readFile(resolve(frontendDir, 'nginx.conf'), 'utf8');
  const guides = JSON.parse(await readFile(resolve(frontendDir, 'src/content/guides.json'), 'utf8'));
  for (const [slug, target] of [
    ['connect-cursor-shared-workspace', '/guides/run-claude-code-and-codex-together/'],
    ['connect-openclaw-agent', '/guides/'],
  ]) {
    for (const path of [`/guides/${slug}`, `/guides/${slug}/`]) {
      // The query rides along, so a ?ref= on a retired link still reaches signup-source.js.
      assert.ok(config.includes(`location = ${path} { return 301 ${target}$is_args$args; }`), `${path} → ${target}`);
    }
    assert.equal(guides[slug], undefined);
    // Structural absence: no guide link to the page, with or without its trailing slash.
    const linksTo = (target) => new RegExp(`/guides/${target}/?"`);
    assert.doesNotMatch(JSON.stringify(guides), linksTo(slug), `a guide still links to ${slug}`);
  }
  // Positive control: the same search finds a guide link that is known to be there.
  assert.match(JSON.stringify(guides), new RegExp('/guides/ai-agent-memory/?"'));
  // The Cursor guide's readers land on a guide that is still built.
  assert.ok(guides['run-claude-code-and-codex-together']);
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
// Each deployed build bakes its own API base into the script, so each needs
// its own hash. The bases are read from the workflows that build the images
// nginx serves; a local dev server never sits behind this policy.
const builtApiBases = async () => {
  const workflows = await Promise.all(['deploy-dev.yml', 'deploy-staging.yml'].map((name) => (
    readFile(resolve(frontendDir, '../.github/workflows', name), 'utf8'))));
  const bases = workflows.flatMap((text) => [...text.matchAll(/--build-arg REACT_APP_API_URL=(https:\/\/[^\s\\]+)/g)].map((m) => m[1]));
  return [...new Set(bases)];
};
const assertPoliciesAllowPublicHit = (config, bases) => {
  const hashes = bases.map((base) => {
    const script = publicHitScript(base);
    const body = script.slice(script.indexOf('>') + 1, script.lastIndexOf('</script>'));
    return `'sha256-${createHash('sha256').update(body).digest('base64')}'`;
  });
  for (const policy of scriptLimitingPolicies(config)) {
    for (const hash of hashes) {
      assert.ok(policy.includes(hash), `a script-limiting Content-Security-Policy must allow the public-hit script with ${hash}`);
    }
  }
};

test('a policy that limits scripts names the inline public-hit script by hash (F400)', async () => {
  const config = await readFile(resolve(frontendDir, 'nginx.conf'), 'utf8');
  const bases = await builtApiBases();
  // Both deployed builds: prod and staging bake different API bases.
  assert.ok(new Set(bases).has('https://api.commonly.me') && bases.length >= 2, bases.join(', '));
  assertPoliciesAllowPublicHit(config, bases);
  // The guard trips on a policy that would block the script, and only on one that limits scripts.
  assert.throws(() => assertPoliciesAllowPublicHit(`add_header Content-Security-Policy "default-src 'self'" always;`, bases), /public-hit/);
  assert.throws(() => assertPoliciesAllowPublicHit(`add_header Content-Security-Policy "img-src 'self'; script-src 'self'" always;`, bases), /public-hit/);
  assert.throws(() => assertPoliciesAllowPublicHit(`add_header Content-Security-Policy "Script-Src 'self'" always;`, bases), /public-hit/);
  const prodOnly = (() => {
    const script = publicHitScript('https://api.commonly.me');
    return createHash('sha256').update(script.slice(script.indexOf('>') + 1, script.lastIndexOf('</script>'))).digest('base64');
  })();
  assert.throws(() => assertPoliciesAllowPublicHit(`add_header Content-Security-Policy "script-src 'self' 'sha256-${prodOnly}'" always;`, bases), /public-hit/);
  assert.doesNotThrow(() => assertPoliciesAllowPublicHit(`add_header Content-Security-Policy "img-src 'self' data:" always;`, bases));
  assert.doesNotThrow(() => assertPoliciesAllowPublicHit(`add_header Content-Security-Policy "script-src-attr 'none'" always;`, bases));
});
