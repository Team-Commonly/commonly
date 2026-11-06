const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const yaml = require('js-yaml');
const { HELM_CHART } = require('../../utils/repoRoot');

// F159 (D243/F98, Cofounder 11-04): hosted agents run Claude only, and DeepSeek
// is deleted from dev once its calls reach zero. Stack measured 19:03:36Z 11-04
// to 01:09Z 11-05: 396 LiteLLM calls, 394 on claude-haiku-5-5, 0 on DeepSeek
// (PR #3421). aiProviders.deepseek gates every DeepSeek route, the key, the
// fallbacks to it and the chat-model default naming it. Off on dev; on in base,
// where DeepSeek stays a self-host option and the OSS default (F103).
const chart = HELM_CHART;
const read = (f) => fs.readFileSync(path.join(chart, f), 'utf8');
const dev = yaml.load(read('values-dev.yaml'), { json: true });
const base = yaml.load(read('values.yaml'), { json: true });
const GATE = '.Values.aiProviders.deepseek.enabled';

// Every `if` around a line, innermost first. A line in an `else` branch reports
// as `else of <if>`, so a DeepSeek line moved into the off branch fails.
const gatesAbove = (lines, i) => {
  const gates = [];
  let depth = 0;
  let inElse = false;
  for (let j = i - 1; j >= 0; j -= 1) {
    const t = lines[j].trim();
    if (/^\{\{-? end/.test(t)) depth += 1;
    else if (/^\{\{-? else/.test(t)) { if (depth === 0) inElse = true; }
    else if (/^\{\{-? (if|range|with) /.test(t)) {
      if (depth === 0) {
        gates.push(inElse ? `else of ${t}` : t);
        inElse = false;
      } else depth -= 1;
    }
  }
  return gates;
};
// Under the DeepSeek gate: some enclosing `if` (not its else) names the flag
// positively, never as `not`.
const underGate = (gates) => gates.some((g) => !g.startsWith('else of')
  && g.includes(GATE) && !g.includes(`not ${GATE}`));

describe('aiProviders.deepseek: off on dev, on by default', () => {
  test('values', () => {
    expect(dev.aiProviders.deepseek.enabled).toBe(false);
    expect(base.aiProviders.deepseek.enabled).toBe(true);
    // Base keeps DeepSeek as the OSS default model (F103).
    expect(base.litellm.agentDefaultModel).toBe('deepseek-v4-flash');
  });

  // The backend jest job has no helm binary, so these read the template text;
  // the render block below and Chart Lint (verify-agent-default-model.js
  // --no-deepseek) render it.
  test('every LiteLLM line that reaches DeepSeek sits under the gate', () => {
    const lines = read('templates/configmaps/litellm-config.yaml').split('\n');
    const found = lines.map((l, i) => ({ l: l.trim(), i }))
      .filter(({ l }) => /^(model:\s*["']?deepseek\/|api_key:\s*os\.environ\/DEEPSEEK_API_KEY|- \{"[^"]+":\s*\["deepseek)/.test(l));
    // Two DeepSeek groups, five stand-ins (each a model + key line), four fallbacks.
    expect(found.length).toBe(2 * 2 + 5 * 2 + 4);
    found.forEach(({ l, i }) => expect([l, underGate(gatesAbove(lines, i))]).toEqual([l, true]));
  });

  test.each([
    ['templates/agents/litellm-deployment.yaml', '- name: DEEPSEEK_API_KEY'],
    ['templates/secrets/api-keys.yaml', '- secretKey: deepseek-api-key'],
    ['templates/core/backend-deployment.yaml', 'value: "deepseek-v4-flash"'],
    ['templates/ops/ops-runner-deployment.yaml', 'value: "deepseek-v4-flash"'],
  ])('%s: %s only under the gate', (file, needle) => {
    const lines = read(file).split('\n');
    const at = lines.map((l, i) => (l.includes(needle) ? i : -1)).filter((i) => i >= 0);
    expect(at).toHaveLength(1);
    expect(underGate(gatesAbove(lines, at[0]))).toBe(true);
  });
});

// A real render, where helm is installed (locally; CI renders the same in
// Chart Lint through verify-agent-default-model.js --no-deepseek).
const helmOk = spawnSync('helm', ['version', '--short'], { encoding: 'utf8' }).status === 0;
const render = (...args) => {
  const r = spawnSync('helm', ['template', 'commonly-dev', chart, '-f', path.join(chart, 'values.yaml'), ...args], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  expect(r.status).toBe(0);
  // helm 4 can write the manifest to stderr; an empty render must not pass.
  const out = r.stdout.trim() ? r.stdout : r.stderr;
  expect(out.split('\n').length).toBeGreaterThan(1000);
  const docs = yaml.loadAll(out).filter(Boolean);
  const cm = docs.find((d) => d.kind === 'ConfigMap' && d.metadata.name === 'litellm-config');
  const config = yaml.load(cm.data['config.yaml']);
  const env = docs.flatMap((d) => ((d.spec?.template?.spec?.containers) || [])
    .flatMap((c) => (c.env || []).map((e) => ({ ...e, workload: d.metadata.name }))));
  const secretKeys = docs.filter((d) => d.kind === 'ExternalSecret')
    .flatMap((d) => (d.spec.data || []).map((e) => e.secretKey));
  return { config, env, secretKeys };
};
const deepseekRoutes = ({ config }) => config.model_list
  .filter((m) => /deepseek/i.test(m.litellm_params.model) || /DEEPSEEK/.test(String(m.litellm_params.api_key)))
  .map((m) => m.model_name);
const fallbackTargets = ({ config }) => (config.router_settings.fallbacks || [])
  .flatMap((rule) => Object.values(rule).flat());
const chatModels = ({ env }) => env
  .filter((e) => ['LITELLM_CHAT_MODEL', 'AGENT_MODEL', 'NATIVE_RUNTIME_MODEL', 'LLM_SERVICE_MODEL', 'AGENT_DEFAULT_MODEL'].includes(e.name))
  .map((e) => `${e.workload} ${e.name}=${e.value}`);

(helmOk ? describe : describe.skip)('helm render', () => {
  const devValues = ['-f', path.join(chart, 'values-dev.yaml')];

  test('dev renders no DeepSeek route, fallback, key or default', () => {
    const r = render(...devValues);
    expect(deepseekRoutes(r)).toEqual([]);
    expect(fallbackTargets(r)).toEqual([]);
    expect(r.env.filter((e) => e.name === 'DEEPSEEK_API_KEY')).toEqual([]);
    expect(r.secretKeys).not.toContain('deepseek-api-key');
    expect(chatModels(r).filter((m) => /deepseek/i.test(m))).toEqual([]);
    expect(chatModels(r)).toContain('backend LITELLM_CHAT_MODEL=claude-haiku-5-5');
  });

  // Negative control: the same checks see DeepSeek when the flag is on.
  test('dev with the flag turned back on renders the DeepSeek routes and key', () => {
    const r = render(...devValues, '--set', 'aiProviders.deepseek.enabled=true');
    expect(deepseekRoutes(r).sort()).toEqual(['deepseek-flash-1017', 'deepseek-v4-flash']);
    expect(r.env.filter((e) => e.name === 'DEEPSEEK_API_KEY').map((e) => e.workload)).toEqual(['litellm']);
  });

  test('base still offers DeepSeek', () => {
    const r = render('--set', 'litellm.enabled=true');
    expect(deepseekRoutes(r)).toEqual(expect.arrayContaining(['deepseek-v4-flash', 'deepseek-flash-1017']));
    expect(r.env.filter((e) => e.name === 'DEEPSEEK_API_KEY').map((e) => e.workload)).toEqual(['litellm']);
    expect(r.secretKeys).toContain('deepseek-api-key');
    expect(chatModels(r)).toContain('backend LITELLM_CHAT_MODEL=deepseek-v4-flash');
  });
});
