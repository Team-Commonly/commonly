// Probe only the walked adapter's version command. Never enumerate workspace
// extensions to discover models: a model picker must not execute project code.
export const WALKED_HARNESSES = ['claude', 'codex', 'opencode', 'hermes', 'dsh'];
export const collectRuntimeInventory = async (getAdapter, capabilities, harnesses = WALKED_HARNESSES) => Promise.all(harnesses.map(async (harness) => {
  const adapter = getAdapter(harness);
  let detected = null;
  try { detected = await adapter?.detect(); } catch { /* unavailable */ }
  let choices = { models: null, efforts: [] };
  if (detected) { try { choices = (await (capabilities ? capabilities(harness) : adapter?.inventory?.())) || choices; } catch { /* unavailable */ } }
  return { harness, installed: Boolean(detected), version: detected?.version || null,
    models: choices.models, efforts: choices.efforts };
}));

// The daemon's inventory, refreshed in full every five minutes. A harness it
// didn't find is probed again sooner, so one installed while the BYO page is
// open shows up within a heartbeat or two, without a reload (F370 #8).
export const INVENTORY_FULL_MS = 300_000;
export const INVENTORY_MISSING_MS = 25_000;
export const createInventoryCache = (collect, { now = Date.now } = {}) => {
  let cached;
  let fullAt = 0;
  let missingAt = 0;
  return async () => {
    const at = now();
    if (!cached || at - fullAt > INVENTORY_FULL_MS) {
      cached = await collect(WALKED_HARNESSES);
      fullAt = at;
      missingAt = at;
      return cached;
    }
    const missing = cached.filter((row) => !row.installed).map((row) => row.harness);
    if (missing.length && at - missingAt > INVENTORY_MISSING_MS) {
      missingAt = at;
      const fresh = await collect(missing);
      cached = cached.map((row) => fresh.find((next) => next.harness === row.harness) || row);
    }
    return cached;
  };
};
