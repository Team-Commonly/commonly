/**
 * Wake policy is installation-specific, but whether waking on every message
 * is appropriate is a property of the room. A manifest may opt in; this
 * resolver applies that opt-in only while the pod is still 1:1-shaped.
 *
 * Keep this pure. Install writers and the message fan-out both use it, so a
 * second human joining a room takes effect on the next message even if the
 * installation row was created while the room was personal.
 */

export interface WakePolicyPod {
  type?: string | null;
  members?: unknown[] | null;
}

type ConfigRecord = Record<string, unknown>;

const asRecord = (value: unknown): ConfigRecord => {
  if (value instanceof Map) return Object.fromEntries(value.entries()) as ConfigRecord;
  if (value && typeof value === 'object' && !Array.isArray(value)) return { ...(value as ConfigRecord) };
  return {};
};

const requestedWake = (config: ConfigRecord): ConfigRecord | null => {
  const wake = config.wakeOnMessage;
  return wake && typeof wake === 'object' && !Array.isArray(wake)
    ? asRecord(wake)
    : null;
};

/** Whether this installation asked to wake on every message at all. */
export const hasWakeOnMessageOptIn = (config: unknown): boolean => (
  requestedWake(asRecord(config))?.enabled === true
);

/** A chat stays 1:1-shaped through the owner + one agent. */
export const isOneToOneShapedPod = (pod: WakePolicyPod | null | undefined): boolean => (
  pod?.type === 'chat' && Array.isArray(pod.members) && pod.members.length <= 2
);

/**
 * Preserve a manifest's default-off setting. For an explicit opt-in, the
 * room shape is authoritative: a shared room is mention-only.
 */
export const resolveWakePolicy = (
  config: unknown,
  pod: WakePolicyPod | null | undefined,
): ConfigRecord => {
  const resolved = asRecord(config);
  const wake = requestedWake(resolved);
  if (!wake || wake.enabled !== true) return resolved;

  return {
    ...resolved,
    wakeOnMessage: {
      ...wake,
      enabled: isOneToOneShapedPod(pod),
    },
  };
};

export const wakeOnMessageEnabledForPod = (
  config: unknown,
  pod: WakePolicyPod | null | undefined,
): boolean => {
  const resolved = resolveWakePolicy(config, pod);
  const wake = resolved.wakeOnMessage;
  return !!(wake && typeof wake === 'object' && (wake as { enabled?: unknown }).enabled === true);
};
