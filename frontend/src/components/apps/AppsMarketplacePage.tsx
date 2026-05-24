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
import { useV2Embedded } from '../../v2/hooks/useV2Embedded';

interface Category {
  id: string;
  label: string;
}

const categories: Category[] = [
  { id: 'all', label: 'All Categories' },
  { id: 'productivity', label: 'Productivity' },
  { id: 'development', label: 'Development' },
  { id: 'analytics', label: 'Analytics' },
  { id: 'support', label: 'Support' },
  { id: 'communication', label: 'Communication' },
  { id: 'other', label: 'Other' },
];

const types: Category[] = [
  { id: 'all', label: 'All Kinds' },
  { id: 'agent', label: 'Agents' },
  { id: 'app', label: 'Apps' },
  { id: 'skill', label: 'Skills' },
  { id: 'bundle', label: 'Bundles' },
];

interface App {
  id: string;
  installableId?: string;
  name?: string;
  displayName?: string;
  description?: string;
  installationId?: string;
  instanceId?: string;
  installBackend?: 'apps' | 'registry';
  [key: string]: unknown;
}

interface OfficialEntry {
  id: string;
  name?: string;
  type?: string;
  capabilities?: string[];
  [key: string]: unknown;
}

interface IntegrationCatalogEntry {
  id: string;
  catalog?: { capabilities?: string[] };
  stats?: { activeIntegrations?: number };
}

interface IntegrationsById {
  [id: string]: IntegrationCatalogEntry;
}

interface OfficialListing extends OfficialEntry {
  capabilities: string[];
  activeCount?: number;
}

interface Pod {
  _id: string;
  name: string;
}

interface SnackbarState {
  open: boolean;
  message: string;
  severity: 'info' | 'error' | 'success' | 'warning';
}

const toMarketplaceApp = (item: any): App => {
  const installableId = String(item?.installableId ?? item?._id ?? item?.id ?? '');
  const handle = installableId.replace(/^@/, '');
  const stats = item?.stats && typeof item.stats === 'object' ? item.stats : {};
  const marketplace = item?.marketplace && typeof item.marketplace === 'object' ? item.marketplace : {};
  const requires = Array.isArray(item?.requires) ? item.requires : [];

  return {
    ...item,
    id: installableId,
    installableId,
    name: handle || String(item?.name || ''),
    displayName: String(item?.name || installableId || 'Unknown App'),
    description: String(item?.description || ''),
    type: String(item?.kind || 'default'),
    category: String(marketplace.category || 'other'),
    verified: Boolean(marketplace.verified),
    rating: Number(marketplace.rating || 0),
    ratingCount: Number(marketplace.ratingCount || 0),
    installs: Number(stats.totalInstalls || marketplace.installCount || 0),
    logo: marketplace.logoUrl || marketplace.logo || null,
    scopes: requires,
    installBackend: 'registry',
  };
};

const toInstalledRegistryApp = (agent: any): App => {
  const installableId = String(agent?.name || '');
  const handle = installableId.replace(/^@/, '');
  const profile = agent?.profile && typeof agent.profile === 'object' ? agent.profile : {};

  return {
    ...agent,
    id: installableId,
    installableId,
    name: handle,
    displayName: String(agent?.displayName || installableId || 'Unknown App'),
    description: String(profile.purpose || ''),
    type: 'agent',
    category: String(agent?.category || 'other'),
    logo: agent?.iconUrl || null,
    scopes: Array.isArray(agent?.scopes) ? agent.scopes : [],
    instanceId: String(agent?.instanceId || 'default'),
    installBackend: 'registry',
  };
};

const toInstalledLegacyApp = (app: any): App => ({
  ...app,
  id: String(app?.id || ''),
  installBackend: 'apps',
});

