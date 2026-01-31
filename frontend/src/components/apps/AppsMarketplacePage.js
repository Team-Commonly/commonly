/**
 * AppsMarketplacePage
 *
 * Public marketplace UI for Commonly Apps (webhooks, integrations, agent apps).
 */

import React, { useEffect, useState } from 'react';
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
  Alert,
  Button,
  Card,
  CardContent,
  FormControl,
  Select,
  MenuItem,
  InputLabel,
  Snackbar,
  Skeleton,
  useTheme,
} from '@mui/material';
import {
  Search as SearchIcon,
  Apps as AppsIcon,
  Refresh as RefreshIcon,
} from '@mui/icons-material';
import axios from 'axios';
import AppCard from './AppCard';
import OfficialIntegrationCard from './OfficialIntegrationCard';

const categories = [
  { id: 'all', label: 'All Categories' },
  { id: 'productivity', label: 'Productivity' },
  { id: 'development', label: 'Development' },
  { id: 'analytics', label: 'Analytics' },
  { id: 'support', label: 'Support' },
  { id: 'communication', label: 'Communication' },
  { id: 'other', label: 'Other' },
];

const types = [
  { id: 'all', label: 'All Types' },
  { id: 'agent', label: 'Agent Apps' },
  { id: 'integration', label: 'Integrations' },
  { id: 'mcp-app', label: 'MCP Apps' },
  { id: 'webhook', label: 'Webhook Apps' },
];


