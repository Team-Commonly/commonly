// The mark on Installable rows the AgentRegistry bridge synthesized. Its own
// module so routes can read it without loading (or a test mock of) the model.
export const REGISTRY_BACKFILL_ORIGIN = 'registry-backfill';
export type InstallableOrigin = typeof REGISTRY_BACKFILL_ORIGIN;
