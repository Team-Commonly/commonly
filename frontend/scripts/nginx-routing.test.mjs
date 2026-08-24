import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const frontendDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('unknown public routes are real 404s while documented app routes retain SPA fallback', async () => {
  const config = await readFile(resolve(frontendDir, 'nginx.conf'), 'utf8');

  assert.match(config, /location \/ \{\s*try_files \$uri \$uri\/ =404;/s);
  assert.doesNotMatch(config, /error_page\s+404\s+\/index\.html/);
  assert.match(config, /location ~ \^\/\(\?:v2\(\?:\/\|\$\).*try_files \$uri \$uri\/ \/index\.html;/s);
  assert.match(config, /login\/\?\$/);
  assert.match(config, /pods\(\?:\/\|\$\)/);
});
