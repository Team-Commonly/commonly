// Probe only the walked adapter's version command. Never enumerate workspace
// extensions to discover models: a model picker must not execute project code.
export const WALKED_HARNESSES = ['claude', 'codex', 'opencode', 'hermes', 'dsh'];
export const collectRuntimeInventory = async (getAdapter, capabilities) => Promise.all(WALKED_HARNESSES.map(async (harness) => {
  const adapter = getAdapter(harness);
  let detected = null;
  try { detected = await adapter?.detect(); } catch { /* unavailable */ }
  let choices = { models: null, efforts: [] };
  if (detected) { try { choices = (await (capabilities ? capabilities(harness) : adapter?.inventory?.())) || choices; } catch { /* unavailable */ } }
  return { harness, installed: Boolean(detected), version: detected?.version || null,
    models: choices.models, efforts: choices.efforts };
}));
