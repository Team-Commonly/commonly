/** Fleet runners opt in; BYO users retain their own CLI's model default. */
export const seatModelRequired = () => process.env.COMMONLY_REQUIRE_SEAT_MODEL === '1';

export const requireSeatModel = (environment, adapterName, required = seatModelRequired()) => {
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
