import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  FormControl,
  FormControlLabel,
  InputLabel,
  MenuItem,
  Select,
  Switch,
  TextField,
  Typography,
  Alert,
} from '@mui/material';
import axios from 'axios';

const ROLE_OPTIONS = [
  { value: 'starter', label: 'Starter' },
  { value: 'responder', label: 'Responder' },
  { value: 'synthesizer', label: 'Synthesizer' },
  { value: 'observer', label: 'Observer' },
];

const HUMAN_PARTICIPATION_OPTIONS = [
  { value: 'participate', label: 'Participate' },
  { value: 'read-only', label: 'Read-only' },
  { value: 'none', label: 'No humans' },
];

interface StopConditions {
  maxMessages: number | string;
  maxRounds: number | string;
  maxDurationMinutes: number | string;
}

interface Schedule {
  enabled: boolean;
  frequencyMinutes: number | string;
  timezone: string;
}

const DEFAULT_STOP_CONDITIONS: StopConditions = {
  maxMessages: 20,
  maxRounds: 5,
  maxDurationMinutes: 60,
};

const DEFAULT_SCHEDULE: Schedule = {
  enabled: false,
  frequencyMinutes: 20,
  timezone: 'UTC',
};

const buildAgentKey = (agentType: string, instanceId = 'default'): string => `${agentType}::${instanceId}`;

const parseAgentKey = (value = ''): { agentType: string; instanceId: string } | null => {
  const [agentType, instanceId] = value.split('::');
  if (!agentType) return null;
  return { agentType, instanceId: instanceId || 'default' };
};

const clampNumber = (value: number | string, fallback: number): number => {
  const parsed = Number.parseInt(String(value), 10);
  if (Number.isNaN(parsed)) return fallback;
  return Math.max(parsed, 1);
};

interface Participant {
  agentType: string;
  instanceId: string;
  role: string;
}

interface AgentOption {
  key: string;
  label: string;
  agentType: string;
  instanceId: string;
}

interface EnsembleTurnState {
  currentAgent?: { agentType?: string };
  roundNumber?: number;
  turnNumber?: number;
}

interface EnsembleSummary {
  content?: string;
}

interface EnsembleState {
  id?: string;
  status?: string;
  participants?: Participant[];
  turnState?: EnsembleTurnState;
  stats?: Record<string, unknown>;
  summary?: EnsembleSummary;
  stopConditions?: Partial<StopConditions>;
  schedule?: Partial<Schedule>;
  topic?: string;
  pausedAt?: string;
  completionReason?: string;
  totalMessages?: number;
}

interface PodConfig {
  enabled?: boolean;
  topic?: string;
  participants?: Participant[];
  stopConditions?: Partial<StopConditions>;
  schedule?: Partial<Schedule>;
  humanParticipation?: string;
}

interface PodAgent {
  name: string;
  instanceId?: string;
  profile?: { displayName?: string };
  displayName?: string;
}

interface AgentEnsemblePanelProps {
  podId: string;
  podAgents?: PodAgent[];
  isPodAdmin?: boolean;
}