const AppsMarketplacePage = () => {
  const theme = useTheme();
  const [apps, setApps] = useState([]);
  const [featured, setFeatured] = useState([]);
  const [officialEntries, setOfficialEntries] = useState([]);
  const [officialLoading, setOfficialLoading] = useState(false);
  const [officialError, setOfficialError] = useState(null);
  const [integrationEntries, setIntegrationEntries] = useState([]);
  const [integrationsLoading, setIntegrationsLoading] = useState(false);
  const [integrationsError, setIntegrationsError] = useState(null);
  const [installedApps, setInstalledApps] = useState([]);
  const [userPods, setUserPods] = useState([]);
  const [selectedPodId, setSelectedPodId] = useState('');
  const [activeTab, setActiveTab] = useState(0);
  const [searchQuery, setSearchQuery] = useState('');
  const [category, setCategory] = useState('all');
  const [typeFilter, setTypeFilter] = useState('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [snackbar, setSnackbar] = useState({ open: false, message: '', severity: 'info' });
  const contribUrl =
    process.env.REACT_APP_MARKETPLACE_CONTRIB_URL ||
    'https://example.com/commonly-marketplace#contributing';

  const getAuthHeaders = () => {
    const token = localStorage.getItem('token');
    return { 'x-auth-token': token };
  };

  useEffect(() => {
    const fetchUserPods = async () => {
      try {
        const response = await axios.get('/api/pods', { headers: getAuthHeaders() });
        setUserPods(response.data || []);
        if (!selectedPodId && response.data?.length > 0) {
          setSelectedPodId(response.data[0]._id);
        }
      } catch (err) {
        console.error('Error fetching pods:', err);
      }
    };
    fetchUserPods();
  }, []);

  useEffect(() => {
    fetchMarketplace();
  }, [searchQuery, category, typeFilter]);

  useEffect(() => {
    fetchOfficialMarketplace();
    fetchIntegrations();
  }, []);

  useEffect(() => {
    if (selectedPodId) {
      fetchInstalled();
    }
  }, [selectedPodId]);

  const fetchMarketplace = async () => {
    setLoading(true);
    setError(null);

    try {
      const params = new URLSearchParams();
      if (searchQuery) params.append('search', searchQuery);
      if (category !== 'all') params.append('category', category);
      if (typeFilter !== 'all') params.append('type', typeFilter);

      const [appsRes, featuredRes] = await Promise.all([
        axios.get(`/api/apps/marketplace?${params.toString()}`),
        axios.get('/api/apps/marketplace/featured'),
      ]);

      setApps(appsRes.data.apps || []);
      setFeatured(featuredRes.data.apps || []);
    } catch (err) {
      console.error('Error loading marketplace apps:', err);
      setError('Failed to load apps marketplace');
      setApps([]);
    } finally {
      setLoading(false);
    }
  };

  const fetchOfficialMarketplace = async () => {
    setOfficialLoading(true);
    setOfficialError(null);
    try {
      const response = await axios.get('/api/marketplace/official');
      setOfficialEntries(response.data?.entries || []);
    } catch (err) {
      console.error('Error loading official marketplace:', err);
      setOfficialError('Failed to load official marketplace.');
      setOfficialEntries([]);
    } finally {
      setOfficialLoading(false);
    }
  };

  const fetchIntegrations = async () => {
    const token = localStorage.getItem('token');
    if (!token) {
      setIntegrationEntries([]);
      return;
    }

    setIntegrationsLoading(true);
    setIntegrationsError(null);

    try {
      const response = await axios.get('/api/integrations/catalog', {
        headers: getAuthHeaders(),
      });
      setIntegrationEntries(response.data?.entries || []);
    } catch (err) {
      console.error('Error loading integrations catalog:', err);
      setIntegrationsError('Failed to load integrations catalog.');
    } finally {
      setIntegrationsLoading(false);
    }
  };

  const fetchInstalled = async () => {
    try {
      const response = await axios.get(`/api/apps/pods/${selectedPodId}/apps`, {
        headers: getAuthHeaders(),
      });
      setInstalledApps(response.data.apps || []);
    } catch (err) {
      console.error('Error fetching installed apps:', err);
    }
  };

  const handleInstall = async (app) => {
    if (!selectedPodId) {
      setSnackbar({ open: true, message: 'Select a pod to install', severity: 'warning' });
      return;
    }

    try {
      await axios.post(
        `/api/apps/pods/${selectedPodId}/apps`,
        { appId: app.id },
        { headers: getAuthHeaders() }
      );
      setSnackbar({ open: true, message: `Installed ${app.displayName || app.name}`, severity: 'success' });
      fetchInstalled();
    } catch (err) {
      console.error('Error installing app:', err);
      setSnackbar({
        open: true,
        message: err.response?.data?.error || 'Failed to install app',
        severity: 'error',
      });
    }
  };

  const handleRemove = async (app) => {
    if (!selectedPodId) return;

    try {
      await axios.delete(`/api/apps/pods/${selectedPodId}/apps/${app.installationId}`, {
        headers: getAuthHeaders(),
      });
      setSnackbar({ open: true, message: `Removed ${app.displayName || app.name}`, severity: 'info' });
      fetchInstalled();
    } catch (err) {
      console.error('Error removing app:', err);
      setSnackbar({ open: true, message: 'Failed to remove app', severity: 'error' });
    }
  };

  const isInstalled = (appId) => installedApps.some((a) => a.id === appId);
  const integrationsById = integrationEntries.reduce((acc, entry) => {
    acc[entry.id] = entry;
    return acc;
  }, {});

  const officialListings = officialEntries.map((entry) => {
    const integrationInfo = integrationsById[entry.id] || {};
    return {
      ...entry,
      capabilities: integrationInfo.catalog?.capabilities || entry.capabilities || [],
      activeCount: integrationInfo.stats?.activeIntegrations,
    };
  });
  const officialIntegrations = officialListings.filter((entry) => entry.type !== 'mcp-app');
  const mcpListings = officialListings.filter((entry) => entry.type === 'mcp-app');

  const handleConnect = (entry) => {
    setSnackbar({
      open: true,
      message: `Open a pod to connect ${entry.name}.`,
      severity: 'info',
    });
    window.location.href = '/pods';
  };

  return (
    <Container
      maxWidth="xl"
      disableGutters
      sx={{ py: { xs: 3, md: 4 }, px: { xs: 2, sm: 3, md: 4 } }}
    >
      <Box
        sx={{
          mb: 4,
          display: 'flex',
          flexDirection: { xs: 'column', md: 'row' },
          justifyContent: 'space-between',
          alignItems: { xs: 'flex-start', md: 'center' },
          gap: 2,
        }}
      >
        <Box>
          <Typography variant="h4" fontWeight={700} gutterBottom>
            Apps Marketplace
          </Typography>
          <Typography variant="body1" color="text.secondary">
            Install apps and connect official integrations for your pods
          </Typography>
        </Box>

        <Box sx={{ display: 'flex', gap: 2, alignItems: 'center', flexWrap: 'wrap' }}>
          <Button
            variant="outlined"
            href={contribUrl}
            target="_blank"
            rel="noreferrer"
          >
            Submit App
          </Button>
          <FormControl sx={{ minWidth: 220 }} size="small">
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
      </Box>

      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1.5, mb: 3 }}>
        <TextField
          placeholder="Search apps..."
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
            minWidth: { xs: '100%', sm: 320 },
            flex: '1 1 240px',
            '& .MuiOutlinedInput-root': {
              borderRadius: 3,
              backgroundColor: theme.palette.background.paper,
            },
          }}
        />

        <FormControl sx={{ minWidth: { xs: '100%', sm: 180 }, flex: '1 1 180px' }} size="small">
          <InputLabel>Type</InputLabel>
          <Select
            value={typeFilter}
            label="Type"
            onChange={(e) => setTypeFilter(e.target.value)}
          >
            {types.map((t) => (
              <MenuItem key={t.id} value={t.id}>
                {t.label}
              </MenuItem>
            ))}
          </Select>
        </FormControl>

        <Button
          variant="outlined"
          startIcon={<RefreshIcon />}
          onClick={fetchMarketplace}
        >
          Refresh
        </Button>
      </Box>

      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mb: 4 }}>
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

      <Box sx={{ borderBottom: 1, borderColor: 'divider', mb: 3 }}>
        <Tabs value={activeTab} onChange={(e, v) => setActiveTab(v)}>
          <Tab label="Discover" icon={<AppsIcon />} iconPosition="start" />
          <Tab label={`Installed ${installedApps.length ? `(${installedApps.length})` : ''}`} />
        </Tabs>
      </Box>

      {error && (
        <Alert severity="warning" sx={{ mb: 3 }}>
          {error}
        </Alert>
      )}

      {activeTab === 0 && (
        <>
          {!searchQuery && category === 'all' && featured.length > 0 && (
            <Box sx={{ mb: 5 }}>
              <Typography variant="h6" fontWeight={600} sx={{ mb: 2 }}>
                Featured Apps
              </Typography>
              <Grid container spacing={3}>
                {featured.map((app) => (
                  <Grid item xs={12} md={4} key={app.id}>
                    <AppCard
                      app={app}
                      installed={isInstalled(app.id)}
                      onInstall={handleInstall}
                      onRemove={handleRemove}
                    />
                  </Grid>
                ))}
              </Grid>
            </Box>
          )}

          <Box sx={{ mb: 5 }}>
            <Typography variant="h6" fontWeight={600} sx={{ mb: 1 }}>
              Official Marketplace
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              Official listings curated by Commonly. Connect from your pod sidebar.
            </Typography>

            {(officialLoading || integrationsLoading) && (
              <Grid container spacing={2}>
                {[1, 2, 3].map((i) => (
                  <Grid item xs={12} sm={6} md={4} key={`int-skel-${i}`}>
                    <Card variant="outlined">
                      <CardContent>
                        <Skeleton height={22} width="70%" />
                        <Skeleton height={16} width="90%" />
                        <Skeleton height={40} width="50%" sx={{ mt: 2 }} />
                      </CardContent>
                    </Card>
                  </Grid>
                ))}
              </Grid>
            )}

            {!officialLoading && (officialError || integrationsError) && (
              <Alert severity="warning" sx={{ mb: 2 }}>
                {officialError || integrationsError}
              </Alert>
            )}

            {!officialLoading && !officialError && !integrationsLoading && !integrationsError && (
              <Grid container spacing={2}>
                {officialIntegrations.map((entry) => (
                  <Grid item xs={12} sm={6} md={4} key={`official-${entry.id}`}>
                    <OfficialIntegrationCard
                      entry={entry}
                      onConnect={handleConnect}
                    />
                  </Grid>
                ))}
                {!officialLoading && officialIntegrations.length === 0 && (
                  <Grid item xs={12}>
                    <Alert severity="info">No official listings yet.</Alert>
                  </Grid>
                )}
              </Grid>
            )}
          </Box>

          <Box sx={{ mb: 5 }}>
            <Typography variant="h6" fontWeight={600} sx={{ mb: 1 }}>
              MCP Apps (Preview)
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              MCP Apps render interactive UI inside MCP-compatible hosts. Commonly lists them here for discovery.
            </Typography>

            {officialLoading && (
              <Grid container spacing={2}>
                {[1, 2].map((i) => (
                  <Grid item xs={12} sm={6} md={4} key={`mcp-skel-${i}`}>
                    <Card variant="outlined">
                      <CardContent>
                        <Skeleton height={22} width="70%" />
                        <Skeleton height={16} width="90%" />
                        <Skeleton height={40} width="50%" sx={{ mt: 2 }} />
                      </CardContent>
                    </Card>
                  </Grid>
                ))}
              </Grid>
            )}

            {!officialLoading && !officialError && (
              <Grid container spacing={2}>
                {mcpListings.map((entry) => (
                  <Grid item xs={12} sm={6} md={4} key={`mcp-${entry.id}`}>
                    <OfficialIntegrationCard
                      entry={entry}
                      actionLabel="MCP Host Required"
                      actionDisabled
                    />
                  </Grid>
                ))}
                {!officialLoading && mcpListings.length === 0 && (
                  <Grid item xs={12}>
                    <Alert severity="info">No MCP apps published yet.</Alert>
                  </Grid>
                )}
              </Grid>
            )}
          </Box>

          <Typography variant="h6" fontWeight={600} sx={{ mb: 2 }}>
            {searchQuery ? `Results for "${searchQuery}"` : 'All Apps'}
          </Typography>
          <Grid container spacing={2}>
            {loading
              ? [1, 2, 3, 4, 5, 6].map((i) => (
                  <Grid item xs={12} sm={6} md={4} lg={3} key={i}>
                    <AppCard loading />
                  </Grid>
                ))
              : apps.map((app) => (
                  <Grid item xs={12} sm={6} md={4} lg={3} key={app.id}>
                    <AppCard
                      app={app}
                      installed={isInstalled(app.id)}
                      onInstall={handleInstall}
                      onRemove={handleRemove}
                    />
                  </Grid>
                ))}
          </Grid>

          {!loading && apps.length === 0 && (
            <Box sx={{ textAlign: 'center', py: 8 }}>
              <Typography color="text.secondary">No apps published yet</Typography>
            </Box>
          )}
        </>
      )}

      {activeTab === 1 && (
        <Box>
          {!selectedPodId ? (
            <Alert severity="info">Select a pod to view installed apps</Alert>
          ) : installedApps.length === 0 ? (
            <Box sx={{ textAlign: 'center', py: 8 }}>
              <Typography variant="h6" gutterBottom>
                No apps installed yet
              </Typography>
              <Typography color="text.secondary" sx={{ mb: 3 }}>
                Browse the marketplace and install apps to get started
              </Typography>
              <Button variant="contained" onClick={() => setActiveTab(0)}>
                Browse Apps
              </Button>
            </Box>
          ) : (
            <Grid container spacing={2}>
              {installedApps.map((app) => (
                <Grid item xs={12} sm={6} md={4} key={app.installationId || app.id}>
                  <AppCard
                    app={app}
                    installed
                    onRemove={handleRemove}
                    showScopes
                  />
                </Grid>
              ))}
            </Grid>
          )}
        </Box>
      )}

      <Snackbar
        open={snackbar.open}
        autoHideDuration={3000}
        onClose={() => setSnackbar({ ...snackbar, open: false })}
        message={snackbar.message}
      />
    </Container>
  );
};

export default AppsMarketplacePage;
