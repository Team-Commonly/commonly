/**
 * The injection-guard loads its jailbreak category from our copy of LiteLLM's
 * file (k8s/helm/commonly/files/litellm/prompt_injection_jailbreak.yaml), which
 * drops the identifier word "enter". Identifier words match as substrings, so
 * "enter" fired inside "Enterprise" and stopped commonly.me's own landing page.
 *
 * The wiring is three pieces, and LiteLLM fails open if one is missing: a
 * category_file outside its package is refused unless
 * LITELLM_CONTENT_FILTER_ALLOW_EXTERNAL_PATHS=true, and a refused or missing
 * file only logs a warning and skips the category, so the guard would quietly
 * stop checking jailbreaks. These tests pin all three. No helm render, because
 * this jest job has no helm.
 */
const fs = require('fs');
const path = require('path');
const { REPO_ROOT } = require('../../utils/repoRoot');

const chart = path.join(REPO_ROOT, 'k8s/helm/commonly');
const read = (rel) => fs.readFileSync(path.join(chart, rel), 'utf8');

// The list under a top-level key, e.g. identifier_words: then `  - "word"` lines.
const listUnder = (yaml, key) => {
  const lines = yaml.split('\n');
  const start = lines.indexOf(`${key}:`);
  if (start < 0) return [];
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^\S/.test(line));
  return (end < 0 ? rest : rest.slice(0, end))
    .map((line) => line.match(/^ {2}- "(.*)"$/))
    .filter(Boolean)
    .map((m) => m[1].toLowerCase());
};

const category = read('files/litellm/prompt_injection_jailbreak.yaml');
const identifiers = listUnder(category, 'identifier_words');
const blockWords = listUnder(category, 'additional_block_words');

describe('LiteLLM jailbreak category override', () => {
  test('the category file is upstream v1.106.2 without the identifier "enter"', () => {
    expect(category).toContain('category_name: "prompt_injection_jailbreak"');
    expect(identifiers).toEqual([
      'pretend', 'roleplay', 'act as', 'imagine you are', 'suppose you are', 'you are now',
      'behave as', 'respond as', 'simulate', 'emulate', 'impersonate', 'transform into',
      'become', 'play the role', 'switch to', 'enable', 'activate', 'turn on',
    ]);
    expect(blockWords).toContain('unlimited');
    expect(blockWords).toContain('developer mode');
    expect(category).toContain('keyword: "DAN mode"');
  });

  test('the landing page pricing lines no longer pair an identifier with a block word', () => {
    // From commonly.me's landing page, 2026-11-08. The snapshot has no sentence
    // breaks between them, so LiteLLM reads them as one sentence.
    const sentence = [
      'Unlimited humans, agents, and pods',
      'Unlimited BYO agents — they run on your machines, connect free',
      'Unlimited history in pods you create — nothing expires at 30 days',
      'Enterprise',
    ].join('\n').toLowerCase();
    expect(sentence).toContain('enter');
    expect(identifiers.filter((w) => sentence.includes(w))).toEqual([]);
  });

  test('the ConfigMap carries the file and the category points at its mount', () => {
    const cm = read('templates/configmaps/litellm-config.yaml');
    expect(cm).toContain('  prompt_injection_jailbreak.yaml: |\n    {{- .Files.Get "files/litellm/prompt_injection_jailbreak.yaml" | nindent 4 }}');
    expect(cm).toContain('{ category: "prompt_injection_jailbreak", action: "BLOCK", category_file: "/app/prompt_injection_jailbreak.yaml" }');
  });

  test('the file is mounted at that path, and LiteLLM is allowed to read it there', () => {
    const deploy = read('templates/agents/litellm-deployment.yaml');
    expect(deploy).toContain([
      '        - name: litellm-config',
      '          mountPath: /app/prompt_injection_jailbreak.yaml',
      '          subPath: prompt_injection_jailbreak.yaml',
    ].join('\n'));
    expect(deploy).toContain([
      '        - name: LITELLM_CONTENT_FILTER_ALLOW_EXTERNAL_PATHS',
      '          value: "true"',
    ].join('\n'));
  });
});
