import React, { useState, useEffect } from 'react';
import {
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
  Tooltip,
  Divider,
  Switch,
  FormControlLabel
} from '@mui/material';
import {
  Save as SaveIcon,
  Refresh as RefreshIcon,
  Check as CheckIcon,
  Error as ErrorIcon,
  Twitter as TwitterIcon,
  Instagram as InstagramIcon
} from '@mui/icons-material';
import axios from 'axios';

const XIcon = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
    <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/>
  </svg>
);

const GlobalIntegrations = () => {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  // X (Twitter) state
  const [xConfig, setXConfig] = useState({
    enabled: false,
    accessToken: '',
    username: '',
    userId: '',
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

  const fetchIntegrations = async () => {
    try {
      setLoading(true);
      setError('');
      const token = localStorage.getItem('token');

      const response = await axios.get('/api/admin/integrations/global', {
        headers: { Authorization: `Bearer ${token}` }
      });

      const { x, instagram } = response.data;

      if (x) {
        setXConfig({
          enabled: x.status === 'connected',
          accessToken: x.config?.accessToken || '',
          username: x.config?.username || '',
          userId: x.config?.userId || '',
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
    } catch (err) {
      console.error('Failed to fetch integrations:', err);
      setError(err.response?.data?.error || 'Failed to load integrations');
    } finally {
      setLoading(false);
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
          userId: xConfig.userId
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

  if (loading) {
    return (
      <Box display="flex" justifyContent="center" alignItems="center" minHeight="400px">
        <CircularProgress />
      </Box>
    );
  }

  return (
    <Box>
      <Typography variant="h4" gutterBottom>
        Global Social Feed Integrations
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
        Configure global OAuth tokens for X and Instagram. These accounts will be used by all curator agents to fetch social content.
      </Typography>

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

              <Box display="flex" flexDirection="column" gap={2}>
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

              <Alert severity="info" sx={{ mt: 2 }}>
                <Typography variant="caption">
                  Get your X API credentials from <a href="https://developer.x.com/en/portal/dashboard" target="_blank" rel="noopener noreferrer">X Developer Portal</a>
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

              <Alert severity="info" sx={{ mt: 2 }}>
                <Typography variant="caption">
                  Get your Instagram credentials from <a href="https://developers.facebook.com/apps/" target="_blank" rel="noopener noreferrer">Meta for Developers</a>
                </Typography>
              </Alert>
            </CardContent>
          </Card>
        </Grid>
      </Grid>

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