const AgentEnsemblePanel: React.FC<AgentEnsemblePanelProps> = ({
  podId,
  podAgents = [],
  isPodAdmin = false,
}) => {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState('');
  const [state, setState] = useState<EnsembleState | null>(null);
  const [podConfig, setPodConfig] = useState<PodConfig | null>(null);

  const [enabled, setEnabled] = useState(false);
  const [topic, setTopic] = useState('');
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [stopConditions, setStopConditions] = useState<StopConditions>(DEFAULT_STOP_CONDITIONS);
  const [schedule, setSchedule] = useState<Schedule>(DEFAULT_SCHEDULE);
  const [humanParticipation, setHumanParticipation] = useState('participate');

  const authHeaders = useMemo(() => {
    const token = localStorage.getItem('token');
    return token ? { Authorization: `Bearer ${token}` } : {};
  }, []);

  const agentOptions: AgentOption[] = useMemo(() => (
    (podAgents || []).map((agent) => ({
      key: buildAgentKey(agent.name, agent.instanceId || 'default'),
      label: agent.profile?.displayName || agent.displayName || agent.name,
      agentType: agent.name,
      instanceId: agent.instanceId || 'default',
    }))
  ), [podAgents]);

  const applyStatePatch = useCallback((patch: Partial<EnsembleState>): void => {
    if (!patch) return;
    setState((prev) => {
      if (!prev) {
        return patch as EnsembleState;
      }
      const next: EnsembleState = { ...prev, ...patch };
      if (patch.turnState) {
        next.turnState = { ...prev.turnState, ...patch.turnState };
      }
      if (patch.stats) {
        next.stats = { ...prev.stats, ...patch.stats };
      }
      if (patch.participants) {
        next.participants = patch.participants;
      }
      if (patch.stopConditions) {
        next.stopConditions = patch.stopConditions;
      }
      if (patch.schedule) {
        next.schedule = patch.schedule;
      }
      if (patch.summary !== undefined) {
        next.summary = patch.summary;
      }
      return next;
    });
  }, []);

  const refreshState = useCallback(async (): Promise<{ state?: EnsembleState; podConfig?: PodConfig } | null> => {
    if (!podId) return null;
    setLoading(true);
    setError('');
    try {
      const response = await axios.get(`/api/pods/${podId}/ensemble/state`, {
        headers: authHeaders,
      });
      const data = response.data as { state?: EnsembleState; podConfig?: PodConfig };
      setState(data?.state || null);
      setPodConfig(data?.podConfig || {});
      return data || null;
    } catch (err) {
      const e = err as { response?: { data?: { error?: string } } };
      console.error('Failed to load ensemble state:', err);
      setError(e.response?.data?.error || 'Unable to load agent ensemble status.');
      return null;
    } finally {
      setLoading(false);
    }
  }, [podId, authHeaders]);

  useEffect(() => {
    refreshState();
  }, [refreshState]);

  useEffect(() => {
    const configSource: PodConfig = podConfig || {};
    const stateSource: EnsembleState = state || {};
    const useLiveState = ['active', 'paused'].includes(stateSource.status || '');
    const mergedConfig = useLiveState
      ? {
        ...configSource,
        ...stateSource,
        stopConditions: {
          ...(configSource.stopConditions || {}),
          ...(stateSource.stopConditions || {}),
        },
        schedule: {
          ...(configSource.schedule || {}),
          ...(stateSource.schedule || {}),
        },
      }
      : {
        ...configSource,
      };
    const participantsSource = useLiveState && stateSource.participants?.length
      ? stateSource.participants
      : (configSource.participants || []);

    setEnabled(Boolean(configSource.enabled));
    setTopic(mergedConfig.topic || '');
    setParticipants(participantsSource.map((p) => ({
      agentType: p.agentType,
      instanceId: p.instanceId || 'default',
      role: p.role || 'responder',
    })));
    setStopConditions({
      ...DEFAULT_STOP_CONDITIONS,
      ...(mergedConfig.stopConditions || {}),
    });
    setSchedule({
      ...DEFAULT_SCHEDULE,
      ...(mergedConfig.schedule || {}),
    } as Schedule);
    setHumanParticipation(configSource.humanParticipation || 'participate');
  }, [podConfig, state]);

  const handleParticipantChange = (index: number, nextValue: string): void => {
    setParticipants((prev) => {
      const updated = [...prev];
      const parsed = parseAgentKey(nextValue);
      if (!parsed) return updated;
      const hasStarter = updated.some((item, idx) => idx !== index && item.role === 'starter');
      updated[index] = {
        agentType: parsed.agentType,
        instanceId: parsed.instanceId,
        role: updated[index]?.role || (hasStarter ? 'responder' : 'starter'),
      };
      return updated;
    });
  };

  const handleRoleChange = (index: number, role: string): void => {
    setParticipants((prev) => {
      const updated = [...prev];
      updated[index] = { ...updated[index], role };
      if (role === 'starter') {
        return updated.map((item, idx) => (
          idx === index ? item : { ...item, role: item.role === 'starter' ? 'responder' : item.role }
        ));
      }
      return updated;
    });
  };

  const handleAddParticipant = (): void => {
    setParticipants((prev) => {
      const hasStarter = prev.some((item) => item.role === 'starter');
      return [...prev, { agentType: '', instanceId: 'default', role: hasStarter ? 'responder' : 'starter' }];
    });
  };

  const handleRemoveParticipant = (index: number): void => {
    setParticipants((prev) => prev.filter((_, idx) => idx !== index));
  };

  const validateParticipants = (): string | null => {
    const filtered = participants.filter((p) => p.agentType);
    if (filtered.length < 2) {
      return 'Add at least two agents to start an ensemble discussion.';
    }
    const starters = filtered.filter((p) => p.role === 'starter');
    if (starters.length === 0) {
      return 'Select a starter agent for the first turn.';
    }
    if (starters.length > 1) {
      return 'Only one starter agent is allowed.';
    }
    return null;
  };

  const buildParticipantPayload = (): Array<Participant & { displayName?: string }> => (
    participants
      .filter((p) => p.agentType)
      .map((p) => {
        const match = agentOptions.find((option) => (
          option.agentType === p.agentType && option.instanceId === (p.instanceId || 'default')
        ));
        return {
          agentType: p.agentType,
          instanceId: p.instanceId || 'default',
          role: p.role || 'responder',
          displayName: match?.label,
        };
      })
  );

  const handleSaveConfig = async (): Promise<void> => {
    if (!podId) return;

    if (state?.status === 'active') {
      const originalParticipants = state.participants || [];
      const currentParticipants = buildParticipantPayload();
      const removedParticipants = currentParticipants.length < originalParticipants.length;
      const existingChanged = originalParticipants.some(
        (orig, i) =>
          orig.agentType !== currentParticipants[i]?.agentType ||
          (orig.instanceId || 'default') !== (currentParticipants[i]?.instanceId || 'default'),
      );

      if (removedParticipants || existingChanged) {
        setError('Cannot modify existing participants during an active discussion. Please stop the discussion first.');
        return;
      }
    }

    setSaving(true);
    setError('');
    try {
      const response = await axios.patch(
        `/api/pods/${podId}/ensemble/config`,
        {
          enabled,
          topic: topic.trim(),
          participants: buildParticipantPayload(),
          stopConditions: {
            maxMessages: clampNumber(stopConditions.maxMessages, DEFAULT_STOP_CONDITIONS.maxMessages as number),
            maxRounds: clampNumber(stopConditions.maxRounds, DEFAULT_STOP_CONDITIONS.maxRounds as number),
            maxDurationMinutes: clampNumber(stopConditions.maxDurationMinutes, DEFAULT_STOP_CONDITIONS.maxDurationMinutes as number),
          },
          schedule: {
            enabled: Boolean(schedule.enabled),
            frequencyMinutes: clampNumber(schedule.frequencyMinutes, DEFAULT_SCHEDULE.frequencyMinutes as number),
            timezone: schedule.timezone || 'UTC',
          },
          humanParticipation,
        },
        { headers: authHeaders },
      );
      const data = response?.data as { config?: PodConfig };
      if (data?.config) {
        setPodConfig(data.config);
      }
      await refreshState();
    } catch (err) {
      const e = err as { response?: { data?: { error?: string } } };
      console.error('Failed to save ensemble config:', err);
      setError(e.response?.data?.error || 'Failed to save ensemble configuration.');
    } finally {
      setSaving(false);
    }
  };

  const handleStart = async (): Promise<void> => {
    const validationError = validateParticipants();
    if (validationError) {
      setError(validationError);
      return;
    }
    setActionLoading(true);
    setError('');
    try {
      const response = await axios.post(
        `/api/pods/${podId}/ensemble/start`,
        {
          topic: topic.trim(),
          participants: buildParticipantPayload(),
          maxMessages: clampNumber(stopConditions.maxMessages, DEFAULT_STOP_CONDITIONS.maxMessages as number),
          maxRounds: clampNumber(stopConditions.maxRounds, DEFAULT_STOP_CONDITIONS.maxRounds as number),
          maxDurationMinutes: clampNumber(stopConditions.maxDurationMinutes, DEFAULT_STOP_CONDITIONS.maxDurationMinutes as number),
        },
        { headers: authHeaders },
      );
      const data = response?.data as { state?: EnsembleState };
      if (data?.state) {
        setState(data.state);
      }
      const refreshed = await refreshState();
      if (refreshed?.state?.status && refreshed.state.status !== 'active') {
        setError('Server did not start the discussion. Please try again or refresh.');
      }
    } catch (err) {
      const e = err as { response?: { data?: { error?: string } } };
      console.error('Failed to start ensemble discussion:', err);
      setError(e.response?.data?.error || 'Failed to start the discussion.');
    } finally {
      setActionLoading(false);
    }
  };

  const handlePause = async (): Promise<void> => {
    setActionLoading(true);
    setError('');
    try {
      const response = await axios.post(`/api/pods/${podId}/ensemble/pause`, {}, { headers: authHeaders });
      const data = response?.data as { state?: EnsembleState & { pausedAt?: string; turnNumber?: number } };
      if (data?.state) {
        applyStatePatch({
          id: data.state.id,
          status: data.state.status,
          stats: {
            pausedAt: data.state.pausedAt,
          },
          turnState: {
            turnNumber: data.state.turnNumber,
          },
        });
      }
      const refreshed = await refreshState();
      if (refreshed?.state?.status && refreshed.state.status !== 'paused') {
        setError('Pause request sent, but the server still reports the discussion as active.');
      }
    } catch (err) {
      const e = err as { response?: { data?: { error?: string } } };
      console.error('Failed to pause ensemble discussion:', err);
      setError(e.response?.data?.error || 'Failed to pause the discussion.');
    } finally {
      setActionLoading(false);
    }
  };

  const handleResume = async (): Promise<void> => {
    setActionLoading(true);
    setError('');
    try {
      const response = await axios.post(`/api/pods/${podId}/ensemble/resume`, {}, { headers: authHeaders });
      const data = response?.data as { state?: EnsembleState & { turnNumber?: number; currentAgent?: { agentType: string } } };
      if (data?.state) {
        applyStatePatch({
          id: data.state.id,
          status: data.state.status,
          turnState: {
            turnNumber: data.state.turnNumber,
            currentAgent: data.state.currentAgent,
          },
        });
      }
      const refreshed = await refreshState();
      if (refreshed?.state?.status && refreshed.state.status !== 'active') {
        setError('Resume request sent, but the server did not mark the discussion active.');
      }
    } catch (err) {
      const e = err as { response?: { data?: { error?: string } } };
      console.error('Failed to resume ensemble discussion:', err);
      setError(e.response?.data?.error || 'Failed to resume the discussion.');
    } finally {
      setActionLoading(false);
    }
  };

  const handleComplete = async (): Promise<void> => {
    setActionLoading(true);
    setError('');
    try {
      const response = await axios.post(`/api/pods/${podId}/ensemble/complete`, {}, { headers: authHeaders });
      const data = response?.data as {
        state?: EnsembleState & { completionReason?: string; totalMessages?: number }
      };
      if (data?.state) {
        applyStatePatch({
          id: data.state.id,
          status: data.state.status,
          summary: data.state.summary,
          stats: {
            completionReason: data.state.completionReason,
            totalMessages: data.state.totalMessages,
          },
        });
      }
      const refreshed = await refreshState();
      if (refreshed?.state?.status && refreshed.state.status !== 'completed') {
        setError('Complete request sent, but the server did not mark the discussion completed.');
      }
    } catch (err) {
      const e = err as { response?: { data?: { error?: string } } };
      console.error('Failed to complete ensemble discussion:', err);
      setError(e.response?.data?.error || 'Failed to complete the discussion.');
    } finally {
      setActionLoading(false);
    }
  };

  const usedAgentKeys = participants
    .filter((p) => p.agentType)
    .map((p) => buildAgentKey(p.agentType, p.instanceId || 'default'));
  const activeParticipantCount = state?.participants?.length || 0;
  const isActive = state?.status === 'active';
  const isConfigLocked = state?.status === 'active';
  const configInputsDisabled = isConfigLocked || saving || loading;
  const saveDisabled = !isPodAdmin || saving || isConfigLocked || loading;

  return (
    <div className="sidebar-section">
      <div className="sidebar-section-title">
        <span>Agent Ensemble</span>
        <Button
          size="small"
          variant="text"
          onClick={refreshState}
          sx={{ ml: 'auto', fontWeight: 600 }}
          disabled={loading}
        >
          Refresh
        </Button>
      </div>
      <div className="sidebar-section-content">
        {loading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', p: 2 }}>
            <CircularProgress size={20} />
          </Box>
        ) : (
          <>
            {error && (
              <Alert severity="warning" sx={{ mb: 2 }}>
                {error}
              </Alert>
            )}
            {isConfigLocked && (
              <Alert severity="info" sx={{ mb: 2 }}>
                Configuration is locked while a discussion is active. Pause or complete the discussion to edit settings.
              </Alert>
            )}
            {state?.status === 'paused' && (
              <Alert severity="info" sx={{ mb: 2 }}>
                Discussion is paused. Resume to continue or edit configuration before resuming.
              </Alert>
            )}
            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mb: 2 }}>
              <Chip
                label={state?.status ? `Status: ${state.status}` : 'Status: idle'}
                color={state?.status === 'active' ? 'success' : (state?.status === 'paused' ? 'warning' : 'default')}
                size="small"
              />
              {state?.turnState?.currentAgent?.agentType && (
                <Chip
                  label={`Turn: ${state.turnState.currentAgent.agentType}`}
                  size="small"
                  variant="outlined"
                />
              )}
              {state?.turnState?.roundNumber !== undefined && (
                <Chip
                  label={`Round ${state.turnState.roundNumber + 1}`}
                  size="small"
                  variant="outlined"
                />
              )}
            </Box>

            <TextField
              label="Topic"
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              fullWidth
              size="small"
              sx={{ mb: 2 }}
              disabled={configInputsDisabled}
            />

            <FormControlLabel
              control={(
                <Switch
                  checked={enabled}
                  onChange={(e) => setEnabled(e.target.checked)}
                  disabled={configInputsDisabled}
                />
              )}
              label="Enable ensemble"
              sx={{ mb: 1 }}
            />

            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 2 }}>
              Configure the participants and roles for multi-agent turns.
            </Typography>

            {participants.map((participant, index) => {
              const isLockedParticipant = isActive && index < activeParticipantCount;
              const selectedKey = participant.agentType
                ? buildAgentKey(participant.agentType, participant.instanceId || 'default')
                : '';
              return (
                <Box
                  key={`${participant.agentType || 'participant'}-${index}`}
                  sx={{
                    mb: 1.5,
                    p: 1,
                    borderRadius: 1.5,
                    border: '1px solid rgba(148, 163, 184, 0.2)',
                    backgroundColor: 'rgba(15, 23, 42, 0.6)',
                  }}
                >
                  <FormControl fullWidth size="small" sx={{ mb: 1 }}>
                    <InputLabel>Agent</InputLabel>
                    <Select
                      value={selectedKey}
                      label="Agent"
                      onChange={(e) => handleParticipantChange(index, e.target.value as string)}
                      disabled={isLockedParticipant || configInputsDisabled}
                    >
                      {agentOptions.length === 0 && (
                        <MenuItem value="" disabled>
                          No agents installed
                        </MenuItem>
                      )}
                      {agentOptions.map((option) => {
                        const isUsed = usedAgentKeys.includes(option.key) && option.key !== selectedKey;
                        return (
                          <MenuItem key={option.key} value={option.key} disabled={isUsed}>
                            {option.label}
                          </MenuItem>
                        );
                      })}
                    </Select>
                  </FormControl>
                  <FormControl fullWidth size="small" sx={{ mb: 1 }}>
                    <InputLabel>Role</InputLabel>
                    <Select
                      value={participant.role || 'responder'}
                      label="Role"
                      onChange={(e) => handleRoleChange(index, e.target.value as string)}
                      disabled={configInputsDisabled}
                    >
                      {ROLE_OPTIONS.map((option) => (
                        <MenuItem key={option.value} value={option.value}>
                          {option.label}
                        </MenuItem>
                      ))}
                    </Select>
                  </FormControl>
                  <Button
                    variant="text"
                    size="small"
                    color="error"
                    onClick={() => handleRemoveParticipant(index)}
                    disabled={isLockedParticipant || configInputsDisabled}
                  >
                    Remove
                  </Button>
                </Box>
              );
            })}

            <Button
              variant="outlined"
              size="small"
              onClick={handleAddParticipant}
              sx={{ mb: 2 }}
              disabled={agentOptions.length === 0 || configInputsDisabled}
            >
              Add participant
            </Button>

            <Divider sx={{ my: 2 }} />

            <Typography variant="subtitle2" sx={{ mb: 1 }}>
              Stop conditions
            </Typography>
            <TextField
              label="Max messages"
              value={stopConditions.maxMessages}
              onChange={(e) => setStopConditions((prev) => ({
                ...prev,
                maxMessages: e.target.value,
              }))}
              fullWidth
              size="small"
              sx={{ mb: 1 }}
              disabled={configInputsDisabled}
            />
            <TextField
              label="Max rounds"
              value={stopConditions.maxRounds}
              onChange={(e) => setStopConditions((prev) => ({
                ...prev,
                maxRounds: e.target.value,
              }))}
              fullWidth
              size="small"
              sx={{ mb: 1 }}
              disabled={configInputsDisabled}
            />
            <TextField
              label="Max duration (minutes)"
              value={stopConditions.maxDurationMinutes}
              onChange={(e) => setStopConditions((prev) => ({
                ...prev,
                maxDurationMinutes: e.target.value,
              }))}
              fullWidth
              size="small"
              sx={{ mb: 2 }}
              disabled={configInputsDisabled}
            />

            <Typography variant="subtitle2" sx={{ mb: 1 }}>
              Human participation
            </Typography>
            <FormControl fullWidth size="small" sx={{ mb: 2 }}>
              <InputLabel>Access</InputLabel>
              <Select
                value={humanParticipation}
                label="Access"
                onChange={(e) => setHumanParticipation(e.target.value as string)}
                disabled={configInputsDisabled}
              >
                {HUMAN_PARTICIPATION_OPTIONS.map((option) => (
                  <MenuItem key={option.value} value={option.value}>
                    {option.label}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>

            <Typography variant="subtitle2" sx={{ mb: 1 }}>
              Schedule
            </Typography>
            <FormControlLabel
              control={(
                <Switch
                  checked={Boolean(schedule.enabled)}
                  onChange={(e) => setSchedule((prev) => ({
                    ...prev,
                    enabled: e.target.checked,
                  }))}
                  disabled={configInputsDisabled}
                />
              )}
              label="Enable schedule"
              sx={{ mb: 1 }}
            />
            <TextField
              label="Frequency (minutes)"
              value={schedule.frequencyMinutes}
              onChange={(e) => setSchedule((prev) => ({
                ...prev,
                frequencyMinutes: e.target.value,
              }))}
              fullWidth
              size="small"
              sx={{ mb: 1 }}
              disabled={!schedule.enabled || configInputsDisabled}
            />
            <TextField
              label="Timezone"
              value={schedule.timezone}
              onChange={(e) => setSchedule((prev) => ({
                ...prev,
                timezone: e.target.value,
              }))}
              fullWidth
              size="small"
              sx={{ mb: 2 }}
              disabled={!schedule.enabled || configInputsDisabled}
            />

            <Button
              variant="contained"
              size="small"
              onClick={handleSaveConfig}
              disabled={saveDisabled}
              sx={{ mb: 1 }}
              fullWidth
            >
              {saving ? 'Saving...' : 'Save configuration'}
            </Button>
            {!isPodAdmin && (
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 2 }}>
                Only pod admins can save ensemble settings.
              </Typography>
            )}

            <Divider sx={{ my: 2 }} />

            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
              <Button
                variant="contained"
                onClick={handleStart}
                disabled={actionLoading || state?.status === 'active' || state?.status === 'paused' || loading}
              >
                Start discussion
              </Button>
              <Button
                variant="outlined"
                onClick={handlePause}
                disabled={actionLoading || state?.status !== 'active' || loading}
              >
                Pause discussion
              </Button>
              <Button
                variant="outlined"
                onClick={handleResume}
                disabled={actionLoading || state?.status !== 'paused' || loading}
              >
                Resume discussion
              </Button>
              <Button
                variant="text"
                color="error"
                onClick={handleComplete}
                disabled={actionLoading || !state || state.status === 'completed' || loading}
              >
                Complete discussion
              </Button>
            </Box>

            {state?.summary?.content && (
              <Box sx={{ mt: 2 }}>
                <Typography variant="subtitle2" sx={{ mb: 1 }}>
                  Latest summary
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  {state.summary.content}
                </Typography>
              </Box>
            )}
          </>
        )}
      </div>
    </div>
  );
};

export default AgentEnsemblePanel;
