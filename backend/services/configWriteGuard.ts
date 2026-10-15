/**
 * What a config write may not change on an installed agent
 * (security, 2026-10-15; found by Rhea reviewing #2224).
 *
 * PATCH /api/registry/pods/:podId/agents/:name lets an agent's installer
 * shallow-merge any `config` key. Three kinds of key are not theirs to write
 * there:
 *
 * - The runtime type. Install is where a runtime is chosen, and install is
 *   where the gates are: the cloudAgents entitlement for runtimes Commonly
 *   runs, and the per-user hosted cap. Changing the type afterwards walked
 *   past both: a self-serve webhook install could become `native` and run on
 *   Commonly's model account. Admins may still change it.
 * - What Commonly's compute does for an agent Commonly runs (native or
 *   hosted): its model, tools, prompt, caps and context size. Every new user
 *   is the installer of their own native Scout, so without this any user
 *   could pick a paid model route, add the approval-proposing tool, or set
 *   `dailyRunCap: 0` to lift the cap. Admins may still change them.
 * - The kernel's own records (`hosted`), which only the install and
 *   provision routes write. Refused for every caller, admins included: a
 *   hand-written engine or provision stamp is a record that no longer
 *   describes what happened.
 */

export const KERNEL_RUN_RUNTIME_TYPES: ReadonlySet<string> = new Set(['native', 'hosted']);

export const KERNEL_OWNED_CONFIG_KEYS: readonly string[] = ['hosted'];

/** What the native runtime reads to decide what a turn costs and can do. */
export const KERNEL_RUN_COMPUTE_KEYS: readonly string[] = [
  'model',
  'tools',
  'systemPrompt',
  'dailyRunCap',
  'recentMessages',
  'maxTurns',
  'maxTokens',
  'maxWallClockMs',
];

export interface ConfigWriteRefusal {
  code: 'kernel_owned_field' | 'runtime_type_change' | 'kernel_run_field';
  error: string;
  fields: string[];
}

const asObject = (value: unknown): Record<string, any> | null => {
  if (value instanceof Map) return Object.fromEntries(value);
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : null;
};

export const storedRuntimeType = (config: unknown): string => {
  const runtime = asObject(asObject(config)?.runtime);
  return String(runtime?.runtimeType || '').trim().toLowerCase();
};

/**
 * Why this write is refused, or null when it may proceed. `targets` are the
 * stored configs of every installation the write would reach.
 */
export const configWriteRefusal = ({
  requested,
  targets,
  isInstanceAdmin,
}: {
  requested: unknown;
  targets: unknown[];
  isInstanceAdmin: boolean;
}): ConfigWriteRefusal | null => {
  const body = asObject(requested);
  if (!body) return null;

  const owned = KERNEL_OWNED_CONFIG_KEYS.filter((key) => key in body);
  if (owned.length) {
    return {
      code: 'kernel_owned_field',
      error: 'Commonly writes this part of an agent\'s configuration itself; it cannot be set by a request.',
      fields: owned.map((key) => `config.${key}`),
    };
  }
  if (isInstanceAdmin) return null;

  const runtime = asObject(body.runtime);
  if (runtime && 'runtimeType' in runtime) {
    const requestedType = String(runtime.runtimeType ?? '').trim().toLowerCase();
    if (targets.some((target) => storedRuntimeType(target) !== requestedType)) {
      return {
        code: 'runtime_type_change',
        error: 'An agent\'s runtime cannot be changed here. Install the agent again with the runtime you want.',
        fields: ['config.runtime.runtimeType'],
      };
    }
  }

  const compute = KERNEL_RUN_COMPUTE_KEYS.filter((key) => key in body);
  if (compute.length && targets.some((target) => KERNEL_RUN_RUNTIME_TYPES.has(storedRuntimeType(target)))) {
    return {
      code: 'kernel_run_field',
      error: 'Commonly runs this agent, so Commonly sets its model, tools and limits.',
      fields: compute.map((key) => `config.${key}`),
    };
  }
  return null;
};

/**
 * The runtime block a write leaves behind. A request that sends `runtime`
 * without `runtimeType` (the Agents Hub sends only auth profiles and skill
 * env) keeps the stored type instead of erasing it.
 */
export const runtimeKeepingType = (
  requestedRuntime: Record<string, any>,
  existingConfig: unknown,
): Record<string, any> => {
  if ('runtimeType' in requestedRuntime) return requestedRuntime;
  const runtimeType = asObject(asObject(existingConfig)?.runtime)?.runtimeType;
  return runtimeType ? { ...requestedRuntime, runtimeType } : requestedRuntime;
};
