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
// `if` it closes. A line in that `if`'s `else` branch reports as `else of <if>`,
// so an upstream moved into the provider-off branch fails.
const gateAbove = (i) => {
  let depth = 0;
  let inElse = false;
  for (let j = i - 1; j >= 0; j -= 1) {
    const t = lines[j].trim();
    if (/^\{\{-? end/.test(t)) depth += 1;
    else if (/^\{\{-? else/.test(t)) { if (depth === 0) inElse = true; }
    else if (/^\{\{-? (if|range|with) /.test(t)) {
      if (depth === 0) return inElse ? `else of ${t}` : t;
      depth -= 1;
    }
  }
  return null;
};
// Quoted or not, and Vertex as well as the Gemini API: any of these reaches Google.
const upstreamLines = (re) => lines
  .map((l, i) => ({ l: l.trim(), i }))
  .filter(({ l }) => re.test(l));
const GOOGLE = /^model:\s*["']?(gemini|vertex_ai|vertex_ai_beta)\//;
const OPENAI = /^model:\s*["']?(openai|azure)\//;

describe('LiteLLM routes no request to a provider that is switched off', () => {
  test('OpenAI is off on dev and on by default; Gemini as F78 left it', () => {
    expect(dev.aiProviders.openai.enabled).toBe(false);
    expect(base.aiProviders.openai.enabled).toBe(true);
    expect(dev.aiProviders.gemini.enabled).toBe(false);
  });

  test('every Gemini upstream sits under the Gemini gate', () => {
    const found = upstreamLines(GOOGLE);
    expect(found.length).toBeGreaterThanOrEqual(4);
    found.forEach(({ i }) => expect(gateAbove(i)).toBe('{{- if .Values.aiProviders.gemini.enabled }}'));
  });

  test('every OpenAI upstream sits under the OpenAI gate', () => {
    const found = upstreamLines(OPENAI);
    expect(found.length).toBeGreaterThanOrEqual(4);
    found.forEach(({ i }) => expect(gateAbove(i)).toBe('{{- if .Values.aiProviders.openai.enabled }}'));
  });

});

// F98 (D243, Cofounder 11-04): hosted agents are Claude-only, and a name that
// answers with another vendor's model gives its caller that model with no
// signal. The 7-day spend log to 11-04 showed no call to any of these names,
// so each is gone or exists only where its own provider is on: a caller now
// gets an unknown-model error instead of a silent stand-in.
const entries = () => lines.map((l, i) => ({ l: l.trim(), i }))
  .filter(({ l }) => l.startsWith('- model_name:'))
  .map(({ l, i }) => ({ name: l.replace('- model_name:', '').trim(), i }));
const blockOf = (at) => {
  const next = lines.findIndex((l, k) => k > at && /^\s*- model_name:|^\s*router_settings:/.test(l));
  return lines.slice(at + 1, next === -1 ? undefined : next).join('\n');
};

describe('no other vendor\'s name is served by DeepSeek', () => {
  test('every entry that reaches DeepSeek is named for DeepSeek', () => {
    const offenders = entries()
      .filter(({ i }) => /model:\s*deepseek\//.test(blockOf(i)))
      .map(({ name }) => name)
      .filter((name) => !name.startsWith('deepseek-'));
    expect(offenders).toEqual([]);
  });

  test.each([
    'openrouter/nvidia/nemotron-3-super-120b-a12b:free', 'nvidia/nemotron-3-super-120b-a12b:free',
    'gpt-5.4', 'openai-codex/gpt-5.4', 'gpt-5.4-mini', 'openai-codex/gpt-5.4-mini', 'gpt-5.4-nano',
    'openai-codex/gpt-5.4-nano', 'codex-mini-latest', 'o4-mini', 'codex-cli/gpt-5.4',
  ])('%s is gone, and no fallback names it', (name) => {
    expect(entries().map((entry) => entry.name)).not.toContain(name);
    expect(lines.some((l) => l.includes(`"${name}"`))).toBe(false);
  });

  test.each([
    ['gemini-2.5-flash', 'gemini'], ['google/gemini-2.5-flash', 'gemini'], ['google/gemini-2.5-flash-lite', 'gemini'],
    ['google/gemini-2.0-flash', 'gemini'], ['gpt-4o', 'openai'],
  ])('%s exists only where %s is on', (name, provider) => {
    const at = lines.findIndex((l) => l.trim() === `- model_name: ${name}`);
    expect(at).toBeGreaterThan(-1);
    expect(gateAbove(at)).toBe(`{{- if .Values.aiProviders.${provider}.enabled }}`);
    expect(blockOf(at)).not.toMatch(/deepseek/);
  });

  test('a Gemini fallback exists only where Gemini is on', () => {
    lines.forEach((l, i) => {
      if (/^\s*- \{"(gemini-|google\/)/.test(l)) expect(gateAbove(i)).toBe('{{- if .Values.aiProviders.gemini.enabled }}');
    });
  });
});
