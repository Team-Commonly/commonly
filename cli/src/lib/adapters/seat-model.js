/** A seat must choose its model independently of the operator's CLI defaults. */
export const requireSeatModel = (environment, adapterName) => {
  const model = environment?.model;
  if (typeof model !== 'string' || !model.trim()) {
    throw new Error(
      `${adapterName} requires environment.model; set the seat model with commonly agent config <name> --model <model> before running`,
    );
  }
  return model.trim();
};
