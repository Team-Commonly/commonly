/**
 * The model a seat runs on is a declared field (`environment.model`), never a
 * CLI default the operator did not choose. Whether a missing model is an error
 * is the host's policy, passed as `required`.
 */
export const requireSeatModel = (environment, adapterName, required = false) => {
  const model = environment?.model;
  if (typeof model !== 'string' || !model.trim()) {
    if (!required) return undefined;
    const error = new Error(
      `${adapterName} requires environment.model; set the seat model with commonly agent config <name> --model <model> before running`,
    );
    error.code = 'seat_model_missing';
    throw error;
  }
  return model.trim();
};
