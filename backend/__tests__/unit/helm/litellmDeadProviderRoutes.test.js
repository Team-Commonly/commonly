const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

// F85 (F78 follow-up), 2026-11-04: Google rejects the Gemini key and the OpenAI
// key is a placeholder, but LiteLLM still sent each Gemini-named request to
// Google first and fell back to DeepSeek only after the 401, so the prompt left
// every time. With a provider off, its names are served by DeepSeek directly
// (chat) or not routed at all (embeddings, images). The backend jest job has no
// helm binary, so this reads the template text; Chart Lint renders it.
const chart = path.join(__dirname, '../../../../k8s/helm/commonly');
const read = (f) => fs.readFileSync(path.join(chart, f), 'utf8');
const dev = yaml.load(read('values-dev.yaml'), { json: true });
const base = yaml.load(read('values.yaml'), { json: true });
const lines = read('templates/configmaps/litellm-config.yaml').split('\n');

// The innermost open `if` around a line: walk up, pairing each `end` with the
// `if` it closes, skipping an `else` inside a pair we are not in.
const gateAbove = (i) => {
  let depth = 0;
  for (let j = i - 1; j >= 0; j -= 1) {
    const t = lines[j].trim();
    if (/^\{\{-? end/.test(t)) depth += 1;
    else if (/^\{\{-? (if|range|with) /.test(t)) {
      if (depth === 0) return t;
      depth -= 1;
    }
  }
  return null;
};
const upstreamLines = (prefix) => lines
  .map((l, i) => ({ l: l.trim(), i }))
  .filter(({ l }) => l.startsWith(`model: ${prefix}`));

describe('LiteLLM routes no request to a provider that is switched off', () => {
  test('OpenAI is off on dev and on by default; Gemini as F78 left it', () => {
    expect(dev.aiProviders.openai.enabled).toBe(false);
    expect(base.aiProviders.openai.enabled).toBe(true);
    expect(dev.aiProviders.gemini.enabled).toBe(false);
  });

  test('every Gemini upstream sits under the Gemini gate', () => {
    const found = upstreamLines('gemini/');
    expect(found.length).toBeGreaterThanOrEqual(4);
    found.forEach(({ i }) => expect(gateAbove(i)).toBe('{{- if .Values.aiProviders.gemini.enabled }}'));
  });

  test('every OpenAI upstream sits under the OpenAI gate', () => {
    const found = upstreamLines('openai/');
    expect(found.length).toBeGreaterThanOrEqual(4);
    found.forEach(({ i }) => expect(gateAbove(i)).toBe('{{- if .Values.aiProviders.openai.enabled }}'));
  });

  test.each(['gemini-2.5-flash', 'google/gemini-2.5-flash', 'google/gemini-2.5-flash-lite', 'google/gemini-2.0-flash', 'gpt-4o'])(
    '%s keeps its name and is served by DeepSeek when its provider is off',
    (name) => {
      const at = lines.findIndex((l) => l.trim() === `- model_name: ${name}`);
      expect(at).toBeGreaterThan(-1);
      const block = lines.slice(at + 1, lines.findIndex((l, k) => k > at && l.trim().startsWith('- model_name:'))).join('\n');
      expect(block).toMatch(/\{\{- else \}\}\s*\n\s*model: deepseek\/deepseek-v4-flash\s*\n\s*api_key: os\.environ\/DEEPSEEK_API_KEY/);
    },
  );
});
