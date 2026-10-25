import { useCallback, useEffect, useRef, useState } from 'react';
import type { RuntimeObservation, HarnessInventory, RuntimeUpdate } from '../components/V2RuntimeControls';
import axios from '../../utils/axiosConfig';

export interface AgentSettingsInstallation {
  name: string;
  instanceId: string;
  displayName: string;
  installedBy?: string;
  runtime?: { runtimeType?: string; host?: string; adapter?: string; model?: string; effort?: string };
  config?: Record<string, unknown> | null;
  profile?: {
    instructions?: string;
    persona?: { tone?: string; specialties?: string[]; boundaries?: string[]; customInstructions?: string };
    toolPolicy?: { allowed?: string[]; blocked?: string[]; requireApproval?: string[] };
    contextPolicy?: {
      maxTokens?: number; compactionThreshold?: number; summaryHours?: number;
      includeMemory?: boolean; includeSkills?: boolean; includeSummaries?: boolean;
    };
  } | null;
  [field: string]: unknown;
}

export interface AgentSettingsPatch {
  config?: Record<string, unknown>;
  displayName?: string;
  persona?: { tone?: string; specialties?: string[]; boundaries?: string[]; customInstructions?: string };
  modelPreferences?: unknown;
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

interface ManageSettingsResponse {
  writablePodId: string | null;
  runtimeSourcePodId?: string | null;
  runtimeControls?: { providerId?: string; runtimeType?: string; host?: 'cloud' | 'byo'; adapter?: string; model?: string; effort?: string };
  runtimeSavedControls?: ManageSettingsResponse['runtimeControls'];
  ownKeyCapability?: { available: boolean; provider: string | null };
  runtimeObservation?: RuntimeObservation | null;
  runtimeInventory?: HarnessInventory[];
  processConnected?: boolean | null;
  runtimeEditable?: boolean;
  runtimeManaged?: boolean;
  installations: Array<{ podId: string; podName: string; status: string }>;
}

/** The generic PATCH writes across this identity's accessible installations. */
export const useAgentSettings = (agentName: string, instanceId: string) => {
  const [access, setAccess] = useState<AgentAccess | null>(null);
  const [installation, setInstallation] = useState<AgentSettingsInstallation | null>(null);
  const [podId, setPodId] = useState<string | null>(null);
  const [runtimeSourcePodId, setRuntimeSourcePodId] = useState<string | null>(null);
  const [runtimeControls, setRuntimeControls] = useState<ManageSettingsResponse['runtimeControls']>({});
  const [ownKeyCapability, setOwnKeyCapability] = useState<ManageSettingsResponse['ownKeyCapability']>();
  const [runtimeObservation, setRuntimeObservation] = useState<RuntimeObservation | null>(null);
  const [runtimeInventory, setRuntimeInventory] = useState<HarnessInventory[]>([]);
  const [processConnected, setProcessConnected] = useState<boolean | null>(null);
  const [runtimeEditable, setRuntimeEditable] = useState(true);
  const [runtimeManaged, setRuntimeManaged] = useState<boolean | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const requestId = useRef(0);

  const installationUrl = useCallback((id: string) => (
    `/api/registry/pods/${encodeURIComponent(id)}/agents/${encodeURIComponent(agentName)}`
  ), [agentName]);

  const refresh = useCallback(async () => {
    const currentRequest = ++requestId.current;
    const settingsResponse = await axios.get<ManageSettingsResponse>(
      `/api/registry/agents/${encodeURIComponent(agentName)}/manage-settings`,
      { params: { instanceId } },
    );
    // This endpoint lists only installations managed by the caller. Shared
    // identity memory can be private to another installer and is not a safe
    // source for discovering this viewer's settings.
    const rows = settingsResponse.data.installations || [];
    const preferredPodId = settingsResponse.data.writablePodId;
    const candidates = [...rows].sort((left, right) => Number(right.podId === preferredPodId)
      - Number(left.podId === preferredPodId));
    for (const pod of candidates) {
      try {
        const response = await axios.get<{ agent: AgentSettingsInstallation }>(installationUrl(pod.podId), {
          params: { instanceId },
        });
        if (currentRequest === requestId.current) {
          setAccess({ displayName: response.data.agent.displayName,
            pods: rows.map((row) => ({ id: row.podId, name: row.podName })) });
          setInstallation(response.data.agent);
          setPodId(pod.podId);
          setRuntimeSourcePodId(settingsResponse.data.runtimeSourcePodId === undefined
            ? settingsResponse.data.writablePodId : settingsResponse.data.runtimeSourcePodId);
          setRuntimeControls(settingsResponse.data.runtimeSavedControls || settingsResponse.data.runtimeControls || {});
          setOwnKeyCapability(settingsResponse.data.ownKeyCapability);
          setRuntimeObservation(settingsResponse.data.runtimeObservation || null);
          setRuntimeInventory(settingsResponse.data.runtimeInventory || []);
          setProcessConnected(typeof settingsResponse.data.processConnected === 'boolean' ? settingsResponse.data.processConnected : null);
          setRuntimeEditable(settingsResponse.data.runtimeEditable !== false);
          setRuntimeManaged(settingsResponse.data.runtimeManaged);
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
    setRuntimeSourcePodId(null);
    setRuntimeControls({});
    setOwnKeyCapability(undefined);
    setRuntimeObservation(null);
    setRuntimeInventory([]);
    setProcessConnected(null);
    setRuntimeEditable(true);
    setRuntimeManaged(undefined);
    void refresh().catch((requestError) => {
      if (active) setError(requestError);
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; requestId.current += 1; };
  }, [refresh]);

  // Refresh runner facts without reloading form drafts or asserting that a
  // process remains connected after the observation endpoint becomes unknown.
  useEffect(() => {
    if (!podId) return undefined;
    let active = true;
    let pending = false;
    const timer = setInterval(async () => {
      if (pending) return;
      pending = true;
      try {
        const response = await axios.get<ManageSettingsResponse>(
          `/api/registry/agents/${encodeURIComponent(agentName)}/manage-settings`, { params: { instanceId } },
        );
        if (active) {
          setRuntimeObservation(response.data.runtimeObservation || null);
          setRuntimeInventory(response.data.runtimeInventory || []);
          setProcessConnected(typeof response.data.processConnected === 'boolean' ? response.data.processConnected : null);
        }
      } catch { if (active) setProcessConnected(null); }
      finally { pending = false; }
    }, 30_000);
    return () => { active = false; clearInterval(timer); };
  }, [agentName, instanceId, podId]);

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

  const updateRuntime = useCallback(async (changes: RuntimeUpdate) => {
    if (!runtimeSourcePodId) throw new Error('No writable runtime source');
    await axios.patch(installationUrl(runtimeSourcePodId), {
      config: { environment: { ...(changes.model !== undefined ? { model: changes.model } : {}),
        ...(changes.effort !== undefined ? { effort: changes.effort } : {}) },
        ...(changes.adapter ? { runtime: { adapter: changes.adapter } } : {}) }, instanceId,
    });
    await refresh();
  }, [instanceId, installationUrl, refresh, runtimeSourcePodId]);

  return { access, installation, podId, ownKeyCapability, runtimeControls, runtimeObservation, runtimeInventory, processConnected, runtimeEditable, runtimeManaged, loading,
    error, refresh, update, updatePod, updateRuntime };
};
