const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const template = fs.readFileSync(path.join(__dirname,
  '../../../../k8s/helm/commonly/templates/configmaps/litellm-config.yaml'), 'utf8');
// Parse the actual proxy config, not comments or the surrounding Helm template.
const block = template.split('  config.yaml: |\n')[1].split('\n  # Mounted at /app/')[0];
const config = yaml.load(block.replace(/^    /gm, ''));

test('the hosted DeepSeek default has no fallback to another model or vendor', () => {
  expect(config.model_list.find((entry) => entry.model_name === 'deepseek-v4-flash')
    .litellm_params.model).toBe('deepseek/deepseek-v4-flash');
  const chains = config.router_settings.fallbacks.flatMap((chain) =>
    Object.entries(chain).filter(([model]) => model === 'deepseek-v4-flash' || model === '*'));
  expect(chains.flatMap(([, targets]) => targets)).toEqual([]);
  expect(config.router_settings.default_fallbacks || []).toEqual([]);
});

test('Workers AI is not a registered route or a fallback destination', () => {
  expect(config.model_list.some((entry) =>
    /cloudflare|@cf\//i.test(`${entry.model_name} ${entry.litellm_params.model}`))).toBe(false);
  for (const chains of ['fallbacks', 'content_policy_fallbacks', 'context_window_fallbacks']) {
    const targets = (config.router_settings[chains] || []).flatMap((chain) => Object.values(chain).flat());
    expect(targets.some((target) => /cloudflare|@cf\//i.test(target))).toBe(false);
  }
});
