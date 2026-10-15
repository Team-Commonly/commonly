/** Keep non-native agents out of pods that hold outsider-writable grants. */
import { AgentInstallation } from '../models/AgentRegistry';
import { podHasOutsiderWritableGrant } from './nativeOutsiderGrantPolicy';

export class OutsiderGrantAgentJoinError extends Error {
  readonly code = 'outsider_grant_non_native_agent_join';

  readonly statusCode = 403;

  constructor() {
    super('This pod has an outsider-writable connector grant. Use a separate pod for an agent outside the narrowed native runtime.');
  }
}

export const runtimeTypeFromConfig = (config: unknown): string => {
  const values = config instanceof Map ? Object.fromEntries(config) : config;
  const runtime = (values && typeof values === 'object' && 'runtime' in values)
    ? (values as { runtime?: unknown }).runtime : null;
  return runtime && typeof runtime === 'object' && 'runtimeType' in runtime
    ? String((runtime as { runtimeType?: unknown }).runtimeType || '').trim().toLowerCase() : '';
};

export const assertAgentRuntimeMayJoinPod = async (podId: unknown, runtimeType: unknown): Promise<void> => {
  if (String(runtimeType || '').trim().toLowerCase() === 'native') return;
  if (await podHasOutsiderWritableGrant(String(podId))) throw new OutsiderGrantAgentJoinError();
};

/** A membership write without an install declaration may only trust a live native row. */
export const assertInstalledAgentMayJoinPod = async (
  podId: unknown, agentName: unknown, instanceId: unknown,
): Promise<void> => {
  const podIdValue = String(podId ?? '');
  if (!await podHasOutsiderWritableGrant(podIdValue)) return;
  const installation = await AgentInstallation.findOne({
    podId: podIdValue,
    agentName: String(agentName || '').trim().toLowerCase(),
    instanceId: String(instanceId || 'default'),
    status: 'active',
  }).select('config').lean();
  if (runtimeTypeFromConfig(installation?.config) !== 'native') throw new OutsiderGrantAgentJoinError();
};
