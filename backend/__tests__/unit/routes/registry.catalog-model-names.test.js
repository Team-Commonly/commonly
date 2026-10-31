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

  it('the published openclaw manifest lists no GPT or openai-codex model', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../../routes/registry/publish.ts'), 'utf8');
    const models = src.match(/name: 'openclaw',[\s\S]*?models:\s*\{[\s\S]*?supported:\s*\[([^\]]*)\][\s\S]*?recommended:\s*'([^']*)'/);
    expect(models).not.toBeNull();
    const names = [...models[1].matchAll(/'([^']+)'/g)].map((m) => m[1]).concat(models[2]);
    expect(names.filter((n) => GPT_NAME.test(n))).toEqual([]);
  });
});
