const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { HELM_CHART } = require('../../utils/repoRoot');

const template = fs.readFileSync(path.join(HELM_CHART,
  'templates/configmaps/litellm-config.yaml'), 'utf8');
// Parse the actual proxy config, not comments or the surrounding Helm template.
// Lines that are only a Helm directive (the aiProviders and legacyAliases gates)
// are dropped. A gated pair (`if … else … end`) would leave two copies of a key,
// and json: true keeps only the last, so a check on that key would read one
// branch only: on 11-04 it read `fallbacks: []` and passed whatever the real
// list said. So the config is parsed twice, once with every `else` branch
// dropped (the gate-on side) and once keeping the last copy (the gate-off side,
// the branch dev renders), and every check runs on both.
const block = template.split('  config.yaml: |\n')[1].split('\n  # Mounted at /app/')[0];
const DIRECTIVE = /^\s*\{\{-?[^}]*\}\}\s*$/;
const dropElseBranches = (lines) => {
  const out = [];
  const skipping = [];
  lines.forEach((l) => {
    const t = l.trim();
    if (/^\{\{-? (if|range|with) /.test(t)) skipping.push(false);
    else if (/^\{\{-? else/.test(t)) skipping[skipping.length - 1] = true;
    else if (/^\{\{-? end/.test(t)) skipping.pop();
    else if (!skipping.some(Boolean)) out.push(l);
  });
  return out;
};
const parse = (lines) => yaml.load(lines.filter((l) => !DIRECTIVE.test(l)).join('\n')
  .replace(/^    /gm, ''), { json: true });
const configs = [
  ['gate-on branches', parse(dropElseBranches(block.split('\n')))],
  ['gate-off branches', parse(block.split('\n'))],
];

test('both parses see the real fallback list, not only the empty branch', () => {
  expect(configs[0][1].router_settings.fallbacks.length).toBeGreaterThan(0);
  expect(configs[1][1].router_settings.fallbacks).toEqual([]);
});

test.each(configs)('the hosted DeepSeek default has no fallback to another model or vendor (%s)', (_, config) => {
  expect(config.model_list.find((entry) => entry.model_name === 'deepseek-v4-flash')
    .litellm_params.model).toBe('deepseek/deepseek-v4-flash');
  const chains = config.router_settings.fallbacks.flatMap((chain) =>
    Object.entries(chain).filter(([model]) => model === 'deepseek-v4-flash' || model === '*'));
  expect(chains.flatMap(([, targets]) => targets)).toEqual([]);
  expect(config.router_settings.default_fallbacks || []).toEqual([]);
});

test.each(configs)('Workers AI is not a registered route or a fallback destination (%s)', (_, config) => {
  expect(config.model_list.some((entry) =>
    /cloudflare|@cf\//i.test(`${entry.model_name} ${entry.litellm_params.model}`))).toBe(false);
  for (const chains of ['fallbacks', 'content_policy_fallbacks', 'context_window_fallbacks']) {
    const targets = (config.router_settings[chains] || []).flatMap((chain) => Object.values(chain).flat());
    expect(targets.some((target) => /cloudflare|@cf\//i.test(target))).toBe(false);
  }
});
