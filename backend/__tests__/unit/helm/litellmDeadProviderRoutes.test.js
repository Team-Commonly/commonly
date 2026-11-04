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
// signal. The 7-day spend log to 11-04 showed no call to any of these names on
// dev, so dev (litellm.legacyAliases false) renders none of them: a caller gets
// an unknown-model error instead of a silent stand-in. The chart's own driver
// defaults still name them on installs we can't measure, so base keeps today's
// stand-ins behind the flag until F103 moves those defaults (CTO ruling 11-04).
const entries = () => lines.map((l, i) => ({ l: l.trim(), i }))
  .filter(({ l }) => l.startsWith('- model_name:'))
  .map(({ l, i }) => ({ name: l.replace('- model_name:', '').trim(), i }));
const blockOf = (at) => {
  const next = lines.findIndex((l, k) => k > at && /^\s*- model_name:|^\s*router_settings:|^\s*\{\{-? (if|end|else)/.test(l));
  return lines.slice(at + 1, next === -1 ? undefined : next).join('\n');
};
const LEGACY = '{{- if .Values.litellm.legacyAliases }}';
const standInGate = (provider) => `{{- if and (not .Values.aiProviders.${provider}.enabled) .Values.litellm.legacyAliases }}`;
const LEGACY_NAMES = [
  'openrouter/nvidia/nemotron-3-super-120b-a12b:free', 'nvidia/nemotron-3-super-120b-a12b:free',
  'gpt-5.4', 'openai-codex/gpt-5.4', 'gpt-5.4-mini', 'openai-codex/gpt-5.4-mini', 'gpt-5.4-nano',
  'openai-codex/gpt-5.4-nano', 'codex-mini-latest', 'o4-mini', 'codex-cli/gpt-5.4',
];

describe('no other vendor\'s name is served by DeepSeek unless legacyAliases is on', () => {
  test('dev renders no legacy alias; base keeps them until F103', () => {
    expect(dev.litellm.legacyAliases).toBe(false);
    expect(base.litellm.legacyAliases).toBe(true);
  });

  test('every entry that reaches DeepSeek under another name sits under the legacyAliases flag', () => {
    const standIns = entries()
      .filter(({ i }) => /model:\s*deepseek\//.test(blockOf(i)))
      .filter(({ name }) => !name.startsWith('deepseek-'));
    expect(standIns.length).toBeGreaterThanOrEqual(LEGACY_NAMES.length);
    // The flag itself, or a provider-off gate ANDed with it; never `not` the flag.
    const gate = /^\{\{- if (and \(not \.Values\.aiProviders\.\w+\.enabled\) )?\.Values\.litellm\.legacyAliases \}\}$/;
    standIns.forEach(({ name, i }) => expect([name, gateAbove(i)]).toEqual([name, expect.stringMatching(gate)]));
  });

  test.each(LEGACY_NAMES)('%s exists, and is a fallback, only under the legacyAliases flag', (name) => {
    const found = entries().filter((entry) => entry.name === name);
    expect(found).toHaveLength(1);
    expect(gateAbove(found[0].i)).toBe(LEGACY);
    lines.forEach((l, i) => {
      if (l.includes(`"${name}"`)) expect(gateAbove(i)).toBe(LEGACY);
    });
  });

  test.each([
    ['gemini-2.5-flash', 'gemini'], ['google/gemini-2.5-flash', 'gemini'], ['google/gemini-2.5-flash-lite', 'gemini'],
    ['google/gemini-2.0-flash', 'gemini'], ['gpt-4o', 'openai'],
  ])('%s is served by %s where it is on, and by a stand-in only under the legacyAliases flag', (name, provider) => {
    const found = entries().filter((entry) => entry.name === name);
    expect(found).toHaveLength(2);
    const [real, standIn] = found;
    expect(gateAbove(real.i)).toBe(`{{- if .Values.aiProviders.${provider}.enabled }}`);
    expect(blockOf(real.i)).not.toMatch(/deepseek/);
    expect(gateAbove(standIn.i)).toBe(standInGate(provider));
    expect(blockOf(standIn.i)).toMatch(/model:\s*deepseek\/deepseek-v4-flash/);
  });

  test('a Gemini fallback renders where Gemini is on or legacyAliases is; a nemotron one only under the flag', () => {
    const gemini = [];
    const nemotron = [];
    lines.forEach((l, i) => {
      if (/^\s*- \{"(gemini-|google\/)/.test(l)) gemini.push(gateAbove(i));
      if (/^\s*- \{"(openrouter\/)?nvidia\//.test(l)) nemotron.push(gateAbove(i));
    });
    expect(gemini).toEqual(Array(4).fill('{{- if or .Values.aiProviders.gemini.enabled .Values.litellm.legacyAliases }}'));
    expect(nemotron).toEqual(Array(2).fill(LEGACY));
  });
});
