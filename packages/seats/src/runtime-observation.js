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
// The child rides along as a second argument so a supervisor can read its
// output as a liveness signal and kill it; a reporter reads only the first.
export const observeSpawn = (child, onSpawn, controls) => {
  if (typeof onSpawn !== 'function') return;
  child.once('spawn', () => {
    try { onSpawn({ model: controls.model || null, effort: controls.effort || null, at: new Date().toISOString() }, child); } catch { /* diagnostic only */ }
  });
};
