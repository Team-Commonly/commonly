const { anthropicAvailability, modelAvailability } = require('../../../services/modelAvailability');

describe('model availability', () => {
  const original = process.env.ANTHROPIC_MODELS_AVAILABLE;
  afterEach(() => {
    if (original === undefined) delete process.env.ANTHROPIC_MODELS_AVAILABLE;
    else process.env.ANTHROPIC_MODELS_AVAILABLE = original;
  });
  it('does not mistake a present key for an available route', () => {
    delete process.env.ANTHROPIC_MODELS_AVAILABLE;
    expect(anthropicAvailability().available).toBe(false);
  });
  it.each(['claude-opus-4-6', 'anthropic/claude-sonnet-4-6', 'openrouter/anthropic/claude-haiku-4-5'])('covers %s and restores it from the one flag', (model) => {
    process.env.ANTHROPIC_MODELS_AVAILABLE = 'false';
    expect(modelAvailability(model)).toEqual({ available: false, reason: 'Anthropic models are unavailable on this instance right now' });
    process.env.ANTHROPIC_MODELS_AVAILABLE = 'true';
    expect(modelAvailability(model)).toEqual({ available: true, reason: null });
  });
  it('leaves other instance models available', () => {
    process.env.ANTHROPIC_MODELS_AVAILABLE = 'false';
    expect(modelAvailability('google/gemini-2.5-flash')).toEqual({ available: true, reason: null });
  });
});
