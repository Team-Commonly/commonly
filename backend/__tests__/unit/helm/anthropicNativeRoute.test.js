const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

// F91 (D243, 2026-11-04): native turns run on Claude Haiku through LiteLLM, and
// connector data (Calendar under Google's Limited Use) stays on that route: no
// fallback names it, and native calls send disable_fallbacks
// (nativeRuntimeService.nativeModel.test.js). The backend jest job has no helm
// binary, so this reads the template text; Chart Lint renders it.
const chart = path.join(__dirname, '../../../../k8s/helm/commonly');
const read = (f) => fs.readFileSync(path.join(chart, f), 'utf8');
const dev = yaml.load(read('values-dev.yaml'), { json: true });
const base = yaml.load(read('values.yaml'), { json: true });
const GATE = '{{- if .Values.aiProviders.anthropic.enabled }}';

// The text between the gate that opens right above `marker` and its `end`.
const gatedBlock = (file, marker) => {
  const t = read(file);
  const at = t.indexOf(marker);
  expect(at).toBeGreaterThan(-1);
  const open = t.lastIndexOf(GATE, at);
  expect(open).toBeGreaterThan(-1);
  const close = t.indexOf('{{- end }}', open);
  expect(close).toBeGreaterThan(at);
  expect(t.slice(open + GATE.length, at)).not.toMatch(/\{\{-? (end|if)\b/);
  return t.slice(open, close);
};

describe('the Claude route for native turns', () => {
  test('is on for dev and off by default, on Haiku 5.5', () => {
    expect(dev.aiProviders.anthropic.enabled).toBe(true);
    expect(base.aiProviders.anthropic.enabled).toBe(false);
    expect(base.aiProviders.anthropic.nativeModel).toBe('claude-haiku-5-5');
  });

  test('LiteLLM serves it from the Anthropic key, priced and capped well under $400 a month', () => {
    const block = gatedBlock('templates/configmaps/litellm-config.yaml', '- model_name: {{ .Values.aiProviders.anthropic.nativeModel }}');
    expect(block).toContain('model: anthropic/{{ .Values.aiProviders.anthropic.nativeModel }}');
    expect(block).toContain('api_key: os.environ/ANTHROPIC_API_KEY');
    // Priced by LiteLLM's cost map, which has the over-100K tier; a flat
    // override here would bill a long prompt at a fifth of its price.
    expect(block).not.toMatch(/cost_per_token/);
    const cap = Number((block.match(/max_budget: (\d+)/) || [])[1]);
    expect(cap).toBeGreaterThan(0);
    expect(cap).toBeLessThanOrEqual(100);
    expect(block).toContain('budget_duration: 1mo');
  });

  test('no fallback starts from or lands on a Claude model', () => {
    const t = read('templates/configmaps/litellm-config.yaml');
    const router = t.slice(t.indexOf('router_settings:'), t.indexOf('litellm_settings:'));
    expect(router.length).toBeGreaterThan(0);
    expect(router).not.toMatch(/claude|anthropic/i);
  });

  test('the key reaches LiteLLM, and the model reaches native turns, only under the gate', () => {
    expect(gatedBlock('templates/secrets/api-keys.yaml', '- secretKey: anthropic-api-key'))
      .toContain('key: {{ $keyPrefix }}anthropic-api-key');
    const keyEnv = gatedBlock('templates/agents/litellm-deployment.yaml', '- name: ANTHROPIC_API_KEY');
    expect(keyEnv).toContain('key: anthropic-api-key');
    // Optional: under Recreate, a required key the secret lacks would keep the
    // new pod from starting with the old one already gone.
    expect(keyEnv).toContain('optional: true');
    ['templates/core/backend-deployment.yaml', 'templates/ops/ops-runner-deployment.yaml'].forEach((file) => {
      expect(gatedBlock(file, '- name: NATIVE_RUNTIME_MODEL'))
        .toContain('value: {{ .Values.aiProviders.anthropic.nativeModel | quote }}');
    });
  });
});
