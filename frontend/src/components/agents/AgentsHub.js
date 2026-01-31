/**
 * AgentsHub Page
 *
 * The "app store" for AI agents - discover, install, and manage agents.
 */

import React, { useState, useEffect, useMemo } from 'react';
import {
  Box,
  Container,
  Typography,
  TextField,
  InputAdornment,
  Grid,
  Tabs,
  Tab,
  Chip,
  Button,
  IconButton,
  Alert,
  Divider,
  Paper,
  alpha,
  useTheme,
  FormControl,
  Select,
  MenuItem,
  InputLabel,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Tooltip,
  FormGroup,
  FormControlLabel,
  Checkbox,
} from '@mui/material';
import {
  Search as SearchIcon,
  ContentCopy as CopyIcon,
} from '@mui/icons-material';
import AgentCard from './AgentCard';
import ClawdbotConfigPanel from './ClawdbotConfigPanel';
import axios from 'axios';
import { useAuth } from '../../context/AuthContext';
import { useLocation } from 'react-router-dom';

const categories = [
  { id: 'all', label: 'All Agents' },
  { id: 'productivity', label: 'Productivity' },
  { id: 'development', label: 'Development' },
  { id: 'analytics', label: 'Analytics' },
  { id: 'support', label: 'Support' },
  { id: 'communication', label: 'Communication' },
];

