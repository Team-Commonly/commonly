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

const DEFAULT_STOP_CONDITIONS = {
  maxMessages: 20,
  maxRounds: 5,
  maxDurationMinutes: 60,
};

const DEFAULT_SCHEDULE = {
  enabled: false,
  frequencyMinutes: 20,
  timezone: 'UTC',
};

const buildAgentKey = (agentType, instanceId = 'default') => `${agentType}::${instanceId}`;

const parseAgentKey = (value = '') => {
  const [agentType, instanceId] = value.split('::');
  if (!agentType) return null;
  return { agentType, instanceId: instanceId || 'default' };
};

const clampNumber = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) return fallback;
  return Math.max(parsed, 1);
};

const AgentEnsemblePanel = ({ podId, podAgents = [], isPodAdmin = false }) => {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState('');
  const [state, setState] = useState(null);
  const [podConfig, setPodConfig] = useState(null);

  const [enabled, setEnabled] = useState(false);
  const [topic, setTopic] = useState('');
  const [participants, setParticipants] = useState([]);
  const [stopConditions, setStopConditions] = useState(DEFAULT_STOP_CONDITIONS);
  const [schedule, setSchedule] = useState(DEFAULT_SCHEDULE);
  const [humanParticipation, setHumanParticipation] = useState('participate');

  const authHeaders = useMemo(() => {
    const token = localStorage.getItem('token');
    return token ? { Authorization: `Bearer ${token}` } : {};
  }, []);

  const agentOptions = useMemo(() => (
    (podAgents || []).map((agent) => ({
      key: buildAgentKey(agent.name, agent.instanceId || 'default'),
      label: agent.profile?.displayName || agent.displayName || agent.name,
      agentType: agent.name,
      instanceId: agent.instanceId || 'default',
    }))
  ), [podAgents]);

  const refreshState = useCallback(async () => {
    if (!podId) return;
    setLoading(true);
    setError('');
    try {
      const response = await axios.get(`/api/pods/${podId}/ensemble/state`, {
        headers: authHeaders,
      });
      setState(response.data?.state || null);
      setPodConfig(response.data?.podConfig || {});
    } catch (err) {
      console.error('Failed to load ensemble state:', err);
      setError(err.response?.data?.error || 'Unable to load agent ensemble status.');
    } finally {
      setLoading(false);
    }
  }, [podId, authHeaders]);

  useEffect(() => {
    refreshState();
  }, [refreshState]);

  useEffect(() => {
    const configSource = podConfig || {};
    const stateSource = state || {};
    const mergedConfig = {
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
    };
    const participantsSource = stateSource.participants?.length
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
    });
    setHumanParticipation(configSource.humanParticipation || 'participate');
  }, [podConfig, state]);

  const handleParticipantChange = (index, nextValue) => {
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

  const handleRoleChange = (index, role) => {
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

  const handleAddParticipant = () => {
    setParticipants((prev) => {
      const hasStarter = prev.some((item) => item.role === 'starter');
      return [...prev, { agentType: '', instanceId: 'default', role: hasStarter ? 'responder' : 'starter' }];
    });
  };

  const handleRemoveParticipant = (index) => {
    setParticipants((prev) => prev.filter((_, idx) => idx !== index));
  };

  const validateParticipants = () => {
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

  const buildParticipantPayload = () => (
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

  const handleSaveConfig = async () => {
    if (!podId) return;

    if (state?.status === 'active') {
      const originalParticipants = state.participants || [];
      const currentParticipants = buildParticipantPayload();
      const participantsChanged =
        originalParticipants.length !== currentParticipants.length ||
        originalParticipants.some(
          (orig, i) =>
            orig.agentType !== currentParticipants[i]?.agentType ||
            (orig.instanceId || 'default') !== (currentParticipants[i]?.instanceId || 'default'),
        );

      if (participantsChanged) {
        setError('Cannot modify participants during an active discussion. Please stop the discussion first.');
        return;
      }
    }

    setSaving(true);
    setError('');
    try {
      await axios.patch(
        `/api/pods/${podId}/ensemble/config`,
        {
          enabled,
          topic: topic.trim(),
          participants: buildParticipantPayload(),
          stopConditions: {
            maxMessages: clampNumber(stopConditions.maxMessages, DEFAULT_STOP_CONDITIONS.maxMessages),
            maxRounds: clampNumber(stopConditions.maxRounds, DEFAULT_STOP_CONDITIONS.maxRounds),
            maxDurationMinutes: clampNumber(stopConditions.maxDurationMinutes, DEFAULT_STOP_CONDITIONS.maxDurationMinutes),
          },
          schedule: {
            enabled: Boolean(schedule.enabled),
            frequencyMinutes: clampNumber(schedule.frequencyMinutes, DEFAULT_SCHEDULE.frequencyMinutes),
            timezone: schedule.timezone || 'UTC',
          },
          humanParticipation,
        },
        { headers: authHeaders },
      );
      await refreshState();
    } catch (err) {
      console.error('Failed to save ensemble config:', err);
      setError(err.response?.data?.error || 'Failed to save ensemble configuration.');
    } finally {
      setSaving(false);
    }
  };

  const handleStart = async () => {
    const validationError = validateParticipants();
    if (validationError) {
      setError(validationError);
      return;
    }
    setActionLoading(true);
    setError('');
    try {
      await axios.post(
        `/api/pods/${podId}/ensemble/start`,
        {
          topic: topic.trim(),
          participants: buildParticipantPayload(),
          maxMessages: clampNumber(stopConditions.maxMessages, DEFAULT_STOP_CONDITIONS.maxMessages),
          maxRounds: clampNumber(stopConditions.maxRounds, DEFAULT_STOP_CONDITIONS.maxRounds),
          maxDurationMinutes: clampNumber(stopConditions.maxDurationMinutes, DEFAULT_STOP_CONDITIONS.maxDurationMinutes),
        },
        { headers: authHeaders },
      );
      await refreshState();
    } catch (err) {
      console.error('Failed to start ensemble discussion:', err);
      setError(err.response?.data?.error || 'Failed to start the discussion.');
    } finally {
      setActionLoading(false);
    }
  };

  const handlePause = async () => {
    setActionLoading(true);
    setError('');
    try {
      await axios.post(`/api/pods/${podId}/ensemble/pause`, {}, { headers: authHeaders });
      await refreshState();
    } catch (err) {
      console.error('Failed to pause ensemble discussion:', err);
      setError(err.response?.data?.error || 'Failed to pause the discussion.');
    } finally {
      setActionLoading(false);
    }
  };

  const handleResume = async () => {
    setActionLoading(true);
    setError('');
    try {
      await axios.post(`/api/pods/${podId}/ensemble/resume`, {}, { headers: authHeaders });
      await refreshState();
    } catch (err) {
      console.error('Failed to resume ensemble discussion:', err);
      setError(err.response?.data?.error || 'Failed to resume the discussion.');
    } finally {
      setActionLoading(false);
    }
  };

  const handleComplete = async () => {
    setActionLoading(true);
    setError('');
    try {
      await axios.post(`/api/pods/${podId}/ensemble/complete`, {}, { headers: authHeaders });
      await refreshState();
    } catch (err) {
      console.error('Failed to complete ensemble discussion:', err);
      setError(err.response?.data?.error || 'Failed to complete the discussion.');
    } finally {
      setActionLoading(false);
    }
  };

  const usedAgentKeys = participants
    .filter((p) => p.agentType)
    .map((p) => buildAgentKey(p.agentType, p.instanceId || 'default'));

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
            />

            <FormControlLabel
              control={(
                <Switch
                  checked={enabled}
                  onChange={(e) => setEnabled(e.target.checked)}
                />
              )}
              label="Enable ensemble"
              sx={{ mb: 1 }}
            />

            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 2 }}>
              Configure the participants and roles for multi-agent turns.
            </Typography>

            {participants.map((participant, index) => {
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
                      onChange={(e) => handleParticipantChange(index, e.target.value)}
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
                      onChange={(e) => handleRoleChange(index, e.target.value)}
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
              disabled={agentOptions.length === 0 || state?.status === 'active'}
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
            />

            <Typography variant="subtitle2" sx={{ mb: 1 }}>
              Human participation
            </Typography>
            <FormControl fullWidth size="small" sx={{ mb: 2 }}>
              <InputLabel>Access</InputLabel>
              <Select
                value={humanParticipation}
                label="Access"
                onChange={(e) => setHumanParticipation(e.target.value)}
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
              disabled={!schedule.enabled}
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
              disabled={!schedule.enabled}
            />

            <Button
              variant="contained"
              size="small"
              onClick={handleSaveConfig}
              disabled={!isPodAdmin || saving}
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
                disabled={actionLoading || state?.status === 'active'}
              >
                Start discussion
              </Button>
              <Button
                variant="outlined"
                onClick={handlePause}
                disabled={actionLoading || state?.status !== 'active'}
              >
                Pause discussion
              </Button>
              <Button
                variant="outlined"
                onClick={handleResume}
                disabled={actionLoading || state?.status !== 'paused'}
              >
                Resume discussion
              </Button>
              <Button
                variant="text"
                color="error"
                onClick={handleComplete}
                disabled={actionLoading || !state || state.status === 'completed'}
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
