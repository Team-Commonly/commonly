#!/usr/bin/env node
// F103: every agent driver default the chart sets names a model LiteLLM serves
// under its own name. Reads a rendered manifest:
//   helm template ... -f values.yaml -f values-dev.yaml | node scripts/verify-agent-default-model.js [--no-deepseek]
//
// Checks, against the rendered litellm-config model_list:
//   - AGENT_DEFAULT_MODEL on the backend, backend-worker and ops-runner (the K8s
//     provisioner and the global policy read it);
//   - the gateway seed config's default primary and fallbacks, and every model
//     registered under a provider that points at LiteLLM;
//   - each cloud-codex agent's codex CLI model.
// `google/*` gateway fallbacks go straight to Google, not through LiteLLM, so
// they are listed but not resolved (F105 moves them).
// --no-deepseek (dev, Claude-only under D243): no default may resolve to a
// deepseek/* upstream.
const fs = require('fs');
const yaml = require('js-yaml');

const noDeepseek = process.argv.includes('--no-deepseek');
const docs = yaml.loadAll(fs.readFileSync(0, 'utf8')).filter(Boolean);
const failures = [];
const checked = [];

const litellmMap = docs.find((d) => d.kind === 'ConfigMap' && d.metadata?.name === 'litellm-config');
if (!litellmMap) {
  console.error('agent default model check: litellm-config not rendered (is litellm.enabled set?)');
  process.exit(1);
}
const upstreamOf = new Map(
  (yaml.load(litellmMap.data['config.yaml']).model_list || [])
    .map((entry) => [String(entry.model_name), String(entry.litellm_params?.model || '')]),
);

const resolve = (where, name) => {
  checked.push(`${where}: ${name}`);
  if (!upstreamOf.has(name)) {
    failures.push(`${where}: "${name}" is not a LiteLLM model_name`);
    return;
  }
  const upstream = upstreamOf.get(name);
  if (noDeepseek && upstream.startsWith('deepseek/')) {
    failures.push(`${where}: "${name}" resolves to ${upstream}`);
  }
};

// 1. AGENT_DEFAULT_MODEL wherever the provisioner runs.
for (const name of ['backend', 'backend-worker', 'ops-runner']) {
  const dep = docs.find((d) => d.kind === 'Deployment' && d.metadata?.name === name);
  if (!dep) continue;
  const env = dep.spec.template.spec.containers[0].env || [];
  const entry = env.find((e) => e.name === 'AGENT_DEFAULT_MODEL');
  if (!entry || !entry.value) {
    failures.push(`${name}: AGENT_DEFAULT_MODEL is not set`);
    continue;
  }
  resolve(`${name} AGENT_DEFAULT_MODEL`, entry.value);
}

// 2. The gateway seed config (moltbot.json).
const gateway = docs.find((d) => d.kind === 'ConfigMap' && d.metadata?.name === 'clawdbot-config');
if (gateway) {
  const config = JSON.parse(gateway.data['moltbot.json']);
  const providers = config.models?.providers || {};
  const viaLitellm = (provider) => /litellm/.test(String(providers[provider]?.baseUrl || ''));
  const resolveRef = (where, ref) => {
    const slash = ref.indexOf('/');
    const provider = ref.slice(0, slash);
    const id = ref.slice(slash + 1);
    if (provider === 'google') {
      checked.push(`${where}: ${ref} (direct to Google, not resolved)`);
      return;
    }
    if (!viaLitellm(provider)) {
      failures.push(`${where}: "${ref}" uses provider "${provider}", which does not point at LiteLLM`);
      return;
    }
    if (!(providers[provider].models || []).some((m) => m.id === id)) {
      failures.push(`${where}: "${ref}" is not in provider "${provider}"'s model list`);
    }
    resolve(where, id);
  };
  const model = config.agents?.defaults?.model || {};
  resolveRef('gateway default primary', String(model.primary || ''));
  for (const ref of model.fallbacks || []) resolveRef('gateway default fallback', String(ref));
  for (const [provider, def] of Object.entries(providers)) {
    if (!def || !viaLitellm(provider)) continue;
    for (const m of def.models || []) resolve(`gateway registry ${provider}`, String(m.id));
  }
} else {
  failures.push('clawdbot-config not rendered');
}

// 3. cloud-codex's codex CLI model (config.toml in the boot script).
for (const dep of docs.filter((d) => d.kind === 'Deployment' && /^cloud-codex-/.test(d.metadata?.name || ''))) {
  const script = JSON.stringify(dep.spec.template.spec);
  const match = script.match(/\\nmodel = \\"([^"\\]+)\\"/);
  if (!match) {
    failures.push(`${dep.metadata.name}: no codex model line found`);
    continue;
  }
  resolve(`${dep.metadata.name} codex model`, match[1]);
}

if (failures.length) {
  console.error(`agent default model check failed:\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log(`agent default model: ok${noDeepseek ? ' (no deepseek upstream)' : ''}\n  ${checked.join('\n  ')}`);
