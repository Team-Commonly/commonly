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
// defaults still named them on installs we can't measure, so base kept the
// stand-ins behind the flag (CTO ruling 11-04). F103 moved those defaults to
// litellm.agentDefaultModel and deleted the names outright; the flag now gates
// only the Gemini/gpt-4o stand-ins, until F105.
const entries = () => lines.map((l, i) => ({ l: l.trim(), i }))
  .filter(({ l }) => l.startsWith('- model_name:'))
  .map(({ l, i }) => ({ name: l.replace('- model_name:', '').trim(), i }));
const blockOf = (at) => {
  const next = lines.findIndex((l, k) => k > at && /^\s*- model_name:|^\s*router_settings:|^\s*\{\{-? (if|end|else)/.test(l));
  return lines.slice(at + 1, next === -1 ? undefined : next).join('\n');
};
// F159: and only where DeepSeek, the stand-in's upstream, renders.
const standInGate = (provider) => `{{- if and (not .Values.aiProviders.${provider}.enabled) .Values.litellm.legacyAliases .Values.aiProviders.deepseek.enabled }}`;
const LEGACY_NAMES = [
  'openrouter/nvidia/nemotron-3-super-120b-a12b:free', 'nvidia/nemotron-3-super-120b-a12b:free',
  'gpt-5.4', 'openai-codex/gpt-5.4', 'gpt-5.4-mini', 'openai-codex/gpt-5.4-mini', 'gpt-5.4-nano',
  'openai-codex/gpt-5.4-nano', 'codex-mini-latest', 'o4-mini', 'codex-cli/gpt-5.4',
];

describe('no other vendor\'s name is served by DeepSeek unless legacyAliases is on', () => {
  test('dev renders no stand-in; base keeps the Gemini/gpt-4o ones until F105', () => {
    expect(dev.litellm.legacyAliases).toBe(false);
    expect(base.litellm.legacyAliases).toBe(true);
  });

  test('every entry that reaches DeepSeek under another name sits under the legacyAliases flag', () => {
    const standIns = entries()
      .filter(({ i }) => /model:\s*deepseek\//.test(blockOf(i)))
      .filter(({ name }) => !name.startsWith('deepseek-'));
    expect(standIns.map(({ name }) => name).sort()).toEqual(
      ['gemini-2.5-flash', 'google/gemini-2.0-flash', 'google/gemini-2.5-flash', 'google/gemini-2.5-flash-lite', 'gpt-4o'],
    );
    // A provider-off gate ANDed with the flag; never `not` the flag.
    const gate = /^\{\{- if and \(not \.Values\.aiProviders\.\w+\.enabled\) \.Values\.litellm\.legacyAliases \.Values\.aiProviders\.deepseek\.enabled \}\}$/;
    standIns.forEach(({ name, i }) => expect([name, gateAbove(i)]).toEqual([name, expect.stringMatching(gate)]));
  });

  // F103: these names are gone in every render, flag or not, as routes and as
  // fallbacks.
  test.each(LEGACY_NAMES)('%s is neither a route nor a fallback', (name) => {
    expect(entries().filter((entry) => entry.name === name)).toEqual([]);
    expect(lines.filter((l) => l.includes(`"${name}"`))).toEqual([]);
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

  test('a Gemini fallback renders where DeepSeek is on and Gemini or legacyAliases is, and no other fallback is listed', () => {
    const gemini = [];
    const other = [];
    lines.forEach((l, i) => {
      if (/^\s*- \{"(gemini-|google\/)/.test(l)) gemini.push(gateAbove(i));
      else if (/^\s*- \{"[^"]+":\s*\[/.test(l)) other.push(l.trim());
    });
    expect(gemini).toEqual(Array(4).fill('{{- if and .Values.aiProviders.deepseek.enabled (or .Values.aiProviders.gemini.enabled .Values.litellm.legacyAliases) }}'));
    expect(other).toEqual([]);
  });
});
