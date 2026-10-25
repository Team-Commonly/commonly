import { requireSeatModel as requireDeclaredModel } from '@commonlyai/seats/seat-model';

/** Fleet runners opt in; BYO users retain their own CLI's model default. */
export const seatModelRequired = () => process.env.COMMONLY_REQUIRE_SEAT_MODEL === '1';

export const requireSeatModel = (environment, adapterName, required = seatModelRequired()) => (
  requireDeclaredModel(environment, adapterName, required)
);
