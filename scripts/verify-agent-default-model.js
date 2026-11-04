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
// A name resolves to every model_list entry that carries it (LiteLLM balances
// across them), and through every fallback LiteLLM would take from it:
// fallbacks, context_window_fallbacks and content_policy_fallbacks, plus
// default_fallbacks, in router_settings or litellm_settings.
// `google/*` gateway fallbacks go straight to Google, not through LiteLLM, so
// they are listed but not resolved (F105 moves them); a google/* primary fails.
// --no-deepseek (dev, Claude-only under D243): no default may reach a
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
const litellmConfig = yaml.load(litellmMap.data['config.yaml']) || {};
const upstreamsOf = new Map();
for (const entry of litellmConfig.model_list || []) {
  const name = String(entry.model_name);
  if (!upstreamsOf.has(name)) upstreamsOf.set(name, []);
  upstreamsOf.get(name).push(String(entry.litellm_params?.model || ''));
}
const fallbacksOf = new Map();
const defaultFallbacks = [];
for (const section of [litellmConfig.router_settings, litellmConfig.litellm_settings]) {
  if (!section) continue;
  for (const key of ['fallbacks', 'context_window_fallbacks', 'content_policy_fallbacks']) {
    for (const rule of section[key] || []) {
      for (const [from, to] of Object.entries(rule || {})) {
        if (!fallbacksOf.has(from)) fallbacksOf.set(from, []);
        fallbacksOf.get(from).push(...[].concat(to).map(String));
      }
    }
  }
  defaultFallbacks.push(...[].concat(section.default_fallbacks || []).map(String));
}
// Every model name a call to `name` can end up on.
const reachable = (name) => {
  const seen = new Set([name]);
  const queue = [name];
  while (queue.length) {
    const next = [...(fallbacksOf.get(queue.shift()) || []), ...defaultFallbacks];
    for (const target of next) if (!seen.has(target)) { seen.add(target); queue.push(target); }
  }
  return [...seen];
};

const resolve = (where, name) => {
  checked.push(`${where}: ${name}`);
  if (!upstreamsOf.has(name)) {
    failures.push(`${where}: "${name}" is not a LiteLLM model_name`);
    return;
  }
  if (!noDeepseek) return;
  for (const reached of reachable(name)) {
    for (const upstream of upstreamsOf.get(reached) || []) {
      if (upstream.startsWith('deepseek/')) {
        const via = reached === name ? '' : ` through the fallback to "${reached}"`;
        failures.push(`${where}: "${name}" reaches ${upstream}${via}`);
      }
    }
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
  const resolveRef = (where, ref, { directGoogleOk = false } = {}) => {
    const slash = ref.indexOf('/');
    const provider = ref.slice(0, slash);
    const id = ref.slice(slash + 1);
    if (provider === 'google') {
      if (!directGoogleOk) {
        failures.push(`${where}: "${ref}" goes straight to Google, not through LiteLLM`);
        return;
      }
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
  for (const ref of model.fallbacks || []) resolveRef('gateway default fallback', String(ref), { directGoogleOk: true });
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
