import React, { useState, useEffect, useContext } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import {
  Box,
  Typography,
  Card,
  CardContent,
  CardActions,
  Button,
  Chip,
  Alert,
  CircularProgress,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Grid,
  IconButton,
  Tooltip,
  TextField,
  Stack,
  Divider,
  Paper,
} from '@mui/material';
import {
  Delete as DeleteIcon,
  Refresh as RefreshIcon,
  Settings as SettingsIcon,
  Add as AddIcon,
  ContentCopy as ContentCopyIcon,
  Security as SecurityIcon,
  Webhook as WebhookIcon,
} from '@mui/icons-material';
import { AuthContext } from '../context/AuthContext';

interface IntegrationPodRef {
  _id?: string;
  name?: string;
  type?: string;
}

interface IntegrationConfig {
  channelName?: string;
}

interface Integration {
  _id: string;
  type: string;
  status: string;
  config?: IntegrationConfig;
  podId?: IntegrationPodRef;
  createdAt: string;
}

interface AppEntry {
  _id: string;
  name: string;
}

interface AppForm {
  name: string;
  webhookUrl: string;
  description: string;
}

interface AppSecrets {
  clientId: string;
  clientSecret: string;
  webhookSecret: string;
}

interface InstallForm {
  appId: string;
  targetType: string;
  targetId: string;
  scopes: string;
  events: string;
}

interface InstallToken {
  token: string;
  tokenExpiresAt?: string;
}

interface IngestToken {
  id: string;
  label?: string;
  createdAt: string;
  lastUsedAt?: string;
}

