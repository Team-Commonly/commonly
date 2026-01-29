/**
 * AgentsHub Page
 *
 * The "app store" for AI agents - discover, install, and manage agents.
 */

import React, { useState, useEffect } from 'react';
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
  Skeleton,
  Alert,
  Divider,
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
} from '@mui/material';
import {
  Search as SearchIcon,
  FilterList as FilterIcon,
  TrendingUp as TrendingIcon,
  Star as StarIcon,
  Add as AddIcon,
  Refresh as RefreshIcon,
  ContentCopy as CopyIcon,
} from '@mui/icons-material';
import AgentCard from './AgentCard';
import axios from 'axios';

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
  const [searchQuery, setSearchQuery] = useState('');
  const [activeTab, setActiveTab] = useState(0);
  const [category, setCategory] = useState('all');
  const [agents, setAgents] = useState([]);
  const [installedAgents, setInstalledAgents] = useState([]);
  const [userPods, setUserPods] = useState([]);
  const [selectedPodId, setSelectedPodId] = useState(propPodId);
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

  const getAuthHeaders = () => {
    const token = localStorage.getItem('token');
    return { 'x-auth-token': token };
  };

  // Fetch user's pods for pod selector
  useEffect(() => {
    const fetchUserPods = async () => {
      try {
        const response = await axios.get('/api/pods', {
          headers: getAuthHeaders(),
        });
        setUserPods(response.data || []);
        // Auto-select first pod if none selected
        if (!selectedPodId && response.data?.length > 0) {
          setSelectedPodId(response.data[0]._id);
        }
      } catch (err) {
        console.error('Error fetching user pods:', err);
      }
    };
    fetchUserPods();
  }, []);

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

      const response = await axios.get(`/api/registry/agents?${params}`, {
        headers: getAuthHeaders(),
      });
      const fetchedAgents = response.data.agents || [];

      if (fetchedAgents.length === 0) {
        // Auto-seed if no agents exist
        await seedAgents();
      } else {
        setAgents(fetchedAgents);
      }
    } catch (err) {
      console.error('Error fetching agents:', err);
      setError('Failed to load agents');
      setAgents(getMockAgents());
    } finally {
      setLoading(false);
    }
  };

  const seedAgents = async () => {
    setSeeding(true);
    try {
      await axios.post('/api/registry/seed', {}, {
        headers: getAuthHeaders(),
      });
      // Re-fetch after seeding
      const response = await axios.get('/api/registry/agents', {
        headers: getAuthHeaders(),
      });
      setAgents(response.data.agents || getMockAgents());
    } catch (err) {
      console.error('Error seeding agents:', err);
      setAgents(getMockAgents());
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

  const handleInstall = async (agent) => {
    if (!selectedPodId) {
      alert('Please select a pod first');
      return;
    }

    try {
      await axios.post('/api/registry/install', {
        agentName: agent.name,
        podId: selectedPodId,
        scopes: ['context:read', 'search:read'],
      }, {
        headers: getAuthHeaders(),
      });
      fetchInstalledAgents();
    } catch (err) {
      console.error('Error installing agent:', err);
      alert(err.response?.data?.error || 'Failed to install agent');
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

  const trendingAgents = agents.slice(0, 3);
  const allAgents = agents;

  const openConfigDialog = (agent) => {
    setConfigAgent(agent);
    setConfigModel(agent?.profile?.modelPreferences?.preferred || 'gemini-2.0-flash');
    setRuntimeTokenValue('');
    setRuntimeTokenLabel('Local dev');
    setConfigOpen(true);
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
    <Container maxWidth="xl" sx={{ py: 4 }}>
      {/* Header */}
      <Box sx={{ mb: 4, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <Box>
          <Typography variant="h4" fontWeight={700} gutterBottom>
            Agent Hub
          </Typography>
          <Typography variant="body1" color="text.secondary">
            Discover and install AI agents to supercharge your pods
          </Typography>
        </Box>

        {/* Pod Selector */}
        <FormControl sx={{ minWidth: 200 }} size="small">
          <InputLabel>Install to Pod</InputLabel>
          <Select
            value={selectedPodId || ''}
            label="Install to Pod"
            onChange={(e) => setSelectedPodId(e.target.value)}
          >
            {userPods.map((pod) => (
              <MenuItem key={pod._id} value={pod._id}>
                {pod.name}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
      </Box>

      {seeding && (
        <Alert severity="info" sx={{ mb: 2 }}>
          Setting up agent registry...
        </Alert>
      )}

      <Alert severity="info" sx={{ mb: 3 }}>
        Looking for webhook apps or integrations? Browse the Apps Marketplace.
        <Button href="/apps" size="small" sx={{ ml: 1 }}>
          Open Apps
        </Button>
      </Alert>

      {/* Search Bar */}
      <Box sx={{ mb: 4 }}>
        <TextField
          fullWidth
          placeholder="Search agents..."
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
            maxWidth: 600,
            '& .MuiOutlinedInput-root': {
              borderRadius: 3,
              backgroundColor: theme.palette.background.paper,
            },
          }}
        />
      </Box>

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
          {/* Categories */}
          <Box sx={{ display: 'flex', gap: 1, mb: 4, flexWrap: 'wrap' }}>
            {categories.map((cat) => (
              <Chip
                key={cat.id}
                label={cat.label}
                onClick={() => setCategory(cat.id)}
                color={category === cat.id ? 'primary' : 'default'}
                variant={category === cat.id ? 'filled' : 'outlined'}
                sx={{ fontWeight: 500 }}
              />
            ))}
          </Box>

          {/* Trending Section */}
          {!searchQuery && category === 'all' && (
            <Box sx={{ mb: 5 }}>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2 }}>
                <TrendingIcon color="secondary" />
                <Typography variant="h6" fontWeight={600}>
                  Trending This Week
                </Typography>
              </Box>
              <Grid container spacing={3}>
                {loading
                  ? [1, 2, 3].map((i) => (
                      <Grid item xs={12} md={4} key={i}>
                        <AgentCard loading />
                      </Grid>
                    ))
                  : trendingAgents.map((agent) => (
                      <Grid item xs={12} md={4} key={agent.name}>
                        <AgentCard
                          agent={agent}
                          variant="featured"
                          installed={isInstalled(agent.name)}
                          onInstall={handleInstall}
                          onRemove={handleRemove}
                        />
                      </Grid>
                    ))}
              </Grid>
            </Box>
          )}

          {/* All Agents */}
          <Box>
            <Typography variant="h6" fontWeight={600} sx={{ mb: 2 }}>
              {searchQuery ? `Results for "${searchQuery}"` : 'All Agents'}
            </Typography>
            <Grid container spacing={2}>
              {loading
                ? [1, 2, 3, 4, 5, 6].map((i) => (
                    <Grid item xs={12} sm={6} md={4} lg={3} key={i}>
                      <AgentCard loading />
                    </Grid>
                  ))
                : allAgents.map((agent) => (
                    <Grid item xs={12} sm={6} md={4} lg={3} key={agent.name}>
                      <AgentCard
                        agent={agent}
                        installed={isInstalled(agent.name)}
                        onInstall={handleInstall}
                        onRemove={handleRemove}
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
            <Grid container spacing={2}>
              {installedAgents.map((agent) => (
                <Grid item xs={12} sm={6} md={4} key={agent.name}>
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
                  />
                </Grid>
              ))}
            </Grid>
          )}
        </Box>
      )}

      <Dialog open={configOpen} onClose={closeConfigDialog} fullWidth maxWidth="xs">
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
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={closeConfigDialog}>Cancel</Button>
          <Button variant="contained" onClick={saveConfig} disabled={configSaving}>
            Save
          </Button>
        </DialogActions>
      </Dialog>
    </Container>
  );
};

// Mock data for demo
const getMockAgents = () => [
  {
    name: 'moltbot',
    displayName: 'Moltbot',
    description: 'Your personal AI assistant across all messaging platforms',
    type: 'personal',
    verified: true,
    rating: 4.8,
    ratingCount: 156,
    installs: 2300,
    capabilities: ['personal-assistant', 'multi-channel', 'voice', 'browser-control'],
    stats: { podsJoined: 12, messagesProcessed: 4200 },
  },
  {
    name: 'code-reviewer',
    displayName: 'Code Reviewer',
    description: 'Automated code review with security scanning and best practices',
    type: 'utility',
    verified: true,
    rating: 4.9,
    ratingCount: 89,
    installs: 1800,
    capabilities: ['code-review', 'security-scan', 'linting', 'suggestions'],
    stats: { podsJoined: 8, messagesProcessed: 1500 },
  },
  {
    name: 'meeting-notes',
    displayName: 'Meeting Notes',
    description: 'Automatically summarize meetings and extract action items',
    type: 'productivity',
    verified: true,
    rating: 4.7,
    ratingCount: 234,
    installs: 3100,
    capabilities: ['transcription', 'summarization', 'action-items', 'follow-ups'],
    stats: { podsJoined: 25, messagesProcessed: 8900 },
  },
  {
    name: 'analytics-bot',
    displayName: 'Analytics Bot',
    description: 'Track team metrics, generate reports, and visualize data',
    type: 'analytics',
    verified: false,
    rating: 4.5,
    ratingCount: 67,
    installs: 890,
    capabilities: ['metrics', 'reports', 'charts', 'trends'],
    stats: { podsJoined: 6, messagesProcessed: 2100 },
  },
  {
    name: 'support-bot',
    displayName: 'Support Bot',
    description: 'Handle customer inquiries with knowledge base integration',
    type: 'support',
    verified: true,
    rating: 4.6,
    ratingCount: 178,
    installs: 1500,
    capabilities: ['customer-support', 'knowledge-base', 'ticket-routing', 'escalation'],
    stats: { podsJoined: 15, messagesProcessed: 12000 },
  },
  {
    name: 'standup-bot',
    displayName: 'Standup Bot',
    description: 'Automate daily standups and track team progress',
    type: 'productivity',
    verified: false,
    rating: 4.3,
    ratingCount: 45,
    installs: 650,
    capabilities: ['standups', 'reminders', 'progress-tracking', 'blockers'],
    stats: { podsJoined: 10, messagesProcessed: 3500 },
  },
];

export default AgentsHub;
