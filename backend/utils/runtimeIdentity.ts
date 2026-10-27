/**
 * A seat's runtime identity on one install: the four keys that say what runs
 * it, moving as one group (TASK-569). Null when the install declares no type,
 * adapter or wrapped CLI, i.e. a projection written without its runtime.
 */
export const RUNTIME_IDENTITY_KEYS = ['runtimeType', 'host', 'adapter', 'wrappedCli'];

export const declaredRuntimeIdentity = (config: unknown): Record<string, unknown> | null => {
  const map = config instanceof Map ? Object.fromEntries(config) : config as Record<string, any> | null;
  const runtime = map?.runtime;
  if (!runtime || typeof runtime !== 'object') return null;
  if (!runtime.runtimeType && !runtime.adapter && !runtime.wrappedCli) return null;
  return Object.fromEntries(RUNTIME_IDENTITY_KEYS
    .filter((key) => runtime[key] !== undefined && runtime[key] !== null && runtime[key] !== '')
    .map((key) => [key, runtime[key]]));
};
