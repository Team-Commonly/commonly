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
  code: 'invalid_config' | 'kernel_owned_field' | 'runtime_type_change' | 'kernel_run_field';
  /** HTTP status: 400 for a malformed body, 403 for a write this caller may not make. */
  status: 400 | 403;
  error: string;
  fields: string[];
}

const asObject = (value: unknown): Record<string, any> | null => {
  if (value instanceof Map) return Object.fromEntries(value);
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : null;
};

const normalizeRuntimeType = (value: unknown): string => String(value ?? '').trim().toLowerCase();

export const storedRuntimeType = (config: unknown): string => {
  const runtime = asObject(asObject(config)?.runtime);
  return normalizeRuntimeType(runtime?.runtimeType);
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
  if (requested === undefined || requested === null) return null;
  const body = asObject(requested);
  // A shallow merge spreads whatever it is given: a string becomes indexed
  // keys, and `runtime: null` erases the stored runtime and with it the type
  // every rule below reads (Rhea on #2229). Neither shape is a valid write.
  if (!body) {
    return {
      code: 'invalid_config', status: 400, error: 'config must be an object.', fields: ['config'],
    };
  }
  if ('runtime' in body && !asObject(body.runtime)) {
    return {
      code: 'invalid_config', status: 400, error: 'config.runtime must be an object.', fields: ['config.runtime'],
    };
  }

  const owned = KERNEL_OWNED_CONFIG_KEYS.filter((key) => key in body);
  if (owned.length) {
    return {
      code: 'kernel_owned_field',
      status: 403,
      error: 'Commonly writes this part of an agent\'s configuration itself; it cannot be set by a request.',
      fields: owned.map((key) => `config.${key}`),
    };
  }
  if (isInstanceAdmin) return null;

  const runtime = asObject(body.runtime);
  if (runtime && 'runtimeType' in runtime) {
    const requestedType = normalizeRuntimeType(runtime.runtimeType);
    if (targets.some((target) => storedRuntimeType(target) !== requestedType)) {
      return {
        code: 'runtime_type_change',
        status: 403,
        error: 'An agent\'s runtime cannot be changed here. Install the agent again with the runtime you want.',
        fields: ['config.runtime.runtimeType'],
      };
    }
  }

  const compute = KERNEL_RUN_COMPUTE_KEYS.filter((key) => key in body);
  if (compute.length && targets.some((target) => KERNEL_RUN_RUNTIME_TYPES.has(storedRuntimeType(target)))) {
    return {
      code: 'kernel_run_field',
      status: 403,
      error: 'Commonly runs this agent, so Commonly sets its model, tools and limits.',
      fields: compute.map((key) => `config.${key}`),
    };
  }
  return null;
};

/**
 * The runtime block a write leaves behind, with a type every reader matches.
 * A caller who may not change the type gets the stored one back whatever they
 * sent (equal after normalizing, or the write was refused): saving their
 * spelling would let `HOSTED` past readers that match `hosted` exactly
 * (Rhea on #2229). An admin's type is saved normalized. A request that sends
 * `runtime` without a type (the Agents Hub sends only auth profiles and skill
 * env) keeps the stored one instead of erasing it.
 */
export const runtimeKeepingType = (
  requestedRuntime: Record<string, any>,
  existingConfig: unknown,
  { mayChangeType }: { mayChangeType: boolean },
): Record<string, any> => {
  const storedType = asObject(asObject(existingConfig)?.runtime)?.runtimeType;
  if (mayChangeType && 'runtimeType' in requestedRuntime) {
    return { ...requestedRuntime, runtimeType: normalizeRuntimeType(requestedRuntime.runtimeType) };
  }
  const { runtimeType: _sent, ...rest } = requestedRuntime;
  return storedType ? { ...rest, runtimeType: normalizeRuntimeType(storedType) } : rest;
};
