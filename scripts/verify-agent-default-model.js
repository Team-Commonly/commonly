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
// fallbacks, context_window_fallbacks and content_policy_fallbacks (a `*` rule
// applies to every name), plus default_fallbacks and model_group_alias, in
// router_settings or litellm_settings. Every name reached that way must be a
// model_name or an alias. An upstream is DeepSeek when its model (under any
// provider prefix), custom_llm_provider or api_base says so, in any case.
// `google/*` gateway fallbacks go straight to Google, not through LiteLLM, so
// they are listed but not resolved (F105 moves them); a google/* primary fails.
// Also resolved: the chat-model defaults LITELLM_CHAT_MODEL, NATIVE_RUNTIME_MODEL
// and LLM_SERVICE_MODEL on the backend workloads and AGENT_MODEL on the
// commonly-bot, wherever they are set.
// --no-deepseek (dev, Claude-only under D243): no default may reach a
// deepseek/* upstream, and DeepSeek is deleted outright (F159): no model_list
// entry reaches it, no workload carries DEEPSEEK_API_KEY or reads the
// deepseek-api-key secret key, and no ExternalSecret maps a deepseek key.
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
  upstreamsOf.get(name).push(entry.litellm_params || {});
}
const isDeepseek = (params) => /deepseek/i.test(String(params.model || ''))
  || /deepseek/i.test(String(params.custom_llm_provider || ''))
  || /deepseek/i.test(String(params.api_base || params.base_url || ''));
const fallbacksOf = new Map();
const defaultFallbacks = [];
const aliases = new Set();
for (const section of [litellmConfig.router_settings, litellmConfig.litellm_settings]) {
  if (!section) continue;
  for (const key of ['fallbacks', 'context_window_fallbacks', 'content_policy_fallbacks']) {
    for (const rule of section[key] || []) {
      for (const [from, to] of Object.entries(rule || {})) {
        if (from === '*') { defaultFallbacks.push(...[].concat(to).map(String)); continue; }
        if (!fallbacksOf.has(from)) fallbacksOf.set(from, []);
        fallbacksOf.get(from).push(...[].concat(to).map(String));
      }
    }
  }
  defaultFallbacks.push(...[].concat(section.default_fallbacks || []).map(String));
  for (const [alias, target] of Object.entries(section.model_group_alias || {})) {
    const to = typeof target === 'object' && target ? target.model : target;
    aliases.add(alias);
    if (!fallbacksOf.has(alias)) fallbacksOf.set(alias, []);
    fallbacksOf.get(alias).push(String(to));
  }
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

const routed = (name) => upstreamsOf.has(name) || aliases.has(name);
const resolve = (where, name) => {
  checked.push(`${where}: ${name}`);
  if (!routed(name)) {
    failures.push(`${where}: "${name}" is not a LiteLLM model_name`);
    return;
  }
  for (const reached of reachable(name)) {
    if (!routed(reached)) {
      failures.push(`${where}: "${name}" falls back to "${reached}", which is not a LiteLLM model_name`);
      continue;
    }
    if (!noDeepseek) continue;
    for (const params of upstreamsOf.get(reached) || []) {
      if (isDeepseek(params)) {
        const via = reached === name ? '' : ` through the fallback to "${reached}"`;
        failures.push(`${where}: "${name}" reaches DeepSeek (${params.model})${via}`);
      }
    }
  }
};

// 1. AGENT_DEFAULT_MODEL wherever the provisioner runs, and the chat-model
// defaults beside it.
for (const name of ['backend', 'backend-worker', 'ops-runner']) {
  const dep = docs.find((d) => d.kind === 'Deployment' && d.metadata?.name === name);
  if (!dep) continue;
  const env = dep.spec.template.spec.containers[0].env || [];
  const entry = env.find((e) => e.name === 'AGENT_DEFAULT_MODEL');
  if (!entry || !entry.value) {
    failures.push(`${name}: AGENT_DEFAULT_MODEL is not set`);
  } else {
    resolve(`${name} AGENT_DEFAULT_MODEL`, entry.value);
  }
  for (const key of ['LITELLM_CHAT_MODEL', 'NATIVE_RUNTIME_MODEL', 'LLM_SERVICE_MODEL']) {
    const set = env.find((e) => e.name === key);
    if (set && set.value) resolve(`${name} ${key}`, set.value);
  }
}
const bot = docs.find((d) => d.kind === 'Deployment' && d.metadata?.name === 'commonly-bot');
const botModel = (bot?.spec.template.spec.containers[0].env || []).find((e) => e.name === 'AGENT_MODEL');
if (botModel && botModel.value) resolve('commonly-bot AGENT_MODEL', botModel.value);

// 1b. F159: with --no-deepseek, DeepSeek is gone, not only unused.
if (noDeepseek) {
  for (const [name, params] of upstreamsOf) {
    for (const p of params) {
      if (isDeepseek(p)) failures.push(`litellm-config routes "${name}" to DeepSeek (${p.model})`);
    }
  }
  for (const d of docs) {
    const spec = d.spec?.jobTemplate?.spec?.template?.spec || d.spec?.template?.spec;
    for (const c of [...(spec?.containers || []), ...(spec?.initContainers || [])]) {
      for (const e of c.env || []) {
        if (/deepseek/i.test(e.name)) failures.push(`${d.metadata?.name}: env ${e.name} is set`);
        else if (/deepseek/i.test(String(e.valueFrom?.secretKeyRef?.key || ''))) {
          failures.push(`${d.metadata?.name}: env ${e.name} reads secret key ${e.valueFrom.secretKeyRef.key}`);
        }
      }
    }
    if (d.kind === 'ExternalSecret') {
      for (const e of d.spec?.data || []) {
        if (/deepseek/i.test(`${e.secretKey} ${e.remoteRef?.key || ''}`)) {
          failures.push(`ExternalSecret ${d.metadata?.name} maps ${e.secretKey}`);
        }
      }
    }
  }
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
