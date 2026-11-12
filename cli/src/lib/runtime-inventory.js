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
// Probes are synchronous: a binary that isn't there fails at once, but one
// that's there and hangs on --version blocks the daemon for its timeout. A
// re-probe slower than INVENTORY_SLOW_MS waits for the full refresh instead.
export const INVENTORY_FULL_MS = 300_000;
export const INVENTORY_MISSING_MS = 25_000;
export const INVENTORY_SLOW_MS = 1_000;
export const createInventoryCache = (collect, { now = Date.now } = {}) => {
  let cached;
  let fullAt = 0;
  let missingAt = 0;
  let slow = new Set();
  return async () => {
    const at = now();
    if (!cached || at - fullAt > INVENTORY_FULL_MS) {
      cached = await collect(WALKED_HARNESSES);
      fullAt = at;
      missingAt = at;
      slow = new Set();
      return cached;
    }
    const missing = cached.filter((row) => !row.installed && !slow.has(row.harness)).map((row) => row.harness);
    if (missing.length && at - missingAt > INVENTORY_MISSING_MS) {
      missingAt = at;
      for (const harness of missing) {
        const started = now();
        const [fresh] = await collect([harness]);
        if (now() - started > INVENTORY_SLOW_MS) slow.add(harness);
        if (fresh) cached = cached.map((row) => (row.harness === harness ? fresh : row));
      }
    }
    return cached;
  };
};