const AppsMarketplacePage: React.FC = () => {
  const v2Embedded = useV2Embedded();
  const theme = useTheme();
  const [apps, setApps] = useState<App[]>([]);
  const [featured, setFeatured] = useState<App[]>([]);
  const [officialEntries, setOfficialEntries] = useState<OfficialEntry[]>([]);
  const [officialLoading, setOfficialLoading] = useState(false);
  const [officialError, setOfficialError] = useState<string | null>(null);
  const [integrationEntries, setIntegrationEntries] = useState<IntegrationCatalogEntry[]>([]);
  const [integrationsLoading, setIntegrationsLoading] = useState(false);
  const [integrationsError, setIntegrationsError] = useState<string | null>(null);
  const [installedApps, setInstalledApps] = useState<App[]>([]);
  const [userPods, setUserPods] = useState<Pod[]>([]);
  const [selectedPodId, setSelectedPodId] = useState('');
  const [activeTab, setActiveTab] = useState(0);
  const [searchQuery, setSearchQuery] = useState('');
  const [category, setCategory] = useState('all');
  const [typeFilter, setTypeFilter] = useState('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [snackbar, setSnackbar] = useState<SnackbarState>({ open: false, message: '', severity: 'info' });
  const contribUrl =
    process.env.REACT_APP_MARKETPLACE_CONTRIB_URL ||
    'https://github.com/Team-Commonly/commonly/blob/main/CONTRIBUTING.md';

  const getAuthHeaders = (): Record<string, string> => {
    const token = localStorage.getItem('token');
    return { 'x-auth-token': token || '' };
  };

  useEffect(() => {
    const fetchUserPods = async (): Promise<void> => {
      try {
        const response = await axios.get('/api/pods', { headers: getAuthHeaders() });
        const pods = (response.data as Pod[]) || [];
        setUserPods(pods);
        if (!selectedPodId && pods.length > 0) {
          setSelectedPodId(pods[0]._id);
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

  const fetchMarketplace = async (): Promise<void> => {
    setLoading(true);
    setError(null);

    try {
      // PR #215/#230 backend lives at /api/marketplace/* with an Installable
      // schema. The legacy /api/apps/marketplace* routes never lit up in dev,
      // so v2 mounted this page on top of a dead endpoint surface. This wires
      // browse onto the shipped endpoint; the App[] shim below stays narrow
      // (only the fields AppCard renders).
      //
      // Param mapping: search→q (text-index search), category passthrough,
      // type→kind. sort/page/limit default to backend's installs/1/20.
      const params = new URLSearchParams();
      if (searchQuery) params.append('q', searchQuery);
      if (category !== 'all') params.append('category', category);
      if (typeFilter !== 'all') params.append('kind', typeFilter);

      const browseRes = await axios.get(`/api/marketplace/browse?${params.toString()}`);
      const items = ((browseRes.data as { items?: any[] }).items) || [];
      const mapped: App[] = items.map(toMarketplaceApp);

      setApps(mapped);
      // Featured shelf isn't shipped on the new endpoint family yet; surface
      // the first 4 of the browse list as a stand-in so the row isn't empty.
      setFeatured(mapped.slice(0, 4));
    } catch (err) {
      console.error('Error loading marketplace apps:', err);
      setError('Failed to load apps marketplace');
      setApps([]);
    } finally {
      setLoading(false);
    }
  };

  const fetchOfficialMarketplace = async (): Promise<void> => {
    setOfficialLoading(true);
    setOfficialError(null);
    try {
      const response = await axios.get('/api/marketplace/official');
      setOfficialEntries((response.data as { entries?: OfficialEntry[] })?.entries || []);
    } catch (err) {
      console.error('Error loading official marketplace:', err);
      setOfficialError('Failed to load official marketplace.');
      setOfficialEntries([]);
    } finally {
      setOfficialLoading(false);
    }
  };

  const fetchIntegrations = async (): Promise<void> => {
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
      setIntegrationEntries((response.data as { entries?: IntegrationCatalogEntry[] })?.entries || []);
    } catch (err) {
      console.error('Error loading integrations catalog:', err);
      setIntegrationsError('Failed to load integrations catalog.');
    } finally {
      setIntegrationsLoading(false);
    }
  };

  const fetchInstalled = async (): Promise<void> => {
    try {
      const [legacyRes, registryRes] = await Promise.allSettled([
        axios.get(`/api/apps/pods/${selectedPodId}/apps`, {
          headers: getAuthHeaders(),
        }),
        axios.get(`/api/registry/pods/${selectedPodId}/agents`, {
          headers: getAuthHeaders(),
        }),
      ]);

      const legacyApps = legacyRes.status === 'fulfilled'
        ? (((legacyRes.value.data as { apps?: any[] }).apps) || []).map(toInstalledLegacyApp)
        : [];
      const registryApps = registryRes.status === 'fulfilled'
        ? (((registryRes.value.data as { agents?: any[] }).agents) || []).map(toInstalledRegistryApp)
        : [];

      setInstalledApps([...legacyApps, ...registryApps]);
    } catch (err) {
      console.error('Error fetching installed apps:', err);
    }
  };

  const handleInstall = async (app: App): Promise<void> => {
    if (!selectedPodId) {
      setSnackbar({ open: true, message: 'Select a pod to install', severity: 'warning' });
      return;
    }

    try {
      const installableId = String(app.installableId || app.id || '');
      await axios.post('/api/registry/install', {
        agentName: installableId,
        podId: selectedPodId,
        version: typeof app.version === 'string' ? app.version : undefined,
        displayName: app.displayName || undefined,
        scopes: Array.isArray(app.scopes) ? app.scopes : [],
      }, { headers: getAuthHeaders() });
      setSnackbar({ open: true, message: `Installed ${app.displayName || app.name}`, severity: 'success' });
      fetchInstalled();
    } catch (err) {
      const e = err as { response?: { data?: { error?: string } } };
      console.error('Error installing app:', err);
      setSnackbar({
        open: true,
        message: e.response?.data?.error || 'Failed to install app',
        severity: 'error',
      });
    }
  };

  const handleRemove = async (app: App): Promise<void> => {
    if (!selectedPodId) return;

    try {
      if (app.installBackend === 'registry') {
        const installableId = encodeURIComponent(String(app.installableId || app.id || ''));
        const params = new URLSearchParams();
        if (app.instanceId && app.instanceId !== 'default') {
          params.append('instanceId', app.instanceId);
        }
        const suffix = params.toString() ? `?${params.toString()}` : '';
        await axios.delete(`/api/registry/agents/${installableId}/pods/${selectedPodId}${suffix}`, {
          headers: getAuthHeaders(),
        });
      } else {
        await axios.delete(`/api/apps/pods/${selectedPodId}/apps/${app.installationId}`, {
          headers: getAuthHeaders(),
        });
      }
      setSnackbar({ open: true, message: `Removed ${app.displayName || app.name}`, severity: 'info' });
      fetchInstalled();
    } catch (err) {
      console.error('Error removing app:', err);
      setSnackbar({ open: true, message: 'Failed to remove app', severity: 'error' });
    }
  };

  const isInstalled = (appId: string): boolean => installedApps.some((a) => a.id === appId);
  const integrationsById: IntegrationsById = integrationEntries.reduce((acc, entry) => {
    acc[entry.id] = entry;
    return acc;
  }, {} as IntegrationsById);

  const officialListings: OfficialListing[] = officialEntries.map((entry) => {
    const integrationInfo = integrationsById[entry.id];
    return {
      ...entry,
      capabilities: integrationInfo?.catalog?.capabilities || (entry.capabilities as string[]) || [],
      activeCount: integrationInfo?.stats?.activeIntegrations,
    };
  });
  const officialIntegrations = officialListings.filter((entry) => entry.type !== 'mcp-app');
  const mcpListings = officialListings.filter((entry) => entry.type === 'mcp-app');

  const handleConnect = (entry: OfficialEntry): void => {
    setSnackbar({
      open: true,
      message: `Open a pod to connect ${entry.name}.`,
      severity: 'info',
    });
    window.location.href = '/pods';
  };

  return (
    <Container
      className="v2-apps-marketplace"
      maxWidth="xl"
      disableGutters
      sx={{ py: v2Embedded ? 0 : { xs: 3, md: 4 }, px: v2Embedded ? 0 : { xs: 2, sm: 3, md: 4 } }}
    >
      {/* Hero section — gradient backdrop with a large headline, subtitle,
          and inline search. The v2 shell already names the page, so under v2
          we collapse this into a compact controls row to remove the
          duplicated marketing intro. */}
      {v2Embedded ? (
        <>
          <Box sx={{ borderBottom: 1, borderColor: 'divider', mb: 2 }}>
            <Tabs value={activeTab} onChange={(_e: React.SyntheticEvent, v: number) => setActiveTab(v)}>
              <Tab label={`Discover (${apps.length})`} icon={<AppsIcon />} iconPosition="start" />
              <Tab label={`Installed (${installedApps.length})`} />
            </Tabs>
          </Box>
          <Box className="v2-filter-bar">
            <TextField
              className="v2-filter-bar__search"
              placeholder="Search apps, agents, integrations..."
              size="small"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              InputProps={{
                startAdornment: (
                  <InputAdornment position="start">
                    <SearchIcon fontSize="small" />
                  </InputAdornment>
                ),
              }}
            />
            <FormControl className="v2-filter-bar__control" size="small">
              <InputLabel>Type</InputLabel>
              <Select
                value={typeFilter}
                label="Type"
                onChange={(e) => setTypeFilter(e.target.value as string)}
              >
                {types.map((t) => (
                  <MenuItem key={t.id} value={t.id}>
                    {t.label}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
            <FormControl className="v2-filter-bar__control" size="small">
              <InputLabel>Category</InputLabel>
              <Select
                value={category}
                label="Category"
                onChange={(e) => setCategory(e.target.value as string)}
              >
                {categories.map((cat) => (
                  <MenuItem key={cat.id} value={cat.id}>
                    {cat.label}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
            <FormControl className="v2-filter-bar__control" size="small">
              <InputLabel>Install to Pod</InputLabel>
              <Select
                value={selectedPodId || ''}
                label="Install to Pod"
                onChange={(e) => setSelectedPodId(e.target.value as string)}
              >
                {userPods.map((pod) => (
                  <MenuItem key={pod._id} value={pod._id}>
                    {pod.name}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
            <Button
              className="v2-filter-bar__action"
              variant="outlined"
              size="small"
              startIcon={<RefreshIcon />}
              onClick={fetchMarketplace}
            >
              Refresh
            </Button>
            <Button
              className="v2-filter-bar__action"
              variant="outlined"
              size="small"
              href={contribUrl}
              target="_blank"
              rel="noreferrer"
            >
              Submit App
            </Button>
            <span className="v2-filter-bar__summary">
              {activeTab === 0 ? `${apps.length} results` : `${installedApps.length} installed`}
            </span>
          </Box>
        </>
      ) : (
        <Box
          className="v2-apps-hero"
          sx={{
            mb: 4,
            px: { xs: 3, md: 6 },
            py: { xs: 4, md: 6 },
            borderRadius: 3,
            background: `linear-gradient(135deg, ${theme.palette.primary.main} 0%, ${theme.palette.primary.dark || theme.palette.primary.main} 60%, ${theme.palette.secondary.main || theme.palette.primary.main} 100%)`,
            color: theme.palette.primary.contrastText,
            position: 'relative',
            overflow: 'hidden',
          }}
        >
          <Box sx={{ position: 'relative', zIndex: 1, maxWidth: 920 }}>
            <Typography variant="h3" fontWeight={800} sx={{ mb: 1.5, lineHeight: 1.15 }}>
              Discover apps to extend your Commonly pods
            </Typography>
            <Typography variant="body1" sx={{ opacity: 0.92, mb: 3, maxWidth: 640 }}>
              Browse agents, integrations, and webhook apps built by the community.
              Install one into a pod in seconds — your agents and teammates will see it instantly.
            </Typography>
            <Box
              sx={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: 1.5,
                alignItems: 'center',
              }}
            >
              <TextField
                placeholder="Search apps, agents, integrations..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                InputProps={{
                  startAdornment: (
                    <InputAdornment position="start">
                      <SearchIcon sx={{ color: 'text.secondary' }} />
                    </InputAdornment>
                  ),
                }}
                sx={{
                  flex: '1 1 320px',
                  minWidth: { xs: '100%', sm: 320 },
                  '& .MuiOutlinedInput-root': {
                    borderRadius: 999,
                    backgroundColor: theme.palette.background.paper,
                  },
                  '& .MuiOutlinedInput-notchedOutline': { border: 'none' },
                }}
              />
              <FormControl
                size="small"
                sx={{
                  minWidth: { xs: '100%', sm: 200 },
                  '& .MuiOutlinedInput-root': {
                    borderRadius: 999,
                    backgroundColor: theme.palette.background.paper,
                  },
                  '& .MuiOutlinedInput-notchedOutline': { border: 'none' },
                }}
              >
                <InputLabel>Install to Pod</InputLabel>
                <Select
                  value={selectedPodId || ''}
                  label="Install to Pod"
                  onChange={(e) => setSelectedPodId(e.target.value as string)}
                >
                  {userPods.map((pod) => (
                    <MenuItem key={pod._id} value={pod._id}>
                      {pod.name}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
              <Button
                variant="contained"
                color="inherit"
                href={contribUrl}
                target="_blank"
                rel="noreferrer"
                sx={{
                  borderRadius: 999,
                  fontWeight: 600,
                  backgroundColor: theme.palette.background.paper,
                  color: theme.palette.text.primary,
                  '&:hover': { backgroundColor: theme.palette.background.default },
                }}
              >
                Submit App
              </Button>
            </Box>
          </Box>
        </Box>
      )}

      {!v2Embedded && (
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1.5, mb: 3 }}>
        <FormControl sx={{ minWidth: { xs: '100%', sm: 180 }, flex: '1 1 180px' }} size="small">
          <InputLabel>Type</InputLabel>
          <Select
            value={typeFilter}
            label="Type"
            onChange={(e) => setTypeFilter(e.target.value as string)}
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
      )}

      {!v2Embedded && (
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
      )}

      <Box sx={{ borderBottom: 1, borderColor: 'divider', mb: 3, display: v2Embedded ? 'none' : 'block' }}>
        <Tabs value={activeTab} onChange={(_e: React.SyntheticEvent, v: number) => setActiveTab(v)}>
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
              {/* Horizontal scroll strip so featured apps don't compete with
                  the main grid for vertical real estate. Snap-scroll on
                  touch; arrows show on desktop hover. */}
              <Box
                sx={{
                  display: 'flex',
                  gap: 2,
                  overflowX: 'auto',
                  pb: 1,
                  scrollSnapType: 'x mandatory',
                  '&::-webkit-scrollbar': { height: 8 },
                  '&::-webkit-scrollbar-thumb': {
                    backgroundColor: theme.palette.divider,
                    borderRadius: 4,
                  },
                }}
              >
                {featured.map((app) => (
                  <Box
                    key={app.id}
                    sx={{
                      flex: '0 0 auto',
                      width: { xs: 280, sm: 320, md: 340 },
                      scrollSnapAlign: 'start',
                    }}
                  >
                    <AppCard
                      app={app}
                      installed={isInstalled(app.id)}
                      onInstall={handleInstall}
                      onRemove={handleRemove}
                    />
                  </Box>
                ))}
              </Box>
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
                    {/* eslint-disable-next-line @typescript-eslint/ban-ts-comment */}
                    {/* @ts-ignore — AppCard is a JS component; loading skeleton omits app prop intentionally */}
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