const AgentsHub = ({ currentPodId: propPodId = null }) => {
  const theme = useTheme();
  const location = useLocation();
  const { currentUser } = useAuth();
  const [searchQuery, setSearchQuery] = useState('');
  const [activeTab, setActiveTab] = useState(0);
  const [category, setCategory] = useState('all');
  const [agents, setAgents] = useState([]);
  const [installedAgents, setInstalledAgents] = useState([]);
  const [userPods, setUserPods] = useState([]);
  const queryPodId = useMemo(() => {
    const params = new URLSearchParams(location.search);
    return params.get('podId');
  }, [location.search]);
  const [selectedPodId, setSelectedPodId] = useState(propPodId || queryPodId);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [seeding, setSeeding] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  const [configAgent, setConfigAgent] = useState(null);
  const [configModel, setConfigModel] = useState('gemini-2.0-flash');
  const [configSaving, setConfigSaving] = useState(false);
  const [runtimeTokens, setRuntimeTokens] = useState([]);
  const [runtimeTokenLabel, setRuntimeTokenLabel] = useState('Local dev');
  const [runtimeTokenValue, setRuntimeTokenValue] = useState('');
  const [runtimeTokenLoading, setRuntimeTokenLoading] = useState(false);
  const [runtimeTokenRevokingId, setRuntimeTokenRevokingId] = useState(null);
  const [installDialogOpen, setInstallDialogOpen] = useState(false);
  const [installAgent, setInstallAgent] = useState(null);
  const [installPodIds, setInstallPodIds] = useState([]);
  const [installSaving, setInstallSaving] = useState(false);
  const [clawdbotGatewayStatus, setClawdbotGatewayStatus] = useState(null);

  const getAuthHeaders = () => {
    const token = localStorage.getItem('token');
    return { 'x-auth-token': token };
  };

  const currentUserId = currentUser?._id || currentUser?.id || null;

  const normalizePodCreatorId = (pod) => (
    pod?.createdBy?._id || pod?.createdBy || null
  );

  const isPodAdmin = (pod) => {
    if (!currentUserId || !pod) return false;
    const creatorId = normalizePodCreatorId(pod);
    return creatorId?.toString?.() === currentUserId.toString();
  };

  const accessiblePods = useMemo(() => {
    if (!currentUserId) return userPods;
    return (userPods || []).filter((pod) => {
      const creatorId = normalizePodCreatorId(pod);
      if (creatorId?.toString?.() === currentUserId.toString()) return true;
      const memberIds = (pod.members || []).map((m) => m?._id || m).filter(Boolean);
      return memberIds.some((id) => id.toString?.() === currentUserId.toString());
    });
  }, [userPods, currentUserId]);

  useEffect(() => {
    if (propPodId) {
      setSelectedPodId(propPodId);
      return;
    }
    if (queryPodId) {
      setSelectedPodId(queryPodId);
    }
  }, [propPodId, queryPodId]);

  // Fetch user's pods for pod selector
  useEffect(() => {
    const fetchUserPods = async () => {
      try {
        const response = await axios.get('/api/pods', {
          headers: getAuthHeaders(),
        });
        setUserPods(response.data || []);
      } catch (err) {
        console.error('Error fetching user pods:', err);
      }
    };
    fetchUserPods();
  }, [currentUserId]);

  useEffect(() => {
    if (!selectedPodId && accessiblePods.length > 0) {
      setSelectedPodId(accessiblePods[0]._id);
    }
  }, [selectedPodId, accessiblePods]);

  // Fetch agents from registry
  useEffect(() => {
    fetchAgents();
  }, [category, searchQuery]);

  // Fetch installed agents for selected pod
  useEffect(() => {
    if (selectedPodId) {
      fetchInstalledAgents();
    }
  }, [selectedPodId]);

  const fetchAgents = async () => {
    setLoading(true);
    setError(null);

    try {
      const params = new URLSearchParams();
      if (searchQuery) params.append('q', searchQuery);
      if (category !== 'all') params.append('category', category);
      params.append('registry', 'commonly-official');
      params.append('verified', 'true');

      const response = await axios.get(`/api/registry/agents?${params.toString()}`, {
        headers: getAuthHeaders(),
      });
      const fetchedAgents = response.data.agents || [];

      const hasCommonlyBot = fetchedAgents.some((agent) => agent.name === 'commonly-bot');
      const shouldSeedDefaults = !searchQuery && category === 'all' && !hasCommonlyBot;

      if (fetchedAgents.length === 0 || shouldSeedDefaults) {
        // Auto-seed if registry is empty or missing Commonly Bot (default view only)
        await seedAgents(params);
      } else {
        setAgents(fetchedAgents);
      }
    } catch (err) {
      console.error('Error fetching agents:', err);
      setError('Failed to load agents');
      setAgents([]);
    } finally {
      setLoading(false);
    }
  };

  const seedAgents = async (params = new URLSearchParams()) => {
    setSeeding(true);
    try {
      await axios.post('/api/registry/seed', {}, {
        headers: getAuthHeaders(),
      });
      // Re-fetch after seeding
      const response = await axios.get(`/api/registry/agents?${params.toString()}`, {
        headers: getAuthHeaders(),
      });
      setAgents(response.data.agents || []);
    } catch (err) {
      console.error('Error seeding agents:', err);
      setAgents([]);
    } finally {
      setSeeding(false);
    }
  };

  const fetchInstalledAgents = async () => {
    try {
      const response = await axios.get(`/api/registry/pods/${selectedPodId}/agents`, {
        headers: getAuthHeaders(),
      });
      setInstalledAgents(response.data.agents || []);
    } catch (err) {
      console.error('Error fetching installed agents:', err);
    }
  };

  const fetchClawdbotStatus = async () => {
    try {
      const response = await axios.get('/api/health/clawdbot', {
        headers: getAuthHeaders(),
      });
      const data = response.data;
      setClawdbotGatewayStatus({
        connected: data.status === 'connected',
        channels: data.channels || [],
        gateway: data.gateway,
        version: data.version,
      });
    } catch (err) {
      console.error('Error fetching Clawdbot status:', err);
      setClawdbotGatewayStatus({ connected: false, channels: [] });
    }
  };

  const openInstallDialog = (agent) => {
    const defaultPodId = selectedPodId
      || accessiblePods[0]?._id
      || userPods[0]?._id
      || null;
    setInstallAgent(agent);
    setInstallPodIds(defaultPodId ? [defaultPodId] : []);
    setInstallDialogOpen(true);
  };

  const closeInstallDialog = () => {
    setInstallDialogOpen(false);
    setInstallAgent(null);
    setInstallPodIds([]);
  };

  const handleInstall = async () => {
    if (!installAgent) return;
    if (installPodIds.length === 0) {
      alert('Select at least one pod to install this agent.');
      return;
    }

    setInstallSaving(true);
    try {
      const agentName = installAgent.name || installAgent.agentName;
      const agentDetails = await axios.get(`/api/registry/agents/${agentName}`, {
        headers: getAuthHeaders(),
      });
      const requiredScopes = agentDetails.data?.manifest?.context?.required || [];
      const installScopes = requiredScopes.length > 0 ? requiredScopes : ['context:read'];

      const results = await Promise.allSettled(
        installPodIds.map((podId) => (
          axios.post('/api/registry/install', {
            agentName,
            podId,
            scopes: installScopes,
          }, {
            headers: getAuthHeaders(),
          })
        )),
      );

      const failures = results.filter((result) => result.status === 'rejected');
      if (failures.length > 0) {
        const firstError = failures[0].reason?.response?.data?.error;
        alert(firstError || `Failed to install on ${failures.length} pod(s).`);
      }

      if (installPodIds.includes(selectedPodId)) {
        fetchInstalledAgents();
      }
      closeInstallDialog();
    } catch (err) {
      console.error('Error installing agent:', err);
      alert(err.response?.data?.error || 'Failed to install agent');
    } finally {
      setInstallSaving(false);
    }
  };

  const handleRemove = async (agent) => {
    if (!selectedPodId) return;

    try {
      await axios.delete(`/api/registry/agents/${agent.name}/pods/${selectedPodId}`, {
        headers: getAuthHeaders(),
      });
      fetchInstalledAgents();
    } catch (err) {
      console.error('Error removing agent:', err);
      alert('Failed to remove agent');
    }
  };

  const currentPodId = selectedPodId;

  const modelOptions = [
    { value: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash (default)' },
    { value: 'gemini-1.5-pro', label: 'Gemini 1.5 Pro' },
  ];

  const isInstalled = (agentName) => {
    return installedAgents.some((a) => a.name === agentName);
  };

  const getInstallation = (agentName) => {
    return installedAgents.find((a) => a.name === agentName) || null;
  };

  const selectedPod = (accessiblePods.length > 0 ? accessiblePods : userPods)
    .find((pod) => pod._id === selectedPodId) || null;
  const canRemoveInSelectedPod = selectedPod ? isPodAdmin(selectedPod) : false;
  const allAgents = agents;

  const openConfigDialog = (agent) => {
    setConfigAgent(agent);
    setConfigModel(agent?.profile?.modelPreferences?.preferred || 'gemini-2.0-flash');
    setRuntimeTokenValue('');
    setRuntimeTokenLabel('Local dev');
    setConfigOpen(true);
    // Fetch Clawdbot gateway status if opening clawdbot-bridge config
    if (agent?.name === 'clawdbot-bridge') {
      fetchClawdbotStatus();
    }
  };

  const closeConfigDialog = () => {
    setConfigOpen(false);
    setConfigAgent(null);
    setRuntimeTokens([]);
    setRuntimeTokenValue('');
  };

  useEffect(() => {
    const fetchRuntimeTokens = async () => {
      if (!configOpen || !configAgent || !selectedPodId) return;
      setRuntimeTokenLoading(true);
      try {
        const response = await axios.get(
          `/api/registry/pods/${selectedPodId}/agents/${configAgent.name}/runtime-tokens`,
          { headers: getAuthHeaders() },
        );
        setRuntimeTokens(response.data.tokens || []);
      } catch (err) {
        console.error('Error fetching runtime tokens:', err);
        setRuntimeTokens([]);
      } finally {
        setRuntimeTokenLoading(false);
      }
    };
    fetchRuntimeTokens();
  }, [configOpen, configAgent, selectedPodId]);

  const handleGenerateRuntimeToken = async () => {
    if (!configAgent || !selectedPodId) return;
    setRuntimeTokenLoading(true);
    try {
      const response = await axios.post(
        `/api/registry/pods/${selectedPodId}/agents/${configAgent.name}/runtime-tokens`,
        { label: runtimeTokenLabel },
        { headers: getAuthHeaders() },
      );
      setRuntimeTokenValue(response.data.token || '');
      const refresh = await axios.get(
        `/api/registry/pods/${selectedPodId}/agents/${configAgent.name}/runtime-tokens`,
        { headers: getAuthHeaders() },
      );
      setRuntimeTokens(refresh.data.tokens || []);
    } catch (err) {
      console.error('Error issuing runtime token:', err);
      alert('Failed to issue runtime token');
    } finally {
      setRuntimeTokenLoading(false);
    }
  };

  const handleRevokeRuntimeToken = async (tokenId) => {
    if (!configAgent || !selectedPodId || !tokenId) return;
    setRuntimeTokenRevokingId(tokenId);
    try {
      await axios.delete(
        `/api/registry/pods/${selectedPodId}/agents/${configAgent.name}/runtime-tokens/${tokenId}`,
        { headers: getAuthHeaders() },
      );
      const refresh = await axios.get(
        `/api/registry/pods/${selectedPodId}/agents/${configAgent.name}/runtime-tokens`,
        { headers: getAuthHeaders() },
      );
      setRuntimeTokens(refresh.data.tokens || []);
    } catch (err) {
      console.error('Error revoking runtime token:', err);
      alert('Failed to revoke runtime token');
    } finally {
      setRuntimeTokenRevokingId(null);
    }
  };

  const handleCopyToken = async () => {
    if (!runtimeTokenValue) return;
    try {
      await navigator.clipboard.writeText(runtimeTokenValue);
    } catch (err) {
      console.warn('Clipboard copy failed:', err);
    }
  };

  const saveConfig = async () => {
    if (!configAgent || !selectedPodId) {
      return;
    }
    setConfigSaving(true);
    try {
      await axios.patch(`/api/registry/pods/${selectedPodId}/agents/${configAgent.name}`, {
        modelPreferences: { preferred: configModel },
      }, {
        headers: getAuthHeaders(),
      });
      await fetchInstalledAgents();
      closeConfigDialog();
    } catch (err) {
      console.error('Error updating agent model preferences:', err);
      alert('Failed to update agent configuration');
    } finally {
      setConfigSaving(false);
    }
  };

  return (
    <Container
      maxWidth="xl"
      disableGutters
      sx={{ py: { xs: 3, md: 4 }, px: { xs: 2, sm: 3, md: 4 } }}
    >
      <Box
        sx={{
          mb: 3,
          display: 'flex',
          flexDirection: { xs: 'column', md: 'row' },
          justifyContent: 'space-between',
          alignItems: { xs: 'flex-start', md: 'center' },
          gap: 2,
        }}
      >
        <Box>
          <Typography variant="h4" fontWeight={700} gutterBottom>
            Agent Hub
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Discover, install, and manage pod-native agents.
          </Typography>
        </Box>

        <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
          <Button href="/apps" variant="outlined" size="small">
            Apps Marketplace
          </Button>
          <Button
            variant="contained"
            size="small"
            onClick={() => setActiveTab(1)}
            disabled={!selectedPodId}
          >
            Manage Installed
          </Button>
        </Box>
      </Box>

      <Paper
        variant="outlined"
        sx={{
          p: { xs: 2, md: 2.5 },
          mb: 3,
          borderRadius: 3,
          backgroundColor: alpha(theme.palette.primary.main, 0.02),
        }}
      >
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: { xs: '1fr', md: '2fr 1fr 1fr' },
            gap: 2,
          }}
        >
          <TextField
            fullWidth
            placeholder="Search agents by name or capability..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            InputProps={{
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon color="action" />
                </InputAdornment>
              ),
            }}
            sx={{
              '& .MuiOutlinedInput-root': {
                borderRadius: 2,
                backgroundColor: theme.palette.background.paper,
              },
            }}
          />
          <FormControl size="small" fullWidth>
            <InputLabel>Category</InputLabel>
            <Select
              value={category}
              label="Category"
              onChange={(e) => setCategory(e.target.value)}
            >
              {categories.map((cat) => (
                <MenuItem key={cat.id} value={cat.id}>
                  {cat.label}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
          <FormControl size="small" fullWidth>
            <InputLabel>Install to Pod</InputLabel>
            <Select
              value={selectedPodId || ''}
              label="Install to Pod"
              onChange={(e) => setSelectedPodId(e.target.value)}
            >
              {(accessiblePods.length > 0 ? accessiblePods : userPods).map((pod) => (
                <MenuItem key={pod._id} value={pod._id}>
                  {pod.name}
                  {isPodAdmin(pod) ? ' (Admin)' : ''}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
        </Box>
        <Box
          sx={{
            mt: 2,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: 1,
          }}
        >
          <Typography variant="caption" color="text.secondary">
            {allAgents.length} agents • {installedAgents.length} installed
          </Typography>
          {seeding && (
            <Chip
              size="small"
              label="Setting up agent registry..."
              color="info"
              variant="outlined"
            />
          )}
        </Box>
      </Paper>

      {/* Tabs */}
      <Box sx={{ borderBottom: 1, borderColor: 'divider', mb: 3 }}>
        <Tabs value={activeTab} onChange={(e, v) => setActiveTab(v)}>
          <Tab label="Discover" />
          <Tab label={`Installed ${installedAgents.length > 0 ? `(${installedAgents.length})` : ''}`} />
        </Tabs>
      </Box>

      {error && (
        <Alert severity="warning" sx={{ mb: 3 }}>
          {error}
        </Alert>
      )}

      {/* Discover Tab */}
      {activeTab === 0 && (
        <>
          <Box>
            <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 2 }}>
              <Typography variant="h6" fontWeight={600}>
              {searchQuery ? `Results for "${searchQuery}"` : 'All Agents'}
              </Typography>
              <Chip
                size="small"
                label={`${allAgents.length} agents`}
                variant="outlined"
                sx={{ fontWeight: 600 }}
              />
            </Box>
            <Grid container spacing={3}>
              {loading
                ? [1, 2, 3, 4, 5, 6].map((i) => (
                    <Grid item xs={12} sm={6} md={4} lg={4} key={i}>
                      <AgentCard loading />
                    </Grid>
                  ))
                : allAgents.map((agent) => (
                    <Grid item xs={12} sm={6} md={4} lg={4} key={agent.name}>
                    <AgentCard
                      agent={agent}
                      installed={isInstalled(agent.name)}
                      onInstall={openInstallDialog}
                      onConfigure={openConfigDialog}
                      onRemove={handleRemove}
                      canRemove={canRemoveInSelectedPod || getInstallation(agent.name)?.installedBy === currentUserId}
                    />
                    </Grid>
                  ))}
            </Grid>
            {!loading && allAgents.length === 0 && (
              <Box sx={{ textAlign: 'center', py: 8 }}>
                <Typography color="text.secondary">No agents found</Typography>
              </Box>
            )}
          </Box>
        </>
      )}

      {/* Installed Tab */}
      {activeTab === 1 && (
        <Box>
          {!currentPodId ? (
            <Alert severity="info">Select a pod to view installed agents</Alert>
          ) : installedAgents.length === 0 ? (
            <Box sx={{ textAlign: 'center', py: 8 }}>
              <Typography variant="h6" gutterBottom>
                No agents installed yet
              </Typography>
              <Typography color="text.secondary" sx={{ mb: 3 }}>
                Browse the catalog and install agents to get started
              </Typography>
              <Button variant="contained" onClick={() => setActiveTab(0)}>
                Browse Agents
              </Button>
            </Box>
          ) : (
            <Grid container spacing={3}>
              {installedAgents.map((agent) => (
                <Grid item xs={12} sm={6} md={4} lg={4} key={agent.name}>
                  <AgentCard
                    agent={{
                      name: agent.name,
                      displayName: agent.profile?.displayName || agent.name,
                      description: agent.profile?.purpose || '',
                      version: agent.version,
                      stats: agent.usage,
                      profile: agent.profile,
                    }}
                    installed
                    onConfigure={openConfigDialog}
                    onRemove={handleRemove}
                    canRemove={canRemoveInSelectedPod || agent.installedBy === currentUserId}
                  />
                </Grid>
              ))}
            </Grid>
          )}
        </Box>
      )}

      <Dialog open={configOpen} onClose={closeConfigDialog} fullWidth maxWidth={configAgent?.name === 'clawdbot-bridge' ? 'sm' : 'xs'}>
        <DialogTitle>Agent Settings</DialogTitle>
        <DialogContent sx={{ pt: 2 }}>
          <FormControl fullWidth>
            <InputLabel id="agent-model-label">Model</InputLabel>
            <Select
              labelId="agent-model-label"
              label="Model"
              value={configModel}
              onChange={(e) => setConfigModel(e.target.value)}
            >
              {modelOptions.map((option) => (
                <MenuItem key={option.value} value={option.value}>
                  {option.label}
                </MenuItem>
              ))}
            </Select>
          </FormControl>

          <Divider sx={{ my: 3 }} />

          {/* Clawdbot-specific configuration panel */}
          {configAgent?.name === 'clawdbot-bridge' ? (
            <ClawdbotConfigPanel
              runtimeTokens={runtimeTokens}
              runtimeTokenValue={runtimeTokenValue}
              onGenerateToken={handleGenerateRuntimeToken}
              onRevokeToken={handleRevokeRuntimeToken}
              tokenLoading={runtimeTokenLoading}
              gatewayStatus={clawdbotGatewayStatus}
              onRefreshStatus={fetchClawdbotStatus}
            />
          ) : (
            <>
              <Typography variant="subtitle2" sx={{ mb: 1 }}>
                Runtime Token
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                Generate a token for external agent runtimes (shown once).
              </Typography>
              <TextField
                fullWidth
                label="Label"
                value={runtimeTokenLabel}
                onChange={(e) => setRuntimeTokenLabel(e.target.value)}
                size="small"
                sx={{ mb: 2 }}
              />
              <Button
                variant="outlined"
                onClick={handleGenerateRuntimeToken}
                disabled={runtimeTokenLoading}
                fullWidth
                sx={{ mb: 2 }}
              >
                Generate Runtime Token
              </Button>
              {runtimeTokenValue && (
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2 }}>
                  <TextField
                    fullWidth
                    label="Token"
                    value={runtimeTokenValue}
                    size="small"
                    InputProps={{ readOnly: true }}
                  />
                  <Tooltip title="Copy">
                    <IconButton onClick={handleCopyToken}>
                      <CopyIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                </Box>
              )}
              {runtimeTokens.length > 0 && (
                <Box sx={{ mb: 1 }}>
                  <Typography variant="caption" color="text.secondary">
                    Issued tokens: {runtimeTokens.length}
                  </Typography>
                </Box>
              )}
              {runtimeTokens.length > 0 && (
                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
                  {runtimeTokens.map((token) => (
                    <Box
                      key={token.id || token.label}
                      sx={{
                        border: `1px solid ${alpha(theme.palette.primary.main, 0.12)}`,
                        borderRadius: 1.5,
                        p: 1.5,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: 1.5,
                      }}
                    >
                      <Box sx={{ minWidth: 0 }}>
                        <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
                          {token.label || 'Runtime token'}
                        </Typography>
                        <Typography variant="caption" color="text.secondary">
                          Issued {token.createdAt ? new Date(token.createdAt).toLocaleString() : 'unknown'}
                          {token.lastUsedAt ? ` • Last used ${new Date(token.lastUsedAt).toLocaleString()}` : ''}
                        </Typography>
                      </Box>
                      <Button
                        variant="text"
                        color="error"
                        size="small"
                        onClick={() => handleRevokeRuntimeToken(token.id)}
                        disabled={!token.id || runtimeTokenRevokingId === token.id}
                      >
                        {runtimeTokenRevokingId === token.id ? 'Revoking...' : 'Revoke'}
                      </Button>
                    </Box>
                  ))}
                </Box>
              )}
            </>
          )}
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={closeConfigDialog}>Cancel</Button>
          <Button variant="contained" onClick={saveConfig} disabled={configSaving}>
            Save
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={installDialogOpen} onClose={closeInstallDialog} fullWidth maxWidth="xs">
        <DialogTitle>Select pods for install</DialogTitle>
        <DialogContent sx={{ pt: 2 }}>
          {accessiblePods.length === 0 && userPods.length === 0 ? (
            <Alert severity="info">Join or create a pod to install agents.</Alert>
          ) : (
            <FormGroup>
              {(accessiblePods.length > 0 ? accessiblePods : userPods).map((pod) => (
                <FormControlLabel
                  key={pod._id}
                  control={(
                    <Checkbox
                      checked={installPodIds.includes(pod._id)}
                      onChange={(e) => {
                        setInstallPodIds((prev) => {
                          if (e.target.checked) {
                            return Array.from(new Set([...prev, pod._id]));
                          }
                          return prev.filter((id) => id !== pod._id);
                        });
                      }}
                    />
                  )}
                  label={`${pod.name}${isPodAdmin(pod) ? ' (Admin)' : ''}`}
                />
              ))}
            </FormGroup>
          )}
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={closeInstallDialog}>Cancel</Button>
          <Button
            variant="contained"
            onClick={handleInstall}
            disabled={installSaving || installPodIds.length === 0}
          >
            Install
          </Button>
        </DialogActions>
      </Dialog>
    </Container>
  );
};

export default AgentsHub;
