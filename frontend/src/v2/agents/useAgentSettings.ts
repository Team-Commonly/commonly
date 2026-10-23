import { useCallback, useEffect, useRef, useState } from 'react';
import axios from '../../utils/axiosConfig';

export interface AgentSettingsInstallation {
  name: string;
  instanceId: string;
  displayName: string;
  installedBy?: string;
  runtime?: { runtimeType?: string };
  config?: Record<string, unknown> | null;
  profile?: {
    instructions?: string;
    persona?: { tone?: string; specialties?: string[]; boundaries?: string[]; customInstructions?: string };
  } | null;
  [field: string]: unknown;
}

export interface AgentSettingsPatch {
  config?: Record<string, unknown>;
  displayName?: string;
  instructions?: string;
  persona?: { tone?: string; specialties?: string[]; boundaries?: string[]; customInstructions?: string };
  modelPreferences?: unknown;
  toolPolicy?: unknown;
  contextPolicy?: unknown;
  [field: string]: unknown;
}

export interface AgentPodWakePatch {
  wakeOnMessage: boolean;
  humanOnly: boolean;
  boardWake: boolean;
  heartbeatEnabled: boolean;
  heartbeatMinutes: number;
}

interface AgentAccess {
  displayName: string;
  pods: Array<{ id: string; name: string }>;
}

/** The generic PATCH writes across this identity's accessible installations. */
export const useAgentSettings = (agentName: string, instanceId: string) => {
  const [access, setAccess] = useState<AgentAccess | null>(null);
  const [installation, setInstallation] = useState<AgentSettingsInstallation | null>(null);
  const [podId, setPodId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const requestId = useRef(0);

  const installationUrl = useCallback((id: string) => (
    `/api/registry/pods/${encodeURIComponent(id)}/agents/${encodeURIComponent(agentName)}`
  ), [agentName]);

  const refresh = useCallback(async () => {
    const currentRequest = ++requestId.current;
    const accessResponse = await axios.get<AgentAccess>(
      `/api/agent-memory/${encodeURIComponent(agentName)}/${encodeURIComponent(instanceId)}`,
    );
    const nextAccess = accessResponse.data;
    // Memory lists every pod for the identity. A viewer can be a member of
    // only some of them, so find a readable installation before writing.
    for (const pod of nextAccess.pods || []) {
      try {
        const response = await axios.get<{ agent: AgentSettingsInstallation }>(installationUrl(pod.id), {
          params: { instanceId },
        });
        if (currentRequest === requestId.current) {
          setAccess(nextAccess);
          setInstallation(response.data.agent);
          setPodId(pod.id);
          setError(null);
        }
        return response.data.agent;
      } catch (candidateError) {
        if (![403, 404].includes((candidateError as { response?: { status?: number } })?.response?.status || 0)) {
          throw candidateError;
        }
      }
    }
    throw new Error('No accessible installation');
  }, [agentName, instanceId, installationUrl]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setAccess(null);
    setInstallation(null);
    setPodId(null);
    void refresh().catch((requestError) => {
      if (active) setError(requestError);
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; requestId.current += 1; };
  }, [refresh]);

  const update = useCallback(async (patch: AgentSettingsPatch) => {
    if (!podId) throw new Error('No accessible installation');
    const response = await axios.patch(installationUrl(podId), { ...patch, instanceId });
    await refresh();
    return response.data;
  }, [instanceId, installationUrl, podId, refresh]);

  const updatePod = useCallback(async (targetPodId: string, patch: AgentPodWakePatch) => {
    const response = await axios.patch(
      `/api/registry/agents/${encodeURIComponent(agentName)}/manage-settings/pods/${encodeURIComponent(targetPodId)}`,
      patch,
      { params: { instanceId } },
    );
    return response.data;
  }, [agentName, instanceId]);

  return { access, installation, podId, loading, error, refresh, update, updatePod };
};
