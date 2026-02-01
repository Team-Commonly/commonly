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
  TextField,
  Typography,
} from '@mui/material';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';

const getAuthHeaders = () => {
  const token = localStorage.getItem('token');
  return { headers: { Authorization: `Bearer ${token}` } };
};

const SkillsCatalogPage = () => {
  const [catalogItems, setCatalogItems] = useState([]);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedVendor, setSelectedVendor] = useState('all');
  const [groupByVendor, setGroupByVendor] = useState(true);

  const [pods, setPods] = useState([]);
  const [selectedPodId, setSelectedPodId] = useState('');
  const [podAgents, setPodAgents] = useState([]);

  const [importOpen, setImportOpen] = useState(false);
  const [licenseOpen, setLicenseOpen] = useState(false);
  const [licenseState, setLicenseState] = useState({ title: '', text: '', path: '' });
  const [importState, setImportState] = useState({
    podId: '',
    scope: 'pod',
    agentKey: '',
    name: '',
    content: '',
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

  const getVendor = (item) => {
    if (item?.tags?.length) return item.tags[0];
    if (item?.name?.includes('/')) return item.name.split('/')[0];
    return 'misc';
  };

  const vendors = useMemo(() => {
    const vendorSet = new Set();
    catalogItems.forEach((item) => vendorSet.add(getVendor(item)));
    return Array.from(vendorSet).sort();
  }, [catalogItems]);

  const filteredItems = useMemo(() => {
    const term = searchTerm.trim().toLowerCase();
    return catalogItems.filter((item) => {
      if (selectedVendor !== 'all' && getVendor(item) !== selectedVendor) return false;
      if (!term) return true;
      const haystack = `${item.name || ''} ${item.description || ''}`.toLowerCase();
      return haystack.includes(term);
    });
  }, [catalogItems, searchTerm, selectedVendor]);

  const groupedItems = useMemo(() => {
    if (!groupByVendor) {
      return [{ vendor: 'All Skills', items: filteredItems }];
    }
    const groups = new Map();
    filteredItems.forEach((item) => {
      const vendor = getVendor(item);
      if (!groups.has(vendor)) groups.set(vendor, []);
      groups.get(vendor).push(item);
    });
    return Array.from(groups.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([vendor, items]) => ({ vendor, items }));
  }, [filteredItems, groupByVendor]);

  const fetchCatalog = async () => {
    setCatalogLoading(true);
    setCatalogError('');
    try {
      const response = await axios.get('/api/skills/catalog?source=awesome', getAuthHeaders());
      setCatalogItems(response.data?.items || []);
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

  useEffect(() => {
    fetchCatalog();
    fetchPods();
  }, []);

  useEffect(() => {
    if (selectedPodId) {
      fetchPodAgents(selectedPodId);
    }
  }, [selectedPodId]);

  useEffect(() => {
    if (importState.podId) {
      fetchPodAgents(importState.podId);
    }
  }, [importState.podId]);

  useEffect(() => {
    if (importState.scope !== 'agent') {
      setImportState((prev) => ({ ...prev, agentKey: '' }));
    }
  }, [importState.scope]);

  const openImportDialog = (item) => {
    setImportState({
      podId: selectedPodId || '',
      scope: 'pod',
      agentKey: '',
      name: item?.name || '',
      content: item?.content || '',
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
  };

  const handleImport = async () => {
    const payload = {
      podId: importState.podId,
      name: importState.name,
      content: importState.content,
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
      closeImportDialog();
    } catch (error) {
      console.error('Failed to import skill:', error);
      alert(error.response?.data?.error || 'Failed to import skill');
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
          <InputLabel id="vendor-filter-label">Vendor</InputLabel>
          <Select
            labelId="vendor-filter-label"
            value={selectedVendor}
            label="Vendor"
            onChange={(event) => setSelectedVendor(event.target.value)}
          >
            <MenuItem value="all">All vendors</MenuItem>
            {vendors.map((vendor) => (
              <MenuItem key={vendor} value={vendor}>
                {vendor}
              </MenuItem>
            ))}
          </Select>
        </FormControl>

        <FormControlLabel
          control={
            <Switch
              checked={groupByVendor}
              onChange={(event) => setGroupByVendor(event.target.checked)}
            />
          }
          label="Group by vendor"
        />
      </Box>

      {catalogLoading && <Typography>Loading catalog...</Typography>}
      {catalogError && <Typography color="error">{catalogError}</Typography>}

      {!catalogLoading && catalogItems.length === 0 && (
        <Typography color="text.secondary">
          No catalog items yet. Populate the catalog index to list skills.
        </Typography>
      )}

      <Stack spacing={3}>
        {groupedItems.map((group) => (
          <Box key={group.vendor}>
            <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}>
              <Typography variant="h6" sx={{ textTransform: 'capitalize' }}>
                {group.vendor}
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
                      disabled={!selectedPodId}
                      onClick={() => openImportDialog(item)}
                    >
                      Import
                    </Button>
                  </CardActions>
                </Card>
              ))}
            </Box>
          </Box>
        ))}
      </Stack>

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
            label="Skill Content"
            value={importState.content}
            onChange={(event) => setImportState((prev) => ({ ...prev, content: event.target.value }))}
            fullWidth
            multiline
            minRows={6}
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
          <TextField
            label="License"
            value={importState.license}
            onChange={(event) => setImportState((prev) => ({ ...prev, license: event.target.value }))}
            fullWidth
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={closeImportDialog}>Cancel</Button>
          <Button
            variant="contained"
            onClick={handleImport}
            disabled={!importState.podId || !importState.name || !importState.content}
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
    </Container>
  );
};

export default SkillsCatalogPage;
