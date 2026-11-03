#!/usr/bin/env node
// F78: on dev, no container that calls Gemini directly gets GEMINI_API_KEY, and
// the backend draws avatars and skips embeddings. Reads a rendered manifest:
//   helm template ... -f values.yaml -f values-dev.yaml | node scripts/verify-dev-provider-env.js
const fs = require('fs');
const yaml = require('js-yaml');

const docs = yaml.loadAll(fs.readFileSync(0, 'utf8')).filter(Boolean);
const envOf = (name) => {
  const d = docs.find((x) => x.kind === 'Deployment' && x.metadata?.name === name);
  if (!d) return null;
  return Object.fromEntries(
    (d.spec.template.spec.containers[0].env || []).map((e) => [e.name, e.value ?? 'secretRef']),
  );
};

const failures = [];
for (const name of ['backend', 'ops-runner', 'commonly-bot']) {
  const env = envOf(name);
  if (!env) {
    if (name !== 'commonly-bot') failures.push(`${name}: Deployment not rendered`);
    continue;
  }
  if ('GEMINI_API_KEY' in env) failures.push(`${name}: GEMINI_API_KEY is set`);
  if (name !== 'commonly-bot') {
    if (env.AVATAR_PROVIDER !== 'design') failures.push(`${name}: AVATAR_PROVIDER=${env.AVATAR_PROVIDER}`);
    if (env.EMBEDDING_PROVIDER !== 'none') failures.push(`${name}: EMBEDDING_PROVIDER=${env.EMBEDDING_PROVIDER}`);
  }
}
// LiteLLM's own routes read the key, so it keeps it.
const litellm = envOf('litellm');
if (litellm && !('GEMINI_API_KEY' in litellm)) failures.push('litellm: GEMINI_API_KEY missing');

if (failures.length) {
  console.error(`dev provider env check failed:\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log('dev provider env: ok');
