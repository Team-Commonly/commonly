import React, { useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import {
  Box,
  Button,
  Card,
  CardActions,
  CardContent,
  Chip,
  Container,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  FormControl,
  FormControlLabel,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  Switch,
  Tabs,
  Tab,
  TextField,
  Typography,
} from '@mui/material';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import { useAuth } from '../../context/AuthContext';

const getAuthHeaders = () => {
  const token = localStorage.getItem('token');
  return { headers: { Authorization: `Bearer ${token}` } };
};

const SkillsCatalogPage = () => {
  const [catalogItems, setCatalogItems] = useState([]);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState('');
  const [catalogPage, setCatalogPage] = useState(1);
  const [catalogTotalPages, setCatalogTotalPages] = useState(1);
  const [catalogTotalItems, setCatalogTotalItems] = useState(0);
  const [categories, setCategories] = useState([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('all');
  const [groupByCategory, setGroupByCategory] = useState(true);
  const [activeTab, setActiveTab] = useState('catalog');
  const { currentUser } = useAuth();
  const isGlobalAdmin = currentUser?.role === 'admin';

  const [pods, setPods] = useState([]);
  const [selectedPodId, setSelectedPodId] = useState('');
  const [podAgents, setPodAgents] = useState([]);

  const [importOpen, setImportOpen] = useState(false);
  const [licenseOpen, setLicenseOpen] = useState(false);
  const [licenseState, setLicenseState] = useState({ title: '', text: '', path: '' });
  const [requirementsLoading, setRequirementsLoading] = useState(false);
  const [requirementsError, setRequirementsError] = useState('');
  const [requirementsList, setRequirementsList] = useState([]);
  const [gatewayLoading, setGatewayLoading] = useState(false);
  const [gatewayError, setGatewayError] = useState('');
  const [gatewayEntries, setGatewayEntries] = useState({});
  const [gatewayId, setGatewayId] = useState('');
  const [gatewaySkillKey, setGatewaySkillKey] = useState('');
  const [gatewayHintLoading, setGatewayHintLoading] = useState(false);
  const [gatewayHintError, setGatewayHintError] = useState('');
  const [gatewayHintList, setGatewayHintList] = useState([]);
  const [gatewayEnvInputs, setGatewayEnvInputs] = useState({});
  const [gatewayEnvClears, setGatewayEnvClears] = useState(new Set());
  const [gatewayCustomKey, setGatewayCustomKey] = useState('');
  const [gatewayCustomValue, setGatewayCustomValue] = useState('');
  const [gatewaySaving, setGatewaySaving] = useState(false);
  const [gatewayList, setGatewayList] = useState([]);
  const [gatewayDialogOpen, setGatewayDialogOpen] = useState(false);
  const [gatewayForm, setGatewayForm] = useState({
    name: '',
    slug: '',
    mode: 'local',
    baseUrl: '',
    configPath: '',
    namespace: 'commonly-dev',
    image: '',
  });
  const [gatewayCreateLoading, setGatewayCreateLoading] = useState(false);
  const [gatewayCreateError, setGatewayCreateError] = useState('');
  const [importedSkills, setImportedSkills] = useState(new Set());
  const [installedItems, setInstalledItems] = useState([]);
  const [importState, setImportState] = useState({
    podId: '',
    scope: 'pod',
    agentKey: '',
    name: '',
    tags: '',
    sourceUrl: '',
    license: '',
    description: '',
  });

  const selectedPodName = useMemo(() => {
    const pod = pods.find((p) => p._id === importState.podId);
    return pod?.name || '';
  }, [pods, importState.podId]);

  const selectedAgent = useMemo(() => {
    if (!importState.agentKey) return null;
    return podAgents.find((agent) => `${agent.name}:${agent.instanceId}` === importState.agentKey);
  }, [podAgents, importState.agentKey]);

  const normalizeSkillKey = (value) => String(value || '').trim().toLowerCase();

  const catalogSkillOptions = useMemo(() => {
    const map = new Map();
    catalogItems.forEach((item) => {
      if (!item?.name) return;
      const key = normalizeSkillKey(item.name);
      if (!map.has(key)) {
        map.set(key, item);
      }
    });
    return Array.from(map.values()).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  }, [catalogItems]);

  const gatewaySkillOptions = useMemo(() => {
    if (selectedPodId && installedItems.length > 0) {
      const map = new Map();
      installedItems.forEach((item) => {
        if (!item?.name) return;
        const key = normalizeSkillKey(item.name);
        if (!map.has(key)) {
          map.set(key, item);
        }
      });
      return Array.from(map.values()).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    }
    return catalogSkillOptions;
  }, [selectedPodId, installedItems, catalogSkillOptions]);

  const getCategory = (item) => {
    if (item?.category) return item.category;
    return 'Other';
  };

  const filteredItems = useMemo(() => {
    const term = searchTerm.trim().toLowerCase();
    return catalogItems.filter((item) => {
      if (selectedCategory !== 'all' && getCategory(item) !== selectedCategory) return false;
      if (!term) return true;
      const haystack = `${item.name || ''} ${item.description || ''}`.toLowerCase();
      return haystack.includes(term);
    });
  }, [catalogItems, searchTerm, selectedCategory]);

  const groupedItems = useMemo(() => {
    if (!groupByCategory) {
      return [{ category: 'All Skills', items: filteredItems }];
    }
    const groups = new Map();
    filteredItems.forEach((item) => {
      const category = getCategory(item);
      if (!groups.has(category)) groups.set(category, []);
      groups.get(category).push(item);
    });
    return Array.from(groups.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([category, items]) => ({ category, items }));
  }, [filteredItems, groupByCategory]);

  const fetchCatalog = async () => {
    setCatalogLoading(true);
    setCatalogError('');
    try {
      const response = await axios.get('/api/skills/catalog', {
        ...getAuthHeaders(),
        params: {
          source: 'awesome',
          q: searchTerm || undefined,
          category: selectedCategory !== 'all' ? selectedCategory : undefined,
          page: catalogPage,
          limit: 60,
        },
      });
      setCatalogItems(response.data?.items || []);
      setCatalogTotalPages(response.data?.totalPages || 1);
      setCatalogTotalItems(response.data?.total || 0);
      setCategories(response.data?.categories || []);
    } catch (error) {
      console.error('Failed to fetch skills catalog:', error);
      setCatalogError(error.response?.data?.error || 'Failed to load catalog');
      setCatalogItems([]);
    } finally {
      setCatalogLoading(false);
    }
  };

  const fetchPods = async () => {
    try {
      const response = await axios.get('/api/pods', getAuthHeaders());
      setPods(response.data || []);
    } catch (error) {
      console.error('Failed to fetch pods:', error);
    }
  };

  const fetchPodAgents = async (podId) => {
    if (!podId) {
      setPodAgents([]);
      return;
    }
    try {
      const response = await axios.get(`/api/registry/pods/${podId}/agents`, getAuthHeaders());
      setPodAgents(response.data?.agents || []);
    } catch (error) {
      console.warn('Failed to fetch pod agents:', error.response?.status);
      setPodAgents([]);
    }
  };

  const fetchImportedSkills = async (podId, scope, agent) => {
    if (!podId) {
      setImportedSkills(new Set());
      return;
    }
    try {
      const params = { scope };
      if (scope === 'agent') {
        params.agentName = agent?.name;
        params.instanceId = agent?.instanceId;
      }
      const response = await axios.get(`/api/skills/pods/${podId}/imported`, {
        ...getAuthHeaders(),
        params,
      });
      const items = response.data?.items || [];
      const names = items
        .map((item) => (item?.name || '').toLowerCase())
        .filter(Boolean);
      setImportedSkills(new Set(names));
      setInstalledItems(items);
    } catch (error) {
      console.warn('Failed to fetch imported skills:', error.response?.status);
      setImportedSkills(new Set());
      setInstalledItems([]);
    }
  };

  const fetchSkillRequirements = async (sourceUrl) => {
    if (!sourceUrl) {
      setRequirementsList([]);
      setRequirementsError('');
      return;
    }
    setRequirementsLoading(true);
    setRequirementsError('');
    try {
      const response = await axios.get('/api/skills/requirements', {
        ...getAuthHeaders(),
        params: { sourceUrl },
      });
      const requirements = response.data?.requirements || [];
      setRequirementsList(requirements);
    } catch (error) {
      console.warn('Failed to fetch skill requirements:', error);
      setRequirementsError(error.response?.data?.error || 'Failed to detect credentials');
      setRequirementsList([]);
    } finally {
      setRequirementsLoading(false);
    }
  };

  const fetchGatewayCredentials = async () => {
    if (!isGlobalAdmin) return;
    setGatewayLoading(true);
    setGatewayError('');
    try {
      const gatewaysResponse = await axios.get('/api/gateways', getAuthHeaders());
      const gateways = gatewaysResponse.data?.gateways || [];
      setGatewayList(gateways);
      const selectedGatewayId = gateways.find((g) => g._id === gatewayId)?._id
        || gateways[0]?._id
        || '';
      if (selectedGatewayId && !gatewayId) {
        setGatewayId(selectedGatewayId);
      }
      const response = await axios.get('/api/skills/gateway-credentials', {
        ...getAuthHeaders(),
        params: selectedGatewayId ? { gatewayId: selectedGatewayId } : {},
      });
      setGatewayEntries(response.data?.entries || {});
    } catch (error) {
      console.warn('Failed to load gateway credentials:', error);
      setGatewayError(error.response?.data?.error || 'Failed to load gateway credentials');
      setGatewayEntries({});
    } finally {
      setGatewayLoading(false);
    }
  };

  const fetchGatewayHints = async (skillName) => {
    if (!skillName) return;
    setGatewayHintLoading(true);
    setGatewayHintError('');
    setGatewayHintList([]);
    try {
      const selected = gatewaySkillOptions.find(
        (item) => normalizeSkillKey(item?.name) === normalizeSkillKey(skillName),
      );
      const sourceUrl = selected?.sourceUrl;
      if (!sourceUrl) {
        setGatewayHintError('No source URL found for this skill.');
        setGatewayHintLoading(false);
        return;
      }
      const response = await axios.get('/api/skills/requirements', {
        ...getAuthHeaders(),
        params: { sourceUrl },
      });
      setGatewayHintList(response.data?.requirements || []);
    } catch (error) {
      console.warn('Failed to load gateway hints:', error);
      setGatewayHintError(error.response?.data?.error || 'Failed to detect credentials');
    } finally {
      setGatewayHintLoading(false);
    }
  };

  const updateGatewayEnvInput = (key, value) => {
    setGatewayEnvInputs((prev) => ({ ...prev, [key]: value }));
    setGatewayEnvClears((prev) => {
      const next = new Set(prev);
      if (value) {
        next.delete(key);
      }
      return next;
    });
  };

  const markGatewayClear = (key) => {
    setGatewayEnvClears((prev) => new Set([...prev, key]));
    setGatewayEnvInputs((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

  const addGatewayCustomEnv = () => {
    const key = gatewayCustomKey.trim();
    if (!key) return;
    updateGatewayEnvInput(key, gatewayCustomValue.trim());
    setGatewayCustomKey('');
    setGatewayCustomValue('');
  };

  const saveGatewayCredentials = async () => {
    if (!gatewayId || !gatewaySkillKey) return;
    const env = {};
    Object.entries(gatewayEnvInputs).forEach(([key, value]) => {
      if (value) env[key] = value;
    });
    gatewayEnvClears.forEach((key) => {
      if (!(key in env)) env[key] = '';
    });
    if (!Object.keys(env).length) {
      alert('Add at least one key or clear an existing key before saving.');
      return;
    }
    setGatewaySaving(true);
    try {
      await axios.patch('/api/skills/gateway-credentials', {
        gatewayId,
        entries: {
          [gatewaySkillKey]: env,
        },
      }, getAuthHeaders());
      await fetchGatewayCredentials();
      setGatewayEnvInputs({});
      setGatewayEnvClears(new Set());
    } catch (error) {
      console.error('Failed to save gateway credentials:', error);
      alert(error.response?.data?.error || 'Failed to save credentials');
    } finally {
      setGatewaySaving(false);
    }
  };

  const openGatewayDialog = () => {
    setGatewayCreateError('');
    setGatewayDialogOpen(true);
  };

  const closeGatewayDialog = () => {
    setGatewayDialogOpen(false);
  };

  const handleCreateGateway = async () => {
    if (!gatewayForm.name.trim()) {
      setGatewayCreateError('Name is required.');
      return;
    }
    setGatewayCreateLoading(true);
    setGatewayCreateError('');
    try {
      const payload = {
        name: gatewayForm.name.trim(),
        slug: gatewayForm.slug.trim() || undefined,
        mode: gatewayForm.mode,
        baseUrl: gatewayForm.baseUrl.trim(),
        configPath: gatewayForm.configPath.trim(),
        metadata: {
          namespace: gatewayForm.namespace.trim(),
          image: gatewayForm.image.trim(),
        },
      };
      await axios.post('/api/gateways', payload, getAuthHeaders());
      await fetchGatewayCredentials();
      setGatewayDialogOpen(false);
      setGatewayForm({
        name: '',
        slug: '',
        mode: 'local',
        baseUrl: '',
        configPath: '',
        namespace: 'commonly-dev',
        image: '',
      });
    } catch (error) {
      console.error('Failed to create gateway:', error);
      setGatewayCreateError(error.response?.data?.error || 'Failed to create gateway');
    } finally {
      setGatewayCreateLoading(false);
    }
  };

  useEffect(() => {
    fetchCatalog();
    fetchPods();
  }, []);

  useEffect(() => {
    setCatalogPage(1);
  }, [searchTerm, selectedCategory]);

  useEffect(() => {
    fetchCatalog();
  }, [searchTerm, selectedCategory, catalogPage]);

  useEffect(() => {
    if (activeTab === 'gateway') {
      fetchGatewayCredentials();
    }
  }, [activeTab]);

  useEffect(() => {
    if (selectedPodId) {
      fetchPodAgents(selectedPodId);
      fetchImportedSkills(selectedPodId, 'pod', null);
    }
  }, [selectedPodId]);

  useEffect(() => {
    if (selectedPodId) {
      setImportState((prev) => ({ ...prev, podId: selectedPodId }));
    }
  }, [selectedPodId]);

  useEffect(() => {
    if (importState.podId) {
      fetchPodAgents(importState.podId);
      fetchImportedSkills(importState.podId, importState.scope, selectedAgent);
    }
  }, [importState.podId, importState.scope, selectedAgent]);

  useEffect(() => {
    if (!importOpen) return;
    fetchSkillRequirements(importState.sourceUrl);
  }, [importOpen, importState.sourceUrl]);

  useEffect(() => {
    if (importState.scope !== 'agent') {
      setImportState((prev) => ({ ...prev, agentKey: '' }));
    }
  }, [importState.scope]);

  useEffect(() => {
    if (activeTab !== 'gateway') return;
    if (!gatewaySkillKey && gatewaySkillOptions.length > 0) {
      setGatewaySkillKey(gatewaySkillOptions[0].name);
    }
  }, [activeTab, gatewaySkillKey, gatewaySkillOptions]);

  useEffect(() => {
    if (activeTab !== 'gateway') return;
    if (!gatewaySkillKey) return;
    fetchGatewayHints(gatewaySkillKey);
    setGatewayEnvInputs({});
    setGatewayEnvClears(new Set());
  }, [activeTab, gatewaySkillKey]);

  useEffect(() => {
    if (activeTab !== 'gateway') return;
    if (!gatewayId) return;
    fetchGatewayCredentials();
  }, [activeTab, gatewayId]);

  const openImportDialog = (item) => {
    setImportState({
      podId: selectedPodId || '',
      scope: 'pod',
      agentKey: '',
      name: item?.name || '',
      tags: (item?.tags || []).join(', '),
      sourceUrl: item?.sourceUrl || '',
      license: item?.license?.name || item?.license || '',
      description: item?.description || '',
    });
    setImportOpen(true);
  };

  const openLicenseDialog = (item) => {
    const license = item?.license || {};
    const title = license.name || 'License';
    const text = license.text || 'No license text available.';
    const path = license.path || '';
    setLicenseState({ title, text, path });
    setLicenseOpen(true);
  };

  const closeLicenseDialog = () => {
    setLicenseOpen(false);
  };

  const closeImportDialog = () => {
    setImportOpen(false);
    setRequirementsList([]);
    setRequirementsError('');
    setRequirementsLoading(false);
  };

  const isImported = (itemName) => {
    if (!itemName) return false;
    return importedSkills.has(itemName.toLowerCase());
  };

  const handleImport = async () => {
    const payload = {
      podId: importState.podId,
      name: importState.name,
      content: '',
      tags: importState.tags
        ? importState.tags.split(',').map((t) => t.trim()).filter(Boolean)
        : [],
      sourceUrl: importState.sourceUrl,
      license: importState.license,
      scope: importState.scope,
      agentName: importState.scope === 'agent' ? selectedAgent?.name : undefined,
      instanceId: importState.scope === 'agent' ? selectedAgent?.instanceId : undefined,
      description: importState.description,
    };

    try {
      await axios.post('/api/skills/import', payload, getAuthHeaders());
      setImportedSkills((prev) => {
        const next = new Set(prev);
        if (importState.name) {
          next.add(importState.name.toLowerCase());
        }
        return next;
      });
      closeImportDialog();
    } catch (error) {
      console.error('Failed to import skill:', error);
      alert(error.response?.data?.error || 'Failed to import skill');
    }
  };

  const handleUninstall = async (itemName) => {
    if (!importState.podId || !itemName) return;
    try {
      const params = {
        name: itemName,
        scope: importState.scope,
      };
      if (importState.scope === 'agent') {
        params.agentName = selectedAgent?.name;
        params.instanceId = selectedAgent?.instanceId;
      }
      await axios.delete(`/api/skills/pods/${importState.podId}/imported`, {
        ...getAuthHeaders(),
        params,
      });
      await fetchImportedSkills(importState.podId, importState.scope, selectedAgent);
      setImportedSkills((prev) => {
        const next = new Set(prev);
        next.delete(String(itemName || '').toLowerCase());
        return next;
      });
    } catch (error) {
      console.error('Failed to uninstall skill:', error);
      alert(error.response?.data?.error || 'Failed to uninstall skill');
    }
  };

  return (
    <Container maxWidth="lg" sx={{ py: 4 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 3 }}>
        <AutoAwesomeIcon sx={{ color: '#7DD3FC' }} />
        <Typography variant="h4">Skills Catalog</Typography>
      </Box>

      <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap', mb: 3 }}>
        <FormControl sx={{ minWidth: 240 }}>
          <InputLabel id="pod-select-label">Target Pod</InputLabel>
          <Select
            labelId="pod-select-label"
            value={selectedPodId}
            label="Target Pod"
            onChange={(event) => setSelectedPodId(event.target.value)}
          >
            <MenuItem value="">
              <em>Select a pod</em>
            </MenuItem>
            {pods.map((pod) => (
              <MenuItem key={pod._id} value={pod._id}>
                {pod.name}
              </MenuItem>
            ))}
          </Select>
        </FormControl>

        <TextField
          label="Search skills"
          value={searchTerm}
          onChange={(event) => setSearchTerm(event.target.value)}
          sx={{ minWidth: 260 }}
        />

        <FormControl sx={{ minWidth: 220 }}>
          <InputLabel id="vendor-filter-label">Category</InputLabel>
          <Select
            labelId="vendor-filter-label"
            value={selectedCategory}
            label="Category"
            onChange={(event) => setSelectedCategory(event.target.value)}
          >
            <MenuItem value="all">All categories</MenuItem>
            {categories.map((category) => (
              <MenuItem key={category} value={category}>
                {category}
              </MenuItem>
            ))}
          </Select>
        </FormControl>

        <FormControlLabel
          control={
            <Switch
              checked={groupByCategory}
              onChange={(event) => setGroupByCategory(event.target.checked)}
            />
          }
          label="Group by category"
        />
        <Tabs value={activeTab} onChange={(event, value) => setActiveTab(value)}>
          <Tab value="catalog" label={`Catalog (${catalogTotalItems})`} />
          <Tab value="installed" label={`Installed (${importedSkills.size})`} />
          {isGlobalAdmin && <Tab value="gateway" label="Gateway Credentials" />}
        </Tabs>
      </Box>

      {catalogLoading && <Typography>Loading catalog...</Typography>}
      {catalogError && <Typography color="error">{catalogError}</Typography>}

      {activeTab === 'catalog' && !catalogLoading && catalogItems.length === 0 && (
        <Typography color="text.secondary">
          No catalog items yet. Populate the catalog index to list skills.
        </Typography>
      )}

      {activeTab === 'catalog' && (
      <Stack spacing={3}>
        {groupedItems.map((group) => (
          <Box key={group.category}>
            <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}>
              <Typography variant="h6" sx={{ textTransform: 'capitalize' }}>
                {group.category}
              </Typography>
              <Chip size="small" label={`${group.items.length} skills`} />
            </Stack>
            <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))' }}>
              {group.items.map((item) => (
                <Card key={item.id || item.name}>
                  <CardContent>
                    <Typography variant="h6">{item.name}</Typography>
                    <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                      {item.description || 'No description'}
                    </Typography>
                    {item.type && (
                      <Chip
                        size="small"
                        label={item.type === 'plugin' ? 'Plugin' : 'Skill'}
                        sx={{ mb: 1 }}
                      />
                    )}
                    {item.license && (
                      <Chip
                        size="small"
                        label={`License: ${item.license.name || item.license}`}
                        onClick={() => openLicenseDialog(item)}
                        sx={{ mb: 1, cursor: 'pointer' }}
                      />
                    )}
                    {item.tags?.length ? (
                      <Stack direction="row" spacing={1} flexWrap="wrap">
                        {item.tags.map((tag) => (
                          <Chip key={tag} size="small" label={tag} />
                        ))}
                      </Stack>
                    ) : null}
                  </CardContent>
                  <Divider />
                  <CardActions sx={{ justifyContent: 'space-between' }}>
                    <Button
                      size="small"
                      href={item.sourceUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      View Source
                    </Button>
                    {item.license && (
                      <Button
                        size="small"
                        variant="text"
                        onClick={() => openLicenseDialog(item)}
                      >
                        View License
                      </Button>
                    )}
                    <Button
                      size="small"
                      variant="contained"
                      disabled={!selectedPodId || item.type === 'plugin' || isImported(item.name)}
                      onClick={() => openImportDialog(item)}
                    >
                      {isImported(item.name) ? 'Imported' : (item.type === 'plugin' ? 'Plugin' : 'Import')}
                    </Button>
                  </CardActions>
                </Card>
              ))}
            </Box>
          </Box>
        ))}
        <Stack direction="row" spacing={2} alignItems="center" justifyContent="flex-end">
          <Button
            size="small"
            disabled={catalogPage <= 1}
            onClick={() => setCatalogPage((prev) => Math.max(1, prev - 1))}
          >
            Prev
          </Button>
          <Typography variant="body2">
            Page {catalogPage} of {catalogTotalPages}
          </Typography>
          <Button
            size="small"
            disabled={catalogPage >= catalogTotalPages}
            onClick={() => setCatalogPage((prev) => Math.min(catalogTotalPages, prev + 1))}
          >
            Next
          </Button>
        </Stack>
      </Stack>
      )}

      {activeTab === 'installed' && (
        <Stack spacing={2}>
          {!selectedPodId && (
            <Typography color="text.secondary">Select a pod to view installed skills.</Typography>
          )}
          {selectedPodId && importedSkills.size === 0 && (
            <Typography color="text.secondary">No imported skills yet.</Typography>
          )}
          {selectedPodId && installedItems.map((item) => (
            <Card key={item.name}>
              <CardContent>
                <Typography variant="h6">{item.name}</Typography>
                <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                  {item.description || 'No description'}
                </Typography>
                {item.sourceUrl && (
                  <Button
                    size="small"
                    href={item.sourceUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    View Source
                  </Button>
                )}
              </CardContent>
              <Divider />
              <CardActions sx={{ justifyContent: 'flex-end' }}>
                <Button
                  size="small"
                  color="error"
                  onClick={() => handleUninstall(item.name)}
                >
                  Uninstall
                </Button>
              </CardActions>
            </Card>
          ))}
        </Stack>
      )}

      {activeTab === 'gateway' && isGlobalAdmin && (
        <Card>
          <CardContent>
            <Typography variant="h6" sx={{ mb: 1 }}>
              Gateway Skill Credentials
            </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                These credentials apply to all agents running on this host gateway. Store only what you intend
                to share across agents.
              </Typography>
              <Box sx={{ display: 'flex', justifyContent: 'flex-end', mb: 2 }}>
                <Button variant="outlined" onClick={openGatewayDialog}>
                  Add Gateway
                </Button>
              </Box>
            {gatewayLoading && <Typography>Loading gateway credentials...</Typography>}
            {gatewayError && <Typography color="error">{gatewayError}</Typography>}
            {!gatewayLoading && (
              <Stack spacing={2}>
                {selectedPodId ? (
                  <Typography variant="body2" color="text.secondary">
                    Showing skills installed in this pod. Use the pod selector above to change scope.
                  </Typography>
                ) : (
                  <Typography variant="body2" color="text.secondary">
                    Select a pod to filter skills to installed ones.
                  </Typography>
                )}
                <FormControl fullWidth>
                <InputLabel id="gateway-select-label">Gateway</InputLabel>
                <Select
                  labelId="gateway-select-label"
                  label="Gateway"
                  value={gatewayId}
                  onChange={(event) => setGatewayId(event.target.value)}
                >
                  {gatewayList.map((gateway) => (
                    <MenuItem key={gateway._id} value={gateway._id}>
                      {gateway.name}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
                <FormControl fullWidth>
                  <InputLabel id="gateway-skill-label">Skill</InputLabel>
                  <Select
                    labelId="gateway-skill-label"
                    label="Skill"
                    value={gatewaySkillKey}
                    onChange={(event) => setGatewaySkillKey(event.target.value)}
                  >
                    {gatewaySkillOptions.map((item) => (
                      <MenuItem key={item.name} value={item.name}>
                        {item.name}
                      </MenuItem>
                    ))}
                  </Select>
                </FormControl>
                <Box>
                  <Typography variant="subtitle2">Detected credential hints</Typography>
                  {gatewayHintLoading && (
                    <Typography variant="body2">Detecting credentials...</Typography>
                  )}
                  {!gatewayHintLoading && gatewayHintError && (
                    <Typography variant="body2" color="error">
                      {gatewayHintError}
                    </Typography>
                  )}
                  {!gatewayHintLoading && !gatewayHintError && gatewayHintList.length === 0 && (
                    <Typography variant="body2" color="text.secondary">
                      No hints detected for this skill. You can add custom variables below.
                    </Typography>
                  )}
                  <Stack spacing={2} sx={{ mt: 1 }}>
                    {gatewayHintList.map((hint) => (
                      <TextField
                        key={hint}
                        fullWidth
                        type="password"
                        label={hint}
                        placeholder="Leave blank to keep unchanged"
                        value={gatewayEnvInputs[hint] || ''}
                        onChange={(event) => updateGatewayEnvInput(hint, event.target.value)}
                      />
                    ))}
                  </Stack>
                </Box>
                <Box>
                  <Typography variant="subtitle2">Existing keys</Typography>
                  <Stack spacing={1} sx={{ mt: 1 }}>
                    {(gatewayEntries[normalizeSkillKey(gatewaySkillKey)]?.envKeys || []).length === 0 && (
                      <Typography variant="body2" color="text.secondary">
                        No keys stored for this skill yet.
                      </Typography>
                    )}
                    {(gatewayEntries[normalizeSkillKey(gatewaySkillKey)]?.envKeys || []).map((key) => (
                      <Box key={key} sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
                        <Typography variant="body2">{key}</Typography>
                        <Chip size="small" label="set" />
                        <Button size="small" onClick={() => markGatewayClear(key)}>
                          Clear
                        </Button>
                      </Box>
                    ))}
                  </Stack>
                </Box>
                <Box>
                  <Typography variant="subtitle2">Add custom key</Typography>
                  <Box sx={{ display: 'flex', gap: 1, mt: 1 }}>
                    <TextField
                      fullWidth
                      label="Env key"
                      value={gatewayCustomKey}
                      onChange={(event) => setGatewayCustomKey(event.target.value)}
                    />
                    <TextField
                      fullWidth
                      type="password"
                      label="Value"
                      value={gatewayCustomValue}
                      onChange={(event) => setGatewayCustomValue(event.target.value)}
                    />
                    <Button variant="outlined" onClick={addGatewayCustomEnv}>
                      Add
                    </Button>
                  </Box>
                </Box>
                <Divider />
                <Box sx={{ display: 'flex', justifyContent: 'flex-end' }}>
                  <Button
                    variant="contained"
                    onClick={saveGatewayCredentials}
                    disabled={gatewaySaving || !gatewaySkillKey || !gatewayId}
                  >
                    {gatewaySaving ? 'Saving...' : 'Save Credentials'}
                  </Button>
                </Box>
              </Stack>
            )}
          </CardContent>
        </Card>
      )}

      <Dialog open={importOpen} onClose={closeImportDialog} maxWidth="sm" fullWidth>
        <DialogTitle>Import Skill</DialogTitle>
        <DialogContent sx={{ display: 'grid', gap: 2, mt: 1 }}>
          {selectedPodName && (
            <Typography variant="caption" color="text.secondary">
              Importing into {selectedPodName}
            </Typography>
          )}
          <FormControl fullWidth>
            <InputLabel id="import-pod-label">Pod</InputLabel>
            <Select
              labelId="import-pod-label"
              value={importState.podId}
              label="Pod"
              onChange={(event) => setImportState((prev) => ({ ...prev, podId: event.target.value }))}
            >
              {pods.map((pod) => (
                <MenuItem key={pod._id} value={pod._id}>
                  {pod.name}
                </MenuItem>
              ))}
            </Select>
          </FormControl>

          <FormControl fullWidth>
            <InputLabel id="scope-label">Scope</InputLabel>
            <Select
              labelId="scope-label"
              value={importState.scope}
              label="Scope"
              onChange={(event) => setImportState((prev) => ({ ...prev, scope: event.target.value }))}
            >
              <MenuItem value="pod">Pod</MenuItem>
              <MenuItem value="agent">Agent</MenuItem>
            </Select>
          </FormControl>

          {importState.scope === 'agent' && (
            <FormControl fullWidth>
              <InputLabel id="agent-label">Agent Instance</InputLabel>
              <Select
                labelId="agent-label"
                value={importState.agentKey}
                label="Agent Instance"
                onChange={(event) => setImportState((prev) => ({ ...prev, agentKey: event.target.value }))}
              >
                {podAgents.map((agent) => (
                  <MenuItem
                    key={`${agent.name}:${agent.instanceId}`}
                    value={`${agent.name}:${agent.instanceId}`}
                  >
                    {agent.displayName || agent.name} ({agent.instanceId})
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          )}

          <TextField
            label="Skill Name"
            value={importState.name}
            onChange={(event) => setImportState((prev) => ({ ...prev, name: event.target.value }))}
            fullWidth
          />
          <TextField
            label="Description"
            value={importState.description}
            onChange={(event) => setImportState((prev) => ({ ...prev, description: event.target.value }))}
            fullWidth
          />
          <TextField
            label="Tags (comma separated)"
            value={importState.tags}
            onChange={(event) => setImportState((prev) => ({ ...prev, tags: event.target.value }))}
            fullWidth
          />
          <TextField
            label="Source URL"
            value={importState.sourceUrl}
            onChange={(event) => setImportState((prev) => ({ ...prev, sourceUrl: event.target.value }))}
            fullWidth
          />
          <Box>
            <Typography variant="caption" color="text.secondary">
              Credential hints
            </Typography>
            {requirementsLoading && (
              <Typography variant="body2">Detecting required credentials...</Typography>
            )}
            {!requirementsLoading && requirementsError && (
              <Typography variant="body2" color="error">
                {requirementsError}
              </Typography>
            )}
            {!requirementsLoading && !requirementsError && requirementsList.length > 0 && (
              <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', mt: 1 }}>
                {requirementsList.map((item) => (
                  <Chip key={item} label={item} size="small" sx={{ mb: 1 }} />
                ))}
              </Stack>
            )}
            {!requirementsLoading && !requirementsError && requirementsList.length === 0 && (
              <Typography variant="body2">
                No credential hints detected. Check the source README for setup details.
              </Typography>
            )}
          </Box>
          <TextField
            label="License"
            value={importState.license}
            onChange={(event) => setImportState((prev) => ({ ...prev, license: event.target.value }))}
            fullWidth
            helperText={importState.license ? 'License info from the catalog (editable).' : 'No license info available.'}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={closeImportDialog}>Cancel</Button>
          <Button
            variant="contained"
            onClick={handleImport}
            disabled={
              !importState.podId
              || !importState.name
              || !importState.sourceUrl
            }
          >
            Import
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={licenseOpen} onClose={closeLicenseDialog} fullWidth maxWidth="sm">
        <DialogTitle>{licenseState.title}</DialogTitle>
        <DialogContent sx={{ pt: 2 }}>
          {licenseState.path && (
            <Typography variant="caption" color="text.secondary">
              {licenseState.path}
            </Typography>
          )}
          <TextField
            fullWidth
            multiline
            minRows={10}
            value={licenseState.text}
            InputProps={{ readOnly: true }}
            sx={{ mt: 2 }}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={closeLicenseDialog}>Close</Button>
        </DialogActions>
      </Dialog>

      <Dialog open={gatewayDialogOpen} onClose={closeGatewayDialog} fullWidth maxWidth="sm">
        <DialogTitle>Add Gateway</DialogTitle>
        <DialogContent sx={{ display: 'grid', gap: 2, mt: 1 }}>
          {gatewayCreateError && (
            <Typography color="error">{gatewayCreateError}</Typography>
          )}
          <TextField
            label="Name"
            value={gatewayForm.name}
            onChange={(event) => setGatewayForm((prev) => ({ ...prev, name: event.target.value }))}
            fullWidth
          />
          <TextField
            label="Slug (optional)"
            value={gatewayForm.slug}
            onChange={(event) => setGatewayForm((prev) => ({ ...prev, slug: event.target.value }))}
            fullWidth
          />
          <FormControl fullWidth>
            <InputLabel id="gateway-mode-label">Mode</InputLabel>
            <Select
              labelId="gateway-mode-label"
              label="Mode"
              value={gatewayForm.mode}
              onChange={(event) => setGatewayForm((prev) => ({ ...prev, mode: event.target.value }))}
            >
              <MenuItem value="local">Local (host-managed)</MenuItem>
              <MenuItem value="remote">Remote</MenuItem>
              <MenuItem value="k8s">Kubernetes</MenuItem>
            </Select>
          </FormControl>
          <TextField
            label="Base URL (optional)"
            value={gatewayForm.baseUrl}
            onChange={(event) => setGatewayForm((prev) => ({ ...prev, baseUrl: event.target.value }))}
            fullWidth
          />
          <TextField
            label="Config path (local gateway)"
            value={gatewayForm.configPath}
            onChange={(event) => setGatewayForm((prev) => ({ ...prev, configPath: event.target.value }))}
            fullWidth
          />
          <TextField
            label="K8s namespace"
            value={gatewayForm.namespace}
            onChange={(event) => setGatewayForm((prev) => ({ ...prev, namespace: event.target.value }))}
            fullWidth
          />
          <TextField
            label="Gateway image (placeholder)"
            value={gatewayForm.image}
            onChange={(event) => setGatewayForm((prev) => ({ ...prev, image: event.target.value }))}
            fullWidth
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={closeGatewayDialog}>Cancel</Button>
          <Button variant="contained" onClick={handleCreateGateway} disabled={gatewayCreateLoading}>
            {gatewayCreateLoading ? 'Creating...' : 'Create'}
          </Button>
        </DialogActions>
      </Dialog>
    </Container>
  );
};

export default SkillsCatalogPage;
