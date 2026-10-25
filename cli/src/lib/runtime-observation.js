// Read only adapter-owned control arguments. Callers exclude prompt/stdin and
// provide every value-taking option, so a flag-shaped model/session value is
// never reinterpreted as a second option. Raw arguments never leave the runner.
export const controlsFromArguments = (args, { modelFlag, effortFlag, valueFlags = [], codex = false }) => {
  const controls = { model: null, effort: null };
  const flags = new Set([modelFlag, effortFlag, ...valueFlags].filter(Boolean));
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (!flags.has(flag)) continue;
    const value = args[++index];
    if (flag === modelFlag) controls.model = value || null;
    if (flag === effortFlag) controls.effort = value || null;
    if (codex && flag === '-c' && value?.startsWith('model_reasoning_effort=')) {
      try { controls.effort = JSON.parse(value.slice('model_reasoning_effort='.length)); } catch { /* unknown encoding */ }
    }
  }
  return controls;
};

// Called at the child's successful OS spawn event, not when a requested
// configuration is saved or when a turn is merely queued. Never send argv.
export const observeSpawn = (child, onSpawn, controls) => {
  if (typeof onSpawn !== 'function') return;
  child.once('spawn', () => {
    try { onSpawn({ model: controls.model || null, effort: controls.effort || null, at: new Date().toISOString() }); } catch { /* diagnostic only */ }
  });
};

export const createRuntimeReporter = ({ client, harness, detect }) => {
  let queue = Promise.resolve();
  const send = (body) => {
    // Serialize so a fast process cannot have its settled report overtake its
    // spawn report. Old backends and diagnostic outages don't stop a turn.
    queue = queue.then(() => client.post('/api/agents/runtime/observation', body)).catch(() => {});
    return queue;
  };
  return {
    async connect() {
      return send({ event: 'connected' });
    },
    spawn: ({ model, effort, at }) => {
      const receipt = { event: 'spawn', harness, version: null, model, effort, ...(at ? { at } : {}) };
      queue = queue.then(async () => {
        try { receipt.version = (await detect())?.version || null; } catch { /* unavailable */ }
        await client.post('/api/agents/runtime/observation', receipt);
      }).catch(() => {});
      return queue;
    },
    settled: (outcome = null) => send({ event: 'settled', ...(outcome ? { outcome } : {}) }),
  };
};
