// We have no GPT model access, and LiteLLM serves the internal
// openai-codex/* and gpt-* aliases with DeepSeek V4 Flash. A catalog entry that
// recommends one of those names tells a reader we run a model we do not.
const fs = require('fs');
const path = require('path');
const { PRESET_DEFINITIONS } = require('../../../routes/registry/presets');

const GPT_NAME = /(^|\/)(gpt-|codex-mini|o4-mini)|^openai-codex\//;

describe('catalog model names', () => {
  it('no preset recommends a GPT or openai-codex model', () => {
    const offenders = PRESET_DEFINITIONS
      .filter((p) => typeof p.recommendedModel === 'string' && GPT_NAME.test(p.recommendedModel))
      .map((p) => `${p.id}: ${p.recommendedModel}`);
    expect(offenders).toEqual([]);
  });

  // F98 (D243, Cofounder 11-04): hosted agents are Claude-only, and the catalog
  // offers Haiku only (Sonnet comes later, under a cap). Legacy pins still run:
  // nativeModelFor maps them server-side. These fields are what the catalog says.
  const HOSTED_MODEL = 'claude-haiku-5-5';

  it('every preset that recommends a model recommends the hosted model', () => {
    const offenders = PRESET_DEFINITIONS
      .filter((p) => p.recommendedModel !== undefined && p.recommendedModel !== HOSTED_MODEL)
      .map((p) => `${p.id}: ${p.recommendedModel}`);
    expect(offenders).toEqual([]);
  });

  // F98 review: preset readiness checks each apiRequirement against the
  // backend's env, so a stale Gemini "Default model provider" made a preset whose
  // model is Claude (served through LiteLLM, whose key the backend never holds)
  // read as not ready wherever Gemini is off.
  it('no preset requires a model-provider key for its default model', () => {
    const offenders = PRESET_DEFINITIONS.flatMap((p) => (p.apiRequirements || [])
      .filter((r) => /model provider/i.test(r.purpose || ''))
      .map((r) => `${p.id}: ${r.key}`));
    expect(offenders).toEqual([]);
  });

  it('every published manifest supports and recommends only the hosted model', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../../routes/registry/publish.ts'), 'utf8');
    const blocks = [...src.matchAll(/models:\s*\{[\s\S]*?supported:\s*\[([^\]]*)\][\s\S]*?recommended:\s*'([^']*)'/g)];
    expect(blocks.length).toBeGreaterThanOrEqual(2);
    blocks.forEach(([, supported, recommended]) => {
      expect([...supported.matchAll(/'([^']+)'/g)].map((m) => m[1])).toEqual([HOSTED_MODEL]);
      expect(recommended).toBe(HOSTED_MODEL);
    });
  });

  it('the published openclaw manifest lists no GPT or openai-codex model', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../../routes/registry/publish.ts'), 'utf8');
    const models = src.match(/name: 'openclaw',[\s\S]*?models:\s*\{[\s\S]*?supported:\s*\[([^\]]*)\][\s\S]*?recommended:\s*'([^']*)'/);
    expect(models).not.toBeNull();
    const names = [...models[1].matchAll(/'([^']+)'/g)].map((m) => m[1]).concat(models[2]);
    expect(names.filter((n) => GPT_NAME.test(n))).toEqual([]);
  });
});