const AppsManagement: React.FC = () => {
  const { user } = useContext(AuthContext);
  const navigate = useNavigate();
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [apps, setApps] = useState<AppEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [selectedIntegration, setSelectedIntegration] = useState<Integration | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [creatingApp, setCreatingApp] = useState(false);
  const [appForm, setAppForm] = useState<AppForm>({ name: '', webhookUrl: '', description: '' });
  const [appSecrets, setAppSecrets] = useState<AppSecrets | null>(null);
  const [installing, setInstalling] = useState(false);
  const [installForm, setInstallForm] = useState<InstallForm>({
    appId: '',
    targetType: 'pod',
    targetId: '',
    scopes: 'messages:read',
    events: 'message.created',
  });
  const [installToken, setInstallToken] = useState<InstallToken | null>(null);
  const [ingestDialogOpen, setIngestDialogOpen] = useState(false);
  const [ingestTokens, setIngestTokens] = useState<IngestToken[]>([]);
  const [ingestLoading, setIngestLoading] = useState(false);
  const [ingestError, setIngestError] = useState('');
  const [ingestLabel, setIngestLabel] = useState('');
  const [newIngestToken, setNewIngestToken] = useState<string | null>(null);
  const [selectedIntegrationForTokens, setSelectedIntegrationForTokens] = useState<Integration | null>(null);

  const fetchIntegrations = async (): Promise<void> => {
    try {
      setLoading(true);
      const token = localStorage.getItem('token');
      const endpoint = (user as { role?: string })?.role === 'admin'
        ? '/api/integrations/admin/all'
        : '/api/integrations/user/all';
      const response = await axios.get(endpoint, {
        headers: { Authorization: `Bearer ${token}` },
      });
      setIntegrations(response.data as Integration[]);
      setError('');
    } catch (err) {
      console.error('Error fetching integrations:', err);
      setError('Failed to load integrations');
    } finally {
      setLoading(false);
    }
  };

  const fetchApps = async (): Promise<void> => {
    try {
      const token = localStorage.getItem('token');
      const res = await axios.get('/api/apps', { headers: { Authorization: `Bearer ${token}` } });
      setApps(res.data as AppEntry[]);
    } catch (err) {
      console.error('Error fetching apps:', err);
    }
  };

  useEffect(() => {
    fetchIntegrations();
    fetchApps();
  }, [user]);

  const handleDeleteClick = (integration: Integration): void => {
    setSelectedIntegration(integration);
    setDeleteDialogOpen(true);
  };

  const handleDeleteConfirm = async (): Promise<void> => {
    if (!selectedIntegration) return;
    setDeleting(true);
    try {
      const token = localStorage.getItem('token');
      await axios.delete(`/api/integrations/${selectedIntegration._id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      setIntegrations((prev) => prev.filter((int) => int._id !== selectedIntegration._id));
      setError('');
      setDeleteDialogOpen(false);
      setSelectedIntegration(null);
    } catch (err) {
      const e = err as { response?: { data?: { message?: string } } };
      console.error('Error deleting integration:', err);
      setError(e.response?.data?.message || 'Failed to delete integration');
    } finally {
      setDeleting(false);
    }
  };

  const handleCreateApp = async (): Promise<void> => {
    if (!appForm.name || !appForm.webhookUrl) {
      setError('Name and webhook URL are required');
      return;
    }
    setCreatingApp(true);
    setAppSecrets(null);
    try {
      const token = localStorage.getItem('token');
      const res = await axios.post(
        '/api/apps',
        { name: appForm.name, webhookUrl: appForm.webhookUrl, description: appForm.description },
        { headers: { Authorization: `Bearer ${token}` } },
      );
      setAppSecrets(res.data as AppSecrets);
      setAppForm({ name: '', webhookUrl: '', description: '' });
      fetchApps();
      setError('');
    } catch (err) {
      const e = err as { response?: { data?: { error?: string } } };
      console.error('Error creating app:', err);
      setError(e.response?.data?.error || 'Failed to create app');
    } finally {
      setCreatingApp(false);
    }
  };

  const handleCreateInstallation = async (): Promise<void> => {
    if (!installForm.appId || !installForm.targetId) {
      setError('App and target are required for installation');
      return;
    }
    setInstalling(true);
    setInstallToken(null);
    try {
      const token = localStorage.getItem('token');
      const res = await axios.post(
        '/api/apps/installations',
        {
          appId: installForm.appId,
          targetType: installForm.targetType,
          targetId: installForm.targetId,
          scopes: installForm.scopes.split(',').map((s) => s.trim()).filter(Boolean),
          events: installForm.events.split(',').map((e) => e.trim()).filter(Boolean),
        },
        { headers: { Authorization: `Bearer ${token}` } },
      );
      setInstallToken(res.data as InstallToken);
      setError('');
    } catch (err) {
      const e = err as { response?: { data?: { error?: string } } };
      console.error('Error creating installation:', err);
      setError(e.response?.data?.error || 'Failed to create installation');
    } finally {
      setInstalling(false);
    }
  };

  const fetchIngestTokens = async (integrationId: string): Promise<void> => {
    if (!integrationId) return;
    setIngestLoading(true);
    setIngestError('');
    try {
      const token = localStorage.getItem('token');
      const res = await axios.get(`/api/integrations/${integrationId}/ingest-tokens`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      setIngestTokens((res.data as { tokens?: IngestToken[] }).tokens || []);
    } catch (err) {
      const e = err as { response?: { data?: { message?: string } } };
      console.error('Error fetching ingest tokens:', err);
      setIngestError(e.response?.data?.message || 'Failed to load ingest tokens');
    } finally {
      setIngestLoading(false);
    }
  };

  const handleOpenIngestTokens = async (integration: Integration): Promise<void> => {
    setSelectedIntegrationForTokens(integration);
    setIngestDialogOpen(true);
    setNewIngestToken(null);
    setIngestLabel('');
    await fetchIngestTokens(integration._id);
  };

  const handleCreateIngestToken = async (): Promise<void> => {
    if (!selectedIntegrationForTokens) return;
    setIngestLoading(true);
    setIngestError('');
    try {
      const token = localStorage.getItem('token');
      const res = await axios.post(
        `/api/integrations/${selectedIntegrationForTokens._id}/ingest-tokens`,
        { label: ingestLabel },
        { headers: { Authorization: `Bearer ${token}` } },
      );
      setNewIngestToken((res.data as { token?: string }).token || null);
      setIngestLabel('');
      await fetchIngestTokens(selectedIntegrationForTokens._id);
    } catch (err) {
      const e = err as { response?: { data?: { message?: string } } };
      console.error('Error creating ingest token:', err);
      setIngestError(e.response?.data?.message || 'Failed to create ingest token');
    } finally {
      setIngestLoading(false);
    }
  };

  const handleRevokeIngestToken = async (tokenId: string): Promise<void> => {
    if (!selectedIntegrationForTokens || !tokenId) return;
    setIngestLoading(true);
    setIngestError('');
    try {
      const token = localStorage.getItem('token');
      await axios.delete(
        `/api/integrations/${selectedIntegrationForTokens._id}/ingest-tokens/${tokenId}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      await fetchIngestTokens(selectedIntegrationForTokens._id);
    } catch (err) {
      const e = err as { response?: { data?: { message?: string } } };
      console.error('Error revoking ingest token:', err);
      setIngestError(e.response?.data?.message || 'Failed to revoke ingest token');
    } finally {
      setIngestLoading(false);
    }
  };

  const getStatusColor = (status: string): 'success' | 'warning' | 'error' | 'info' | 'default' => {
    switch (status) {
      case 'connected': return 'success';
      case 'disconnected': return 'warning';
      case 'error': return 'error';
      case 'pending': return 'info';
      default: return 'default';
    }
  };

  const getTypeIcon = (type: string): string => {
    switch (type) {
      case 'discord': return '💬';
      case 'telegram': return '✈️';
      case 'slack': return '💬';
      case 'messenger': return '📩';
      default: return '🔗';
    }
  };

  if (loading) {
    return (
      <Box display="flex" justifyContent="center" alignItems="center" minHeight={200}>
        <CircularProgress />
      </Box>
    );
  }

  return (
    <Box>
      <Box display="flex" justifyContent="space-between" alignItems="center" mb={3}>
        <Box>
          <Typography variant="h5">Connections & Developer Apps</Typography>
          <Typography variant="body2" color="text.secondary">
            Manage external integrations and create Commonly Apps for webhooks and API access.
          </Typography>
        </Box>
        <Stack direction="row" spacing={1}>
          <Tooltip title="Refresh">
            <IconButton onClick={() => { fetchIntegrations(); fetchApps(); }} disabled={loading}>
              <RefreshIcon />
            </IconButton>
          </Tooltip>
        </Stack>
      </Box>

      {error && (
        <Alert severity="error" sx={{ mb: 3 }}>
          {error}
        </Alert>
      )}

      <Grid container spacing={3}>
        <Grid item xs={12} md={7}>
          <Card sx={{ mb: 3 }}>
            <CardContent>
              <Box display="flex" alignItems="center" mb={2} gap={1}>
                <WebhookIcon color="primary" />
                <Typography variant="h6">Commonly Apps</Typography>
              </Box>
              <Typography variant="body2" color="text.secondary" mb={2}>
                Create an app to receive webhooks and use scoped API tokens. No admin approval required.
              </Typography>

              <Stack spacing={2} direction={{ xs: 'column', sm: 'row' }}>
                <TextField
                  label="App name"
                  value={appForm.name}
                  onChange={(e) => setAppForm({ ...appForm, name: e.target.value })}
                  fullWidth
                />
                <TextField
                  label="Webhook URL"
                  value={appForm.webhookUrl}
                  onChange={(e) => setAppForm({ ...appForm, webhookUrl: e.target.value })}
                  fullWidth
                />
              </Stack>
              <TextField
                label="Description (optional)"
                value={appForm.description}
                onChange={(e) => setAppForm({ ...appForm, description: e.target.value })}
                fullWidth
                sx={{ mt: 2 }}
                multiline
                minRows={2}
              />
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} mt={2}>
                <Button
                  variant="contained"
                  startIcon={<AddIcon />}
                  onClick={handleCreateApp}
                  disabled={creatingApp}
                >
                  {creatingApp ? 'Creating...' : 'Create App'}
                </Button>
                <Button variant="text" onClick={fetchApps} startIcon={<RefreshIcon />}>
                  Refresh apps
                </Button>
              </Stack>

              {appSecrets && (
                <Paper sx={{ mt: 3, p: 2, bgcolor: 'grey.50' }}>
                  <Typography variant="subtitle1" gutterBottom>
                    App Credentials (copy & store securely)
                  </Typography>
                  <Stack spacing={1}>
                    {(['clientId', 'clientSecret', 'webhookSecret'] as const).map((field) => (
                      <Stack direction="row" spacing={1} alignItems="center" key={field}>
                        <TextField
                          label={field}
                          value={appSecrets[field]}
                          fullWidth
                          InputProps={{ readOnly: true, sx: { fontFamily: 'monospace' } }}
                        />
                        <Tooltip title="Copy">
                          <IconButton onClick={() => navigator.clipboard?.writeText(appSecrets[field])}>
                            <ContentCopyIcon fontSize="small" />
                          </IconButton>
                        </Tooltip>
                      </Stack>
                    ))}
                  </Stack>
                </Paper>
              )}

              <Divider sx={{ my: 3 }} />

              <Typography variant="subtitle1" gutterBottom>
                Install App to a Pod or User
              </Typography>
              <Grid container spacing={2}>
                <Grid item xs={12} sm={6}>
                  <TextField
                    label="App"
                    select
                    SelectProps={{ native: true }}
                    value={installForm.appId}
                    onChange={(e) => setInstallForm({ ...installForm, appId: e.target.value })}
                    fullWidth
                  >
                    <option value="">Select app</option>
                    {apps.map((a) => (
                      <option key={a._id} value={a._id}>
                        {a.name}
                      </option>
                    ))}
                  </TextField>
                </Grid>
                <Grid item xs={12} sm={3}>
                  <TextField
                    label="Target Type"
                    select
                    SelectProps={{ native: true }}
                    value={installForm.targetType}
                    onChange={(e) => setInstallForm({ ...installForm, targetType: e.target.value })}
                    fullWidth
                  >
                    <option value="pod">Pod</option>
                    <option value="user">User</option>
                  </TextField>
                </Grid>
                <Grid item xs={12} sm={3}>
                  <TextField
                    label="Target ID"
                    value={installForm.targetId}
                    onChange={(e) => setInstallForm({ ...installForm, targetId: e.target.value })}
                    fullWidth
                    placeholder="podId or userId"
                  />
                </Grid>
                <Grid item xs={12} sm={6}>
                  <TextField
                    label="Scopes (comma separated)"
                    value={installForm.scopes}
                    onChange={(e) => setInstallForm({ ...installForm, scopes: e.target.value })}
                    fullWidth
                  />
                </Grid>
                <Grid item xs={12} sm={6}>
                  <TextField
                    label="Events (comma separated)"
                    value={installForm.events}
                    onChange={(e) => setInstallForm({ ...installForm, events: e.target.value })}
                    fullWidth
                  />
                </Grid>
              </Grid>
              <Stack direction="row" spacing={2} mt={2} alignItems="center">
                <Button
                  variant="contained"
                  startIcon={<SecurityIcon />}
                  onClick={handleCreateInstallation}
                  disabled={installing}
                >
                  {installing ? 'Creating...' : 'Create Installation'}
                </Button>
                {installToken?.token && <Chip color="success" label="Install token generated" />}
              </Stack>
              {installToken?.token && (
                <Paper sx={{ mt: 2, p: 2, bgcolor: 'grey.50' }}>
                  <Typography variant="subtitle2" gutterBottom>
                    Installation Token
                  </Typography>
                  <Stack direction="row" spacing={1} alignItems="center">
                    <TextField
                      value={installToken.token}
                      fullWidth
                      InputProps={{ readOnly: true, sx: { fontFamily: 'monospace' } }}
                    />
                    <Tooltip title="Copy token">
                      <IconButton onClick={() => navigator.clipboard?.writeText(installToken.token)}>
                        <ContentCopyIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  </Stack>
                  {installToken.tokenExpiresAt && (
                    <Typography variant="caption" color="text.secondary">
                      Expires: {new Date(installToken.tokenExpiresAt).toLocaleString()}
                    </Typography>
                  )}
                </Paper>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardContent>
              <Box display="flex" alignItems="center" mb={2}>
                <SettingsIcon color="primary" />
                <Typography variant="h6" sx={{ ml: 1 }}>
                  Existing Integrations
                </Typography>
              </Box>
              {integrations.length === 0 ? (
                <Alert severity="info">No app integrations found. Create integrations from within your pods.</Alert>
              ) : (
                <Grid container spacing={2}>
                  {integrations.map((integration) => (
                    <Grid item xs={12} md={6} key={integration._id}>
                      <Card variant="outlined" sx={{ height: '100%' }}>
                        <CardContent>
                          <Box display="flex" alignItems="center" mb={1}>
                            <Typography variant="subtitle1" sx={{ mr: 1 }}>
                              {getTypeIcon(integration.type)} {integration.type}
                            </Typography>
                            <Chip
                              label={integration.status}
                              color={getStatusColor(integration.status)}
                              size="small"
                            />
                          </Box>
                          <Typography variant="body2" color="text.secondary">
                            Pod: {integration.podId?.name || 'Unknown Pod'}
                          </Typography>
                          {integration.config?.channelName && (
                            <Typography variant="body2" color="text.secondary">
                              Channel: #{integration.config.channelName}
                            </Typography>
                          )}
                          <Typography variant="caption" color="text.secondary">
                            Created {new Date(integration.createdAt).toLocaleDateString()}
                          </Typography>
                        </CardContent>
                        <CardActions sx={{ justifyContent: 'space-between' }}>
                          <Box sx={{ display: 'flex', gap: 1 }}>
                            <Button
                              size="small"
                              startIcon={<SettingsIcon />}
                              onClick={() => {
                                const podType = integration.podId?.type || 'chat';
                                const roomId = integration.podId?._id;
                                if (roomId) navigate(`/pods/${podType}/${roomId}`);
                              }}
                            >
                              View Pod
                            </Button>
                            <Button
                              size="small"
                              startIcon={<SecurityIcon />}
                              onClick={() => handleOpenIngestTokens(integration)}
                            >
                              Ingest Tokens
                            </Button>
                          </Box>
                          <Button
                            size="small"
                            color="error"
                            startIcon={<DeleteIcon />}
                            onClick={() => handleDeleteClick(integration)}
                          >
                            Delete
                          </Button>
                        </CardActions>
                      </Card>
                    </Grid>
                  ))}
                </Grid>
              )}
            </CardContent>
          </Card>
        </Grid>

        <Grid item xs={12} md={5}>
          <Card>
            <CardContent>
              <Typography variant="h6" gutterBottom>
                Developer Tips
              </Typography>
              <Typography variant="body2" color="text.secondary">
                - Webhook secret: HMAC SHA-256 of request body.<br />
                - Installation token: send as `Authorization: Bearer &lt;token&gt;`.<br />
                - Ingest tokens: issue per-integration keys for external providers.<br />
                - Scopes: comma separated (e.g., messages:read, pods:read).<br />
                - Events: comma separated (e.g., message.created).<br />
              </Typography>
            </CardContent>
          </Card>
        </Grid>
      </Grid>

      <Dialog open={deleteDialogOpen} onClose={() => setDeleteDialogOpen(false)}>
        <DialogTitle>Delete Integration</DialogTitle>
        <DialogContent>
          <Typography>
            Are you sure you want to delete this integration? This action cannot be undone.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteDialogOpen(false)}>Cancel</Button>
          <Button
            onClick={handleDeleteConfirm}
            color="error"
            variant="contained"
            disabled={deleting}
            startIcon={<DeleteIcon />}
          >
            {deleting ? 'Deleting...' : 'Delete'}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={ingestDialogOpen}
        onClose={() => setIngestDialogOpen(false)}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>
          Ingest Tokens{selectedIntegrationForTokens ? ` · ${selectedIntegrationForTokens.type}` : ''}
        </DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Use ingest tokens with external provider services to push events into Commonly.
            Tokens start with <strong>cm_int_</strong> and are shown once on creation.
          </Typography>

          {ingestError && (
            <Alert severity="error" sx={{ mb: 2 }}>
              {ingestError}
            </Alert>
          )}

          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} mb={2}>
            <TextField
              label="Token label (optional)"
              value={ingestLabel}
              onChange={(e) => setIngestLabel(e.target.value)}
              fullWidth
            />
            <Button
              variant="contained"
              onClick={handleCreateIngestToken}
              disabled={ingestLoading || !selectedIntegrationForTokens}
            >
              Create Token
            </Button>
          </Stack>

          {newIngestToken && (
            <Paper sx={{ p: 2, mb: 2, bgcolor: 'grey.50' }}>
              <Typography variant="subtitle2" gutterBottom>
                New Ingest Token (copy now)
              </Typography>
              <Stack direction="row" spacing={1} alignItems="center">
                <TextField
                  value={newIngestToken}
                  fullWidth
                  InputProps={{ readOnly: true, sx: { fontFamily: 'monospace' } }}
                />
                <Tooltip title="Copy token">
                  <IconButton onClick={() => navigator.clipboard?.writeText(newIngestToken)}>
                    <ContentCopyIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
              </Stack>
            </Paper>
          )}

          {ingestLoading && (
            <Box display="flex" justifyContent="center" py={2}>
              <CircularProgress size={24} />
            </Box>
          )}

          {!ingestLoading && ingestTokens.length === 0 && (
            <Alert severity="info">No ingest tokens yet.</Alert>
          )}

          {!ingestLoading && ingestTokens.length > 0 && (
            <Stack spacing={1.5}>
              {ingestTokens.map((token) => (
                <Paper key={token.id} sx={{ p: 2 }}>
                  <Box display="flex" justifyContent="space-between" alignItems="center" gap={2}>
                    <Box>
                      <Typography variant="subtitle2">
                        {token.label || 'Untitled token'}
                      </Typography>
                      <Typography variant="caption" color="text.secondary" display="block">
                        Created: {new Date(token.createdAt).toLocaleString()}
                      </Typography>
                      {token.lastUsedAt && (
                        <Typography variant="caption" color="text.secondary" display="block">
                          Last used: {new Date(token.lastUsedAt).toLocaleString()}
                        </Typography>
                      )}
                    </Box>
                    <Button
                      size="small"
                      color="error"
                      variant="outlined"
                      onClick={() => handleRevokeIngestToken(token.id)}
                    >
                      Revoke
                    </Button>
                  </Box>
                </Paper>
              ))}
            </Stack>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setIngestDialogOpen(false)}>Close</Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
};

export default AppsManagement;
