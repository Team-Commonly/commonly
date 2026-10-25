// A configured key can still be rejected upstream. Operators restore this flag
// only after verifying the instance route; key presence is not availability.
export const anthropicAvailability = () => {
  const available = process.env.ANTHROPIC_MODELS_AVAILABLE === 'true';
  return {
    available,
    reason: available ? null : 'Anthropic models are unavailable on this instance right now',
  };
};

export const modelAvailability = (model: unknown) => (
  /(^|\/)claude-/i.test(String(model || ''))
    ? anthropicAvailability()
    : { available: true, reason: null }
);
