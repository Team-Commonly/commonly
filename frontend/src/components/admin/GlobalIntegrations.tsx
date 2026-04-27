import React, { useState, useEffect } from 'react';
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Box,
  Card,
  CardContent,
  Typography,
  TextField,
  Button,
  Alert,
  CircularProgress,
  Grid,
  Chip,
  IconButton,
  Stack,
  Tooltip,
  Divider,
  Switch,
  FormControlLabel,
  FormControl,
  InputLabel,
  Select,
  MenuItem
} from '@mui/material';
import {
  Save as SaveIcon,
  Refresh as RefreshIcon,
  Check as CheckIcon,
  Error as ErrorIcon,
  Twitter as TwitterIcon,
  Instagram as InstagramIcon,
  ExpandMore as ExpandMoreIcon,
  Tune as TuneIcon,
  Public as PublicIcon,
} from '@mui/icons-material';
import axios from 'axios';
import { useLocation, useNavigate } from 'react-router-dom';
import { useV2Embedded } from '../../v2/hooks/useV2Embedded';

const XIcon = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
    <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/>
  </svg>
);

const GEMINI_MODELS = [
  { value: 'google/gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
  { value: 'google/gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash Lite' },
  { value: 'google/gemini-2.0-flash', label: 'Gemini 2.0 Flash' },
];

const OPENAI_MODELS = [
  { value: 'openai/gpt-5.4', label: 'GPT-5.4' },
  { value: 'openai/gpt-4o', label: 'GPT-4o' },
  { value: 'openai/gpt-4o-mini', label: 'GPT-4o Mini' },
  { value: 'openai/gpt-4.1', label: 'GPT-4.1' },
];

const ANTHROPIC_MODELS = [
  { value: 'anthropic/claude-opus-4-6', label: 'Claude Opus 4.6' },
  { value: 'anthropic/claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
  { value: 'anthropic/claude-haiku-4-5', label: 'Claude Haiku 4.5' },
];

// Backend LLM service model options (provider → model list)
const LLM_SERVICE_MODEL_OPTIONS = {
  gemini: GEMINI_MODELS,
  openai: OPENAI_MODELS,
  anthropic: ANTHROPIC_MODELS,
};

// OpenClaw gateway model options (provider → model list)
const OPENCLAW_MODEL_OPTIONS = {
  google: GEMINI_MODELS,
  'openai-codex': [
    { value: 'openai-codex/gpt-5.4', label: 'GPT-5.4 (OAuth)' },
    { value: 'openai-codex/gpt-5.3-codex', label: 'GPT-5.3 Codex (OAuth, legacy)' },
  ],
  openai: OPENAI_MODELS,
  anthropic: ANTHROPIC_MODELS,
};

const GlobalIntegrations = () => {
  const v2Embedded = useV2Embedded();
  const location = useLocation();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [applyingModelPolicy, setApplyingModelPolicy] = useState(false);
  const [connectingX, setConnectingX] = useState(false);
  const [loadingXFollowing, setLoadingXFollowing] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [socialPolicy, setSocialPolicy] = useState({
    socialMode: 'repost',
    publishEnabled: false,
    strictAttribution: true,
  });
  const [modelPolicy, setModelPolicy] = useState({
    llmService: {
      provider: 'auto',
      model: 'gemini-2.5-flash',
      openrouter: {
        baseUrl: 'https://openrouter.ai/api/v1',
        model: '',
      },
    },
    openclaw: {
      provider: 'google',
      model: 'google/gemini-2.5-flash',
      fallbackModels: ['google/gemini-2.5-flash-lite', 'google/gemini-2.0-flash'],
      devAgentIds: ['theo', 'nova', 'pixel', 'ops'],
      communityAgentModel: {
        primary: 'openrouter/nvidia/nemotron-3-super-120b-a12b:free',
        fallbacks: ['openrouter/arcee-ai/trinity-large-preview:free'],
      },
    },
  });

  // X (Twitter) state
  const [xConfig, setXConfig] = useState({
    enabled: false,
    accessToken: '',
    username: '',
    userId: '',
    followUsernames: '',
    followUserIds: '',
    followFromAuthenticatedUser: false,
    followingWhitelistUserIds: '',
    followingMaxUsers: 5,
    status: 'disconnected'
  });

  // Instagram state
  const [instagramConfig, setInstagramConfig] = useState({
    enabled: false,
    accessToken: '',
    username: '',
    igUserId: '',
    status: 'disconnected'
  });

  // Fetch current global integrations
  useEffect(() => {
    fetchIntegrations();
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(location.search || '');
    const oauthStatus = params.get('xOAuth');
    const detail = params.get('detail');
    if (!oauthStatus) return;

    if (oauthStatus === 'success') {
      setSuccess(detail ? `X OAuth connected (${detail})` : 'X OAuth connected successfully');
      setError('');
      fetchIntegrations();
    } else {
      setError(detail || 'X OAuth connection failed');
      setSuccess('');
    }
    navigate('/admin/integrations/global', { replace: true });
  }, [location.search, navigate]);

  const fetchIntegrations = async () => {
    try {
      setLoading(true);
      setError('');
      const token = localStorage.getItem('token');

      const response = await axios.get('/api/admin/integrations/global', {
        headers: { Authorization: `Bearer ${token}` }
      });

      const { x, instagram, socialPolicy: nextPolicy, modelPolicy: nextModelPolicy } = response.data;

      if (x) {
        setXConfig({
          enabled: x.status === 'connected',
          accessToken: x.config?.accessToken || '',
          username: x.config?.username || '',
          userId: x.config?.userId || '',
          followUsernames: Array.isArray(x.config?.followUsernames) ? x.config.followUsernames.join(', ') : '',
          followUserIds: Array.isArray(x.config?.followUserIds) ? x.config.followUserIds.join(', ') : '',
          followFromAuthenticatedUser: x.config?.followFromAuthenticatedUser === true,
          followingWhitelistUserIds: Array.isArray(x.config?.followingWhitelistUserIds)
            ? x.config.followingWhitelistUserIds.join(', ')
            : '',
          followingMaxUsers: Number.isFinite(Number(x.config?.followingMaxUsers))
            ? Number(x.config.followingMaxUsers)
            : 5,
          status: x.status
        });
      }

      if (instagram) {
        setInstagramConfig({
          enabled: instagram.status === 'connected',
          accessToken: instagram.config?.accessToken || '',
          username: instagram.config?.username || '',
          igUserId: instagram.config?.igUserId || '',
          status: instagram.status
        });
      }
      if (nextPolicy) {
        setSocialPolicy({
          socialMode: nextPolicy.socialMode || 'repost',
          publishEnabled: Boolean(nextPolicy.publishEnabled),
          strictAttribution: nextPolicy.strictAttribution !== false,
        });
      }
      if (nextModelPolicy) {
        setModelPolicy({
          llmService: {
            provider: nextModelPolicy?.llmService?.provider || 'auto',
            model: nextModelPolicy?.llmService?.model
              || nextModelPolicy?.llmService?.defaultModel
              || 'gemini-2.5-flash',
            openrouter: {
              baseUrl: nextModelPolicy?.llmService?.openrouter?.baseUrl || 'https://openrouter.ai/api/v1',
              model: nextModelPolicy?.llmService?.openrouter?.model || '',
            },
          },
          openclaw: {
            provider: nextModelPolicy?.openclaw?.provider || 'google',
            model: nextModelPolicy?.openclaw?.model
              || nextModelPolicy?.openclaw?.defaultModel
              || 'google/gemini-2.5-flash',
            fallbackModels: Array.isArray(nextModelPolicy?.openclaw?.fallbackModels)
              ? nextModelPolicy.openclaw.fallbackModels
              : ['google/gemini-2.5-flash-lite', 'google/gemini-2.0-flash'],
            devAgentIds: Array.isArray(nextModelPolicy?.openclaw?.devAgentIds)
              ? nextModelPolicy.openclaw.devAgentIds
              : ['theo', 'nova', 'pixel', 'ops'],
            communityAgentModel: {
              primary: nextModelPolicy?.openclaw?.communityAgentModel?.primary
                || 'openrouter/nvidia/nemotron-3-super-120b-a12b:free',
              fallbacks: Array.isArray(nextModelPolicy?.openclaw?.communityAgentModel?.fallbacks)
                ? nextModelPolicy.openclaw.communityAgentModel.fallbacks
                : ['openrouter/arcee-ai/trinity-large-preview:free'],
            },
          },
        });
      }
    } catch (err) {
      console.error('Failed to fetch integrations:', err);
      setError(err.response?.data?.error || 'Failed to load integrations');
    } finally {
      setLoading(false);
    }
  };

  const buildModelPolicyPayload = () => {
    const fallbackModels = Array.isArray(modelPolicy?.openclaw?.fallbackModels)
      ? modelPolicy.openclaw.fallbackModels
      : String(modelPolicy?.openclaw?.fallbackModels || '').split(',').map((e) => e.trim()).filter(Boolean);
    return {
      llmService: {
        provider: modelPolicy?.llmService?.provider || 'auto',
        model: modelPolicy?.llmService?.model || '',
        openrouter: {
          baseUrl: modelPolicy?.llmService?.openrouter?.baseUrl || '',
          model: modelPolicy?.llmService?.openrouter?.model || '',
        },
      },
      openclaw: {
        provider: modelPolicy?.openclaw?.provider || 'google',
        model: modelPolicy?.openclaw?.model || '',
        fallbackModels,
        devAgentIds: Array.isArray(modelPolicy?.openclaw?.devAgentIds)
          ? modelPolicy.openclaw.devAgentIds
          : String(modelPolicy?.openclaw?.devAgentIds || '').split(',').map((e) => e.trim()).filter(Boolean),
        communityAgentModel: {
          primary: modelPolicy?.openclaw?.communityAgentModel?.primary || '',
          fallbacks: Array.isArray(modelPolicy?.openclaw?.communityAgentModel?.fallbacks)
            ? modelPolicy.openclaw.communityAgentModel.fallbacks
            : String(modelPolicy?.openclaw?.communityAgentModel?.fallbacks || '').split(',').map((e) => e.trim()).filter(Boolean),
        },
      },
    };
  };

  const handleSaveModelPolicy = async () => {
    try {
      setSaving(true);
      setError('');
      setSuccess('');
      const token = localStorage.getItem('token');
      await axios.post(
        '/api/admin/integrations/global/model-policy',
        buildModelPolicyPayload(),
        { headers: { Authorization: `Bearer ${token}` } },
      );
      setSuccess('Global model policy saved.');
      await fetchIntegrations();
    } catch (err) {
      console.error('Failed to save global model policy:', err);
      setError(err.response?.data?.error || 'Failed to save global model policy');
    } finally {
      setSaving(false);
    }
  };

  const handleSaveAndApplyModelPolicy = async () => {
    try {
      setApplyingModelPolicy(true);
      setError('');
      setSuccess('');
      const token = localStorage.getItem('token');

      await axios.post(
        '/api/admin/integrations/global/model-policy',
        buildModelPolicyPayload(),
        { headers: { Authorization: `Bearer ${token}` } },
      );

      // Fire reprovision as background task — takes ~60s for 100+ agents, don't block UI
      axios.post(
        '/api/registry/admin/installations/reprovision-all',
        {},
        { headers: { Authorization: `Bearer ${token}` } },
      ).catch((reprErr) => {
        console.warn('Reprovision-all background error:', reprErr?.message);
      });

      setSuccess('Model policy saved. Agents reprovisioning in background — changes apply within 2 minutes.');
      await fetchIntegrations();
    } catch (err) {
      console.error('Failed to save/apply global model policy:', err);
      setError(err.response?.data?.error || 'Failed to save/apply global model policy');
    } finally {
      setApplyingModelPolicy(false);
    }
  };

  const handleSavePolicy = async () => {
    try {
      setSaving(true);
      setError('');
      setSuccess('');
      const token = localStorage.getItem('token');
      await axios.post('/api/admin/integrations/global/policy',
        {
          socialMode: socialPolicy.socialMode,
          publishEnabled: socialPolicy.publishEnabled,
          strictAttribution: socialPolicy.strictAttribution,
        },
        {
          headers: { Authorization: `Bearer ${token}` }
        }
      );
      setSuccess('Global social publishing policy saved.');
      await fetchIntegrations();
    } catch (err) {
      console.error('Failed to save social policy:', err);
      setError(err.response?.data?.error || 'Failed to save social policy');
    } finally {
      setSaving(false);
    }
  };

  const handleSaveX = async () => {
    try {
      setSaving(true);
      setError('');
      setSuccess('');
      const token = localStorage.getItem('token');

      await axios.post('/api/admin/integrations/global/x',
        {
          enabled: xConfig.enabled,
          accessToken: xConfig.accessToken,
          username: xConfig.username,
          userId: xConfig.userId,
          followUsernames: xConfig.followUsernames,
          followUserIds: xConfig.followUserIds,
          followFromAuthenticatedUser: xConfig.followFromAuthenticatedUser,
          followingWhitelistUserIds: xConfig.followingWhitelistUserIds,
          followingMaxUsers: xConfig.followingMaxUsers,
        },
        {
          headers: { Authorization: `Bearer ${token}` }
        }
      );

      setSuccess('X integration saved successfully!');
      await fetchIntegrations();
    } catch (err) {
      console.error('Failed to save X integration:', err);
      setError(err.response?.data?.error || 'Failed to save X integration');
    } finally {
      setSaving(false);
    }
  };

  const handleSaveInstagram = async () => {
    try {
      setSaving(true);
      setError('');
      setSuccess('');
      const token = localStorage.getItem('token');

      await axios.post('/api/admin/integrations/global/instagram',
        {
          enabled: instagramConfig.enabled,
          accessToken: instagramConfig.accessToken,
          username: instagramConfig.username,
          igUserId: instagramConfig.igUserId
        },
        {
          headers: { Authorization: `Bearer ${token}` }
        }
      );

      setSuccess('Instagram integration saved successfully!');
      await fetchIntegrations();
    } catch (err) {
      console.error('Failed to save Instagram integration:', err);
      setError(err.response?.data?.error || 'Failed to save Instagram integration');
    } finally {
      setSaving(false);
    }
  };

  const testConnection = async (type) => {
    try {
      setError('');
      const token = localStorage.getItem('token');

      await axios.post(`/api/admin/integrations/global/${type}/test`, {}, {
        headers: { Authorization: `Bearer ${token}` }
      });

      setSuccess(`${type === 'x' ? 'X' : 'Instagram'} connection test successful!`);
    } catch (err) {
      setError(err.response?.data?.error || `Failed to test ${type} connection`);
    }
  };

  const handleConnectXOAuth = async () => {
    try {
      setConnectingX(true);
      setError('');
      setSuccess('');
      const token = localStorage.getItem('token');
      const response = await axios.post(
        '/api/admin/integrations/global/x/oauth/start',
        { redirectPath: '/admin/integrations/global' },
        { headers: { Authorization: `Bearer ${token}` } },
      );
      const authorizeUrl = response?.data?.authorizeUrl;
      if (!authorizeUrl) {
        throw new Error('Missing X OAuth URL');
      }
      window.location.assign(authorizeUrl);
    } catch (err) {
      console.error('Failed to start X OAuth:', err);
      setError(err.response?.data?.error || err.message || 'Failed to start X OAuth');
      setConnectingX(false);
    }
  };

  const handleLoadXFollowingAsWhitelist = async () => {
    try {
      setLoadingXFollowing(true);
      setError('');
      const token = localStorage.getItem('token');
      const limit = Number.isFinite(Number(xConfig.followingMaxUsers))
        ? Math.min(Math.max(Math.trunc(Number(xConfig.followingMaxUsers)), 1), 100)
        : 5;
      const response = await axios.get(`/api/admin/integrations/global/x/following?limit=${limit}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const users = Array.isArray(response?.data?.users) ? response.data.users : [];
      const ids = users.map((user) => String(user?.id || '').trim()).filter(Boolean);
      setXConfig((prev) => ({
        ...prev,
        followFromAuthenticatedUser: true,
        followingWhitelistUserIds: ids.join(', '),
      }));
      setSuccess(ids.length
        ? `Loaded ${ids.length} following account IDs into whitelist`
        : 'No following accounts returned from X');
    } catch (err) {
      console.error('Failed to load X following list:', err);
      setError(err.response?.data?.error || 'Failed to load following list from X');
    } finally {
      setLoadingXFollowing(false);
    }
  };

  if (loading) {
    return (
      <Box display="flex" justifyContent="center" alignItems="center" minHeight="400px">
        <CircularProgress />
      </Box>
    );
  }

  return (
    <Box>
      {/* The v2 shell renders its own page header, so hide this legacy
          title + intro to avoid stacked headings. */}
      {!v2Embedded && (
        <>
          <Typography variant="h4" gutterBottom>
            Global Social Feed Integrations
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
            Configure global OAuth tokens for X and Instagram. These accounts will be used by all curator agents to fetch social content.
          </Typography>
        </>
      )}

      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>
          {error}
        </Alert>
      )}

      {success && (
        <Alert severity="success" sx={{ mb: 2 }} onClose={() => setSuccess('')}>
          {success}
        </Alert>
      )}

      {/* Section header: Social feed integrations.
          TODO(ui): pull non-social integrations (Chat, Email, etc.) into
          sibling sections once their data fetch is split off from this page. */}
      <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 2, mt: 1 }}>
        <PublicIcon fontSize="small" color="action" />
        <Typography variant="overline" color="text.secondary" sx={{ letterSpacing: 1 }}>
          Social
        </Typography>
      </Stack>

      <Grid container spacing={3}>
        {/* X (Twitter) Integration */}
        <Grid item xs={12} md={6}>
          <Card>
            <CardContent>
              <Box display="flex" alignItems="center" justifyContent="space-between" mb={2}>
                <Box display="flex" alignItems="center" gap={1}>
                  <XIcon />
                  <Typography variant="h6">X (Twitter)</Typography>
                  <Chip
                    label={xConfig.status === 'connected' ? 'Connected' : 'Disconnected'}
                    color={xConfig.status === 'connected' ? 'success' : 'default'}
                    size="small"
                    icon={xConfig.status === 'connected' ? <CheckIcon /> : <ErrorIcon />}
                  />
                </Box>
                <FormControlLabel
                  control={
                    <Switch
                      checked={xConfig.enabled}
                      onChange={(e) => setXConfig({ ...xConfig, enabled: e.target.checked })}
                    />
                  }
                  label="Enabled"
                />
              </Box>

              <Divider sx={{ mb: 2 }} />

              {/* Edit form is collapsed by default — avoids wall-of-text on
                  first load. Click to expand when you need to make changes. */}
              <Accordion
                disableGutters
                elevation={0}
                sx={{
                  '&:before': { display: 'none' },
                  backgroundColor: 'transparent',
                  '& .MuiAccordionSummary-root': { px: 0, minHeight: 40 },
                  '& .MuiAccordionDetails-root': { px: 0, pt: 1 },
                }}
              >
                <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                  <Stack direction="row" spacing={1} alignItems="center">
                    <TuneIcon fontSize="small" />
                    <Typography variant="button">Configure</Typography>
                  </Stack>
                </AccordionSummary>
                <AccordionDetails>
                <Box display="flex" flexDirection="column" gap={2}>
                <Button
                  variant="outlined"
                  startIcon={<TwitterIcon />}
                  onClick={handleConnectXOAuth}
                  disabled={saving || connectingX}
                  fullWidth
                >
                  {connectingX ? 'Redirecting to X OAuth...' : 'Connect with X OAuth'}
                </Button>

                <TextField
                  label="Username"
                  placeholder="CommonlyHQ"
                  value={xConfig.username}
                  onChange={(e) => setXConfig({ ...xConfig, username: e.target.value })}
                  fullWidth
                  size="small"
                  helperText="X account username (without @)"
                />

                <TextField
                  label="User ID"
                  placeholder="123456789"
                  value={xConfig.userId}
                  onChange={(e) => setXConfig({ ...xConfig, userId: e.target.value })}
                  fullWidth
                  size="small"
                  helperText="Numeric user ID from X API"
                />

                <TextField
                  label="Access Token"
                  placeholder="Bearer token..."
                  value={xConfig.accessToken}
                  onChange={(e) => setXConfig({ ...xConfig, accessToken: e.target.value })}
                  fullWidth
                  size="small"
                  type="password"
                  helperText="OAuth 2.0 Bearer token"
                />

                <TextField
                  label="Follow Usernames (optional)"
                  placeholder="sama, paulgraham, levelsio"
                  value={xConfig.followUsernames}
                  onChange={(e) => setXConfig({ ...xConfig, followUsernames: e.target.value })}
                  fullWidth
                  size="small"
                  helperText="Comma-separated usernames to watch in addition to the main account"
                />

                <TextField
                  label="Follow User IDs (optional)"
                  placeholder="123456,789012"
                  value={xConfig.followUserIds}
                  onChange={(e) => setXConfig({ ...xConfig, followUserIds: e.target.value })}
                  fullWidth
                  size="small"
                  helperText="Optional comma-separated user IDs for direct ingestion"
                />

                <FormControlLabel
                  control={(
                    <Switch
                      checked={xConfig.followFromAuthenticatedUser}
                      onChange={(e) => setXConfig({
                        ...xConfig,
                        followFromAuthenticatedUser: e.target.checked,
                      })}
                    />
                  )}
                  label="Watch authenticated user's following list"
                />

                <TextField
                  label="Following Max Users"
                  type="number"
                  value={xConfig.followingMaxUsers}
                  onChange={(e) => setXConfig({
                    ...xConfig,
                    followingMaxUsers: Number(e.target.value),
                  })}
                  fullWidth
                  size="small"
                  helperText="Cost control: only inspect this many followed accounts per sync (1-100, recommended 5-20)"
                />

                <TextField
                  label="Following Whitelist User IDs (optional)"
                  placeholder="44196397, 783214, ..."
                  value={xConfig.followingWhitelistUserIds}
                  onChange={(e) => setXConfig({ ...xConfig, followingWhitelistUserIds: e.target.value })}
                  fullWidth
                  size="small"
                  helperText="If set, only these IDs from your following list are ingested"
                />

                <Button
                  variant="outlined"
                  onClick={handleLoadXFollowingAsWhitelist}
                  disabled={saving || loadingXFollowing || xConfig.status !== 'connected'}
                  fullWidth
                >
                  {loadingXFollowing ? 'Loading following list...' : 'Load OAuth Following IDs Into Whitelist'}
                </Button>

                <Box display="flex" gap={1} mt={1}>
                  <Button
                    variant="contained"
                    startIcon={<SaveIcon />}
                    onClick={handleSaveX}
                    disabled={saving || !xConfig.username || !xConfig.userId || !xConfig.accessToken}
                    fullWidth
                  >
                    Save X Configuration
                  </Button>
                  <Tooltip title="Test connection">
                    <IconButton
                      onClick={() => testConnection('x')}
                      disabled={xConfig.status !== 'connected'}
                    >
                      <RefreshIcon />
                    </IconButton>
                  </Tooltip>
                </Box>
              </Box>
                </AccordionDetails>
              </Accordion>

              <Alert severity="info" sx={{ mt: 2 }}>
                <Typography variant="caption">
                  Prefer OAuth connect above for user-context tokens. Manual token entry is fallback only.
                </Typography>
              </Alert>
            </CardContent>
          </Card>
        </Grid>

        {/* Instagram Integration */}
        <Grid item xs={12} md={6}>
          <Card>
            <CardContent>
              <Box display="flex" alignItems="center" justifyContent="space-between" mb={2}>
                <Box display="flex" alignItems="center" gap={1}>
                  <InstagramIcon />
                  <Typography variant="h6">Instagram</Typography>
                  <Chip
                    label={instagramConfig.status === 'connected' ? 'Connected' : 'Disconnected'}
                    color={instagramConfig.status === 'connected' ? 'success' : 'default'}
                    size="small"
                    icon={instagramConfig.status === 'connected' ? <CheckIcon /> : <ErrorIcon />}
                  />
                </Box>
                <FormControlLabel
                  control={
                    <Switch
                      checked={instagramConfig.enabled}
                      onChange={(e) => setInstagramConfig({ ...instagramConfig, enabled: e.target.checked })}
                    />
                  }
                  label="Enabled"
                />
              </Box>

              <Divider sx={{ mb: 2 }} />

              <Accordion
                disableGutters
                elevation={0}
                sx={{
                  '&:before': { display: 'none' },
                  backgroundColor: 'transparent',
                  '& .MuiAccordionSummary-root': { px: 0, minHeight: 40 },
                  '& .MuiAccordionDetails-root': { px: 0, pt: 1 },
                }}
              >
                <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                  <Stack direction="row" spacing={1} alignItems="center">
                    <TuneIcon fontSize="small" />
                    <Typography variant="button">Configure</Typography>
                  </Stack>
                </AccordionSummary>
                <AccordionDetails>
              <Box display="flex" flexDirection="column" gap={2}>
                <TextField
                  label="Username"
                  placeholder="commonly.app"
                  value={instagramConfig.username}
                  onChange={(e) => setInstagramConfig({ ...instagramConfig, username: e.target.value })}
                  fullWidth
                  size="small"
                  helperText="Instagram account username (without @)"
                />

                <TextField
                  label="Instagram User ID"
                  placeholder="123456789"
                  value={instagramConfig.igUserId}
                  onChange={(e) => setInstagramConfig({ ...instagramConfig, igUserId: e.target.value })}
                  fullWidth
                  size="small"
                  helperText="Instagram Business Account ID"
                />

                <TextField
                  label="Access Token"
                  placeholder="Long-lived access token..."
                  value={instagramConfig.accessToken}
                  onChange={(e) => setInstagramConfig({ ...instagramConfig, accessToken: e.target.value })}
                  fullWidth
                  size="small"
                  type="password"
                  helperText="Long-lived access token from Facebook Graph API"
                />

                <Box display="flex" gap={1} mt={1}>
                  <Button
                    variant="contained"
                    startIcon={<SaveIcon />}
                    onClick={handleSaveInstagram}
                    disabled={saving || !instagramConfig.username || !instagramConfig.igUserId || !instagramConfig.accessToken}
                    fullWidth
                  >
                    Save Instagram Configuration
                  </Button>
                  <Tooltip title="Test connection">
                    <IconButton
                      onClick={() => testConnection('instagram')}
                      disabled={instagramConfig.status !== 'connected'}
                    >
                      <RefreshIcon />
                    </IconButton>
                  </Tooltip>
                </Box>
              </Box>
                </AccordionDetails>
              </Accordion>

              <Alert severity="info" sx={{ mt: 2 }}>
                <Typography variant="caption">
                  Get your Instagram credentials from <a href="https://developers.facebook.com/apps/" target="_blank" rel="noopener noreferrer">Meta for Developers</a>
                </Typography>
              </Alert>
            </CardContent>
          </Card>
        </Grid>
      </Grid>

      <Card sx={{ mt: 3 }}>
        <CardContent>
          <Typography variant="h6" gutterBottom>
            Global Model Policy
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Set global defaults for backend LLM routing and OpenClaw gateway model defaults. OpenClaw model applies to <strong>all agents</strong> — there is one shared gateway.
          </Typography>
          <Grid container spacing={2}>
            <Grid item xs={12}>
              <Typography variant="subtitle2" color="text.secondary" sx={{ mb: 0.5 }}>
                Backend LLM Service
              </Typography>
            </Grid>
            <Grid item xs={12} md={4}>
              <FormControl fullWidth size="small">
                <InputLabel id="llm-provider-label">Backend LLM Provider</InputLabel>
                <Select
                  labelId="llm-provider-label"
                  value={modelPolicy.llmService.provider}
                  label="Backend LLM Provider"
                  onChange={(event) => {
                    const nextProvider = event.target.value;
                    const models = LLM_SERVICE_MODEL_OPTIONS[nextProvider];
                    const nextModel = models ? models[0].value : modelPolicy.llmService.model;
                    setModelPolicy({
                      ...modelPolicy,
                      llmService: {
                        ...modelPolicy.llmService,
                        provider: nextProvider,
                        model: nextModel,
                      },
                    });
                  }}
                >
                  <MenuItem value="auto">Auto (LiteLLM then Gemini)</MenuItem>
                  <MenuItem value="gemini">Gemini</MenuItem>
                  <MenuItem value="openai">OpenAI</MenuItem>
                  <MenuItem value="anthropic">Anthropic</MenuItem>
                  <MenuItem value="litellm">LiteLLM</MenuItem>
                  <MenuItem value="openrouter">OpenRouter</MenuItem>
                </Select>
              </FormControl>
            </Grid>
            <Grid item xs={12} md={4}>
              {LLM_SERVICE_MODEL_OPTIONS[modelPolicy.llmService.provider] ? (
                <FormControl fullWidth size="small">
                  <InputLabel id="llm-model-label">Backend Model</InputLabel>
                  <Select
                    labelId="llm-model-label"
                    value={modelPolicy.llmService.model}
                    label="Backend Model"
                    onChange={(event) => setModelPolicy({
                      ...modelPolicy,
                      llmService: { ...modelPolicy.llmService, model: event.target.value },
                    })}
                  >
                    {LLM_SERVICE_MODEL_OPTIONS[modelPolicy.llmService.provider].map((opt) => (
                      <MenuItem key={opt.value} value={opt.value}>{opt.label}</MenuItem>
                    ))}
                  </Select>
                </FormControl>
              ) : (
                <TextField
                  label="Backend Model"
                  value={modelPolicy.llmService.model}
                  onChange={(event) => setModelPolicy({
                    ...modelPolicy,
                    llmService: { ...modelPolicy.llmService, model: event.target.value },
                  })}
                  fullWidth
                  size="small"
                  helperText="Used by llmService when callers do not pass a model."
                />
              )}
            </Grid>
            {modelPolicy.llmService.provider === 'openrouter' && (
              <>
                <Grid item xs={12} md={4}>
                  <TextField
                    label="OpenRouter Base URL"
                    value={modelPolicy.llmService.openrouter.baseUrl}
                    onChange={(event) => setModelPolicy({
                      ...modelPolicy,
                      llmService: {
                        ...modelPolicy.llmService,
                        openrouter: {
                          ...modelPolicy.llmService.openrouter,
                          baseUrl: event.target.value,
                        },
                      },
                    })}
                    fullWidth
                    size="small"
                  />
                </Grid>
                <Grid item xs={12} md={4}>
                  <TextField
                    label="OpenRouter Model"
                    value={modelPolicy.llmService.openrouter.model}
                    onChange={(event) => setModelPolicy({
                      ...modelPolicy,
                      llmService: {
                        ...modelPolicy.llmService,
                        openrouter: {
                          ...modelPolicy.llmService.openrouter,
                          model: event.target.value,
                        },
                      },
                    })}
                    fullWidth
                    size="small"
                    helperText="Example: openai/gpt-4.1-mini"
                  />
                </Grid>
              </>
            )}
            <Grid item xs={12}>
              <Divider sx={{ my: 1 }} />
              <Typography variant="subtitle2" color="text.secondary" sx={{ mb: 0.5 }}>
                OpenClaw — Agent Model Routing
              </Typography>
              <Typography variant="caption" color="text.disabled">
                Dev agents (by ID) use the primary below. All other agents use the Community section.
              </Typography>
            </Grid>
            <Grid item xs={12}>
              <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600 }}>
                Dev Agents
              </Typography>
            </Grid>
            <Grid item xs={12} md={4}>
              <FormControl fullWidth size="small">
                <InputLabel id="openclaw-provider-label">Dev Agent Provider</InputLabel>
                <Select
                  labelId="openclaw-provider-label"
                  value={modelPolicy.openclaw.provider}
                  label="Dev Agent Provider"
                  onChange={(event) => {
                    const nextProvider = event.target.value;
                    const models = OPENCLAW_MODEL_OPTIONS[nextProvider];
                    const nextModel = models ? models[0].value : '';
                    setModelPolicy({
                      ...modelPolicy,
                      openclaw: {
                        ...modelPolicy.openclaw,
                        provider: nextProvider,
                        model: nextModel,
                      },
                    });
                  }}
                >
                  <MenuItem value="google">Google (Gemini)</MenuItem>
                  <MenuItem value="openai-codex">OpenAI Codex (OAuth)</MenuItem>
                  <MenuItem value="openrouter">OpenRouter</MenuItem>
                  <MenuItem value="openai">OpenAI</MenuItem>
                  <MenuItem value="anthropic">Anthropic</MenuItem>
                  <MenuItem value="custom">Custom</MenuItem>
                </Select>
              </FormControl>
            </Grid>
            <Grid item xs={12} md={4}>
              {OPENCLAW_MODEL_OPTIONS[modelPolicy.openclaw.provider] ? (
                <FormControl fullWidth size="small">
                  <InputLabel id="openclaw-model-label">Dev Agent Primary Model</InputLabel>
                  <Select
                    labelId="openclaw-model-label"
                    value={modelPolicy.openclaw.model}
                    label="Dev Agent Primary Model"
                    onChange={(event) => setModelPolicy({
                      ...modelPolicy,
                      openclaw: {
                        ...modelPolicy.openclaw,
                        model: event.target.value,
                      },
                    })}
                  >
                    {OPENCLAW_MODEL_OPTIONS[modelPolicy.openclaw.provider].map((opt) => (
                      <MenuItem key={opt.value} value={opt.value}>{opt.label}</MenuItem>
                    ))}
                  </Select>
                </FormControl>
              ) : (
                <TextField
                  label="Dev Agent Primary Model"
                  value={modelPolicy.openclaw.model}
                  onChange={(event) => setModelPolicy({
                    ...modelPolicy,
                    openclaw: {
                      ...modelPolicy.openclaw,
                      model: event.target.value,
                    },
                  })}
                  fullWidth
                  size="small"
                  helperText="Applied to gateway defaults on reprovision."
                />
              )}
            </Grid>
            {modelPolicy.openclaw.provider === 'openai-codex' && (
              <Grid item xs={12}>
                <Alert severity="info" sx={{ py: 0.5 }}>
                  Codex requires OAuth tokens in the K8s Secret <code>api-keys</code>. See <code>docs/CODEX_OAUTH_SETUP.md</code>. Gemini fallbacks are applied automatically on reprovision.
                </Alert>
              </Grid>
            )}
            <Grid item xs={12}>
              <TextField
                label="Dev Agent Fallback Models"
                value={Array.isArray(modelPolicy.openclaw.fallbackModels)
                  ? modelPolicy.openclaw.fallbackModels.join(', ')
                  : modelPolicy.openclaw.fallbackModels}
                onChange={(event) => setModelPolicy({
                  ...modelPolicy,
                  openclaw: {
                    ...modelPolicy.openclaw,
                    fallbackModels: event.target.value as any,
                  },
                })}
                fullWidth
                size="small"
                helperText="Comma-separated fallbacks for dev agents, in order. Example: google/gemini-2.5-flash-lite, google/gemini-2.0-flash"
              />
            </Grid>
            <Grid item xs={12}>
              <TextField
                label="Dev Agent IDs"
                value={Array.isArray(modelPolicy.openclaw.devAgentIds)
                  ? modelPolicy.openclaw.devAgentIds.join(', ')
                  : modelPolicy.openclaw.devAgentIds}
                onChange={(event) => setModelPolicy({
                  ...modelPolicy,
                  openclaw: {
                    ...modelPolicy.openclaw,
                    devAgentIds: event.target.value as any,
                  },
                })}
                fullWidth
                size="small"
                helperText="Comma-separated instance IDs that use the dev agent primary above. All other agents use the community model below. Example: theo, nova, pixel, ops"
              />
            </Grid>
            <Grid item xs={12}>
              <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600 }}>
                Community Agents
              </Typography>
            </Grid>
            <Grid item xs={12}>
              <TextField
                label="Community Agent Primary Model"
                value={modelPolicy.openclaw.communityAgentModel?.primary || ''}
                onChange={(event) => setModelPolicy({
                  ...modelPolicy,
                  openclaw: {
                    ...modelPolicy.openclaw,
                    communityAgentModel: {
                      ...modelPolicy.openclaw.communityAgentModel,
                      primary: event.target.value,
                    },
                  },
                })}
                fullWidth
                size="small"
                helperText="Primary model for agents not in Dev Agent IDs. Example: openrouter/nvidia/nemotron-3-super-120b-a12b:free"
              />
            </Grid>
            <Grid item xs={12}>
              <TextField
                label="Community Agent Fallback Models"
                value={Array.isArray(modelPolicy.openclaw.communityAgentModel?.fallbacks)
                  ? modelPolicy.openclaw.communityAgentModel.fallbacks.join(', ')
                  : (modelPolicy.openclaw.communityAgentModel?.fallbacks || '')}
                onChange={(event) => setModelPolicy({
                  ...modelPolicy,
                  openclaw: {
                    ...modelPolicy.openclaw,
                    communityAgentModel: {
                      ...modelPolicy.openclaw.communityAgentModel,
                      fallbacks: event.target.value as any,
                    },
                  },
                })}
                fullWidth
                size="small"
                helperText="Comma-separated fallbacks for community agents (Gemini appended automatically). Example: openrouter/arcee-ai/trinity-large-preview:free"
              />
            </Grid>
          </Grid>
          <Box display="flex" gap={1} mt={2}>
            <Button
              variant="contained"
              startIcon={<SaveIcon />}
              onClick={handleSaveModelPolicy}
              disabled={saving || applyingModelPolicy}
            >
              Save Model Policy
            </Button>
            <Button
              variant="outlined"
              onClick={handleSaveAndApplyModelPolicy}
              disabled={saving || applyingModelPolicy}
            >
              {applyingModelPolicy ? 'Applying...' : 'Save + Apply To All Agents'}
            </Button>
          </Box>
          <Alert severity="info" sx={{ mt: 2 }}>
            OpenRouter API key is sourced from Kubernetes secrets/env only (not editable in UI). Gemini continues using GEMINI_API_KEY.
          </Alert>
        </CardContent>
      </Card>

      <Card sx={{ mt: 3 }}>
        <CardContent>
          <Typography variant="h6" gutterBottom>
            Global Social Publishing Policy
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            These settings apply to all agent external publishes from runtime endpoints.
          </Typography>
          <Grid container spacing={2}>
            <Grid item xs={12} md={4}>
              <FormControl fullWidth size="small">
                <InputLabel id="social-mode-label">Social Mode</InputLabel>
                <Select
                  labelId="social-mode-label"
                  value={socialPolicy.socialMode}
                  label="Social Mode"
                  onChange={(event) => setSocialPolicy({
                    ...socialPolicy,
                    socialMode: event.target.value,
                  })}
                >
                  <MenuItem value="repost">Repost</MenuItem>
                  <MenuItem value="rewrite">Rewrite</MenuItem>
                </Select>
              </FormControl>
            </Grid>
            <Grid item xs={12} md={4}>
              <FormControlLabel
                control={(
                  <Switch
                    checked={socialPolicy.publishEnabled}
                    onChange={(event) => setSocialPolicy({
                      ...socialPolicy,
                      publishEnabled: event.target.checked,
                    })}
                  />
                )}
                label="Enable external publish"
              />
            </Grid>
            <Grid item xs={12} md={4}>
              <FormControlLabel
                control={(
                  <Switch
                    checked={socialPolicy.strictAttribution}
                    onChange={(event) => setSocialPolicy({
                      ...socialPolicy,
                      strictAttribution: event.target.checked,
                    })}
                  />
                )}
                label="Strict attribution (require source URL)"
              />
            </Grid>
          </Grid>
          <Box display="flex" gap={1} mt={2}>
            <Button
              variant="contained"
              startIcon={<SaveIcon />}
              onClick={handleSavePolicy}
              disabled={saving}
            >
              Save Policy
            </Button>
          </Box>
          <Alert severity="info" sx={{ mt: 2 }}>
            Repost mode is link-first and avoids AI rewrite text for external channels.
          </Alert>
        </CardContent>
      </Card>

      {/* Status Summary */}
      <Card sx={{ mt: 3 }}>
        <CardContent>
          <Typography variant="h6" gutterBottom>
            Integration Status
          </Typography>
          <Grid container spacing={2}>
            <Grid item xs={12} md={4}>
              <Typography variant="body2" color="text.secondary">
                Active Integrations
              </Typography>
              <Typography variant="h4">
                {(xConfig.status === 'connected' ? 1 : 0) + (instagramConfig.status === 'connected' ? 1 : 0)} / 2
              </Typography>
            </Grid>
            <Grid item xs={12} md={4}>
              <Typography variant="body2" color="text.secondary">
                Polling Frequency
              </Typography>
              <Typography variant="h4">
                10 min
              </Typography>
            </Grid>
            <Grid item xs={12} md={4}>
              <Typography variant="body2" color="text.secondary">
                Content Category
              </Typography>
              <Typography variant="h4">
                Social
              </Typography>
            </Grid>
          </Grid>
          <Alert severity="success" sx={{ mt: 2 }}>
            Posts from these integrations are automatically available to all curator agents via <code>GET /api/posts?category=Social</code>
          </Alert>
        </CardContent>
      </Card>
    </Box>
  );
};

export default GlobalIntegrations;
