/**
 * AgentsHub Page
 *
 * The "app store" for AI agents - discover, install, and manage agents.
 */

import React, { useState, useEffect, useMemo, useRef } from 'react';
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
  Stack,
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
  ListItemText,
  Card,
  CardContent,
  CardActions,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  CircularProgress,
} from '@mui/material';
import {
  Search as SearchIcon,
  ContentCopy as CopyIcon,
  Refresh as RefreshIcon,
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
  { id: 'commonly-summarizer', label: 'Commonly Summarizer' },
  { id: 'openclaw', label: 'OpenClaw' },
  { id: 'codex', label: 'Codex' },
  { id: 'claude', label: 'Claude' },
  { id: 'gemini', label: 'Gemini' },
  { id: 'custom', label: 'Custom' },
];

const agentUserTokenScopes = [
  { id: 'agent:events:read', label: 'Read agent events' },
  { id: 'agent:events:ack', label: 'Acknowledge agent events' },
  { id: 'agent:context:read', label: 'Read pod context' },
  { id: 'agent:messages:read', label: 'Read pod messages' },
  { id: 'agent:messages:write', label: 'Post pod messages' },
];

const AgentsHub = ({ currentPodId: propPodId = null }) => {
  const theme = useTheme();
  const location = useLocation();
  const { currentUser } = useAuth();
  const isGlobalAdmin = currentUser?.role === 'admin';
  const [searchQuery, setSearchQuery] = useState('');
  const [activeTab, setActiveTab] = useState(0);
  const [category, setCategory] = useState('all');
  const [agents, setAgents] = useState([]);
  const [templates, setTemplates] = useState([]);
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
  const [configInstructions, setConfigInstructions] = useState('');
  const [configPersonaTone, setConfigPersonaTone] = useState('friendly');
  const [configPersonaSpecialties, setConfigPersonaSpecialties] = useState('');
  const [configPersonaBoundaries, setConfigPersonaBoundaries] = useState('');
  const [configPersonaCustomInstructions, setConfigPersonaCustomInstructions] = useState('');
  const [toolPolicyAllowed, setToolPolicyAllowed] = useState('commonly');
  const [toolPolicyBlocked, setToolPolicyBlocked] = useState('');
  const [toolPolicyRequireApproval, setToolPolicyRequireApproval] = useState('');
  const [configHeartbeatEnabled, setConfigHeartbeatEnabled] = useState(true);
  const [configHeartbeatInterval, setConfigHeartbeatInterval] = useState(60);
  const [configHeartbeatChecklist, setConfigHeartbeatChecklist] = useState('');
  const [heartbeatResetLoading, setHeartbeatResetLoading] = useState(false);
  const [configSaving, setConfigSaving] = useState(false);
  const [skillSyncMode, setSkillSyncMode] = useState('all');
  const [skillSyncAllPods, setSkillSyncAllPods] = useState(true);
  const [skillSyncPods, setSkillSyncPods] = useState([]);
  const [skillSyncSkills, setSkillSyncSkills] = useState([]);
  const [skillSyncPodsLoading, setSkillSyncPodsLoading] = useState(false);
  const [skillSyncSkillLoading, setSkillSyncSkillLoading] = useState(false);
  const [skillSyncPodOptions, setSkillSyncPodOptions] = useState([]);
  const [skillSyncSkillOptions, setSkillSyncSkillOptions] = useState([]);
  const [autoPersonaLoading, setAutoPersonaLoading] = useState(false);
  const [autoPersonaTarget, setAutoPersonaTarget] = useState('');
  const [runtimeTokens, setRuntimeTokens] = useState([]);
  const [runtimeTokenLabel, setRuntimeTokenLabel] = useState('Local dev');
  const [runtimeTokenValue, setRuntimeTokenValue] = useState('');
  const [runtimeTokenLoading, setRuntimeTokenLoading] = useState(false);
  const [runtimeTokenRevokingId, setRuntimeTokenRevokingId] = useState(null);
  const [provisionLoading, setProvisionLoading] = useState(false);
  const [provisionResult, setProvisionResult] = useState(null);
  const [provisionError, setProvisionError] = useState('');
  const [provisionIncludeUserToken, setProvisionIncludeUserToken] = useState(true);
  const [runtimeStatus, setRuntimeStatus] = useState(null);
  const [runtimeStatusLoading, setRuntimeStatusLoading] = useState(false);
  const [runtimeStatusError, setRuntimeStatusError] = useState('');
  const [runtimeLogsOpen, setRuntimeLogsOpen] = useState(false);
  const [runtimeLogsLoading, setRuntimeLogsLoading] = useState(false);
  const [runtimeLogsContent, setRuntimeLogsContent] = useState('');
  const [runtimeLogsError, setRuntimeLogsError] = useState('');
  const [runtimeLogsLines, setRuntimeLogsLines] = useState(200);
  const [runtimeLogsAutoRefresh, setRuntimeLogsAutoRefresh] = useState(true);
  const [runtimeLogsFilter, setRuntimeLogsFilter] = useState('');
  const runtimeLogsInputRef = useRef(null);
  const runtimeLogsScrollRef = useRef({ top: 0, atBottom: true });
  const [userTokenValue, setUserTokenValue] = useState('');
  const [userTokenScopes, setUserTokenScopes] = useState([]);
  const [userTokenMeta, setUserTokenMeta] = useState({ hasToken: false, createdAt: null });
  const [userTokenLoading, setUserTokenLoading] = useState(false);
  const [userTokenRevoking, setUserTokenRevoking] = useState(false);
  const [skillsCatalogOpen, setSkillsCatalogOpen] = useState(false);
  const [skillsCatalogItems, setSkillsCatalogItems] = useState([]);
  const [skillsCatalogLoading, setSkillsCatalogLoading] = useState(false);
  const [skillsCatalogError, setSkillsCatalogError] = useState('');
  const [skillsImportNotice, setSkillsImportNotice] = useState('');
  const [skillsImportState, setSkillsImportState] = useState({
    name: '',
    content: '',
    tags: '',
    sourceUrl: '',
    license: '',
    description: '',
  });
  const skillsSelectedRef = useRef(null);
  const [licenseOpen, setLicenseOpen] = useState(false);
  const [licenseState, setLicenseState] = useState({ title: '', text: '', path: '' });
  const [installDialogOpen, setInstallDialogOpen] = useState(false);
  const [installAgent, setInstallAgent] = useState(null);
  const [installPodIds, setInstallPodIds] = useState([]);
  const [installSaving, setInstallSaving] = useState(false);
  const [installInstanceName, setInstallInstanceName] = useState('');
  const [installInstanceId, setInstallInstanceId] = useState('');
  const [existingAgentInfo, setExistingAgentInfo] = useState(null);
  const [checkingExisting, setCheckingExisting] = useState(false);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [createAgentType, setCreateAgentType] = useState('');
  const [createAgentName, setCreateAgentName] = useState('');
  const [createAgentDescription, setCreateAgentDescription] = useState('');
  const [createAgentVisibility, setCreateAgentVisibility] = useState('private');
  const [createSaving, setCreateSaving] = useState(false);
  const [clawdbotGatewayStatus, setClawdbotGatewayStatus] = useState(null);
  const [adminInstallations, setAdminInstallations] = useState([]);
  const [adminTotal, setAdminTotal] = useState(0);
  const [adminLoading, setAdminLoading] = useState(false);
  const [adminError, setAdminError] = useState('');
  const [adminSearch, setAdminSearch] = useState('');
  const [adminShowAll, setAdminShowAll] = useState(false);
  const [adminTokensOpen, setAdminTokensOpen] = useState(false);
  const [adminTokensInstallation, setAdminTokensInstallation] = useState(null);
  const [adminRevokeLoadingId, setAdminRevokeLoadingId] = useState(null);
  const [adminUninstallTarget, setAdminUninstallTarget] = useState(null);
  const [adminUninstallLoading, setAdminUninstallLoading] = useState(false);

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

  const adminTabIndex = isGlobalAdmin ? 2 : -1;

  const formatDateTime = (value) => {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '—';
    return date.toLocaleString();
  };

  const renderAdminStatusChip = (status) => {
    const normalized = status || 'unknown';
    let color = 'default';
    if (normalized === 'active') color = 'success';
    if (normalized === 'paused') color = 'warning';
    if (normalized === 'error') color = 'error';
    if (normalized === 'uninstalled') color = 'default';
    return (
      <Chip
        size="small"
        label={normalized}
        color={color}
        variant={normalized === 'uninstalled' ? 'outlined' : 'filled'}
        sx={{ textTransform: 'capitalize' }}
      />
    );
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
    fetchTemplates();
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

      // Check for new agent type names (commonly-summarizer, openclaw)
      const hasSummarizer = fetchedAgents.some((agent) => agent.name === 'commonly-summarizer');
      const hasOpenclaw = fetchedAgents.some((agent) => agent.name === 'openclaw');
      const shouldSeedDefaults = !searchQuery && category === 'all' && (!hasSummarizer || !hasOpenclaw);

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

  const fetchTemplates = async () => {
    try {
      const response = await axios.get('/api/registry/templates', {
        headers: getAuthHeaders(),
      });
      setTemplates(response.data.templates || []);
    } catch (err) {
      console.error('Error fetching agent templates:', err);
      setTemplates([]);
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

  const fetchAdminInstallations = async () => {
    if (!isGlobalAdmin) return;
    setAdminLoading(true);
    setAdminError('');
    try {
      const params = new URLSearchParams();
      if (adminSearch.trim()) params.append('q', adminSearch.trim());
      params.append('status', adminShowAll ? 'all' : 'active');
      params.append('limit', '200');
      params.append('offset', '0');
      const response = await axios.get(`/api/registry/admin/installations?${params.toString()}`, {
        headers: getAuthHeaders(),
      });
      setAdminInstallations(response.data.installations || []);
      setAdminTotal(response.data.total || 0);
    } catch (err) {
      console.error('Error fetching admin installations:', err);
      setAdminError('Failed to load installations.');
    } finally {
      setAdminLoading(false);
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

  useEffect(() => {
    if (!isGlobalAdmin && activeTab > 1) {
      setActiveTab(0);
    }
  }, [isGlobalAdmin, activeTab]);

  useEffect(() => {
    if (!isGlobalAdmin) return;
    if (activeTab !== adminTabIndex) return;
    fetchAdminInstallations();
  }, [isGlobalAdmin, activeTab, adminTabIndex, adminShowAll]);

  useEffect(() => {
    if (!isGlobalAdmin) return;
    if (activeTab !== adminTabIndex) return;
    const handle = setTimeout(() => {
      fetchAdminInstallations();
    }, 350);
    return () => clearTimeout(handle);
  }, [isGlobalAdmin, activeTab, adminTabIndex, adminSearch]);

  const openInstallDialog = (agent) => {
    const defaultPodId = selectedPodId
      || accessiblePods[0]?._id
      || userPods[0]?._id
      || null;
    setInstallAgent(agent);
    setInstallInstanceName(agent?.displayName || agent?.name || '');
    setInstallInstanceId('');
    setInstallPodIds(defaultPodId ? [defaultPodId] : []);
    setInstallDialogOpen(true);
  };

  const openAdminTokensDialog = (installation) => {
    setAdminTokensInstallation(installation);
    setAdminTokensOpen(true);
  };

  const closeAdminTokensDialog = () => {
    setAdminTokensOpen(false);
    setAdminTokensInstallation(null);
  };

  const handleAdminRevokeToken = async (tokenId) => {
    if (!adminTokensInstallation?.id) return;
    setAdminRevokeLoadingId(tokenId);
    try {
      await axios.delete(
        `/api/registry/admin/installations/${adminTokensInstallation.id}/runtime-tokens/${tokenId}`,
        { headers: getAuthHeaders() },
      );
      setAdminInstallations((prev) => prev.map((item) => {
        if (item.id !== adminTokensInstallation.id) return item;
        return {
          ...item,
          runtimeTokens: (item.runtimeTokens || []).filter((token) => token.id !== tokenId),
        };
      }));
      setAdminTokensInstallation((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          runtimeTokens: (prev.runtimeTokens || []).filter((token) => token.id !== tokenId),
        };
      });
    } catch (err) {
      console.error('Error revoking admin runtime token:', err);
      setAdminError('Failed to revoke runtime token.');
    } finally {
      setAdminRevokeLoadingId(null);
    }
  };

  const openAdminUninstallDialog = (installation) => {
    setAdminUninstallTarget(installation);
  };

  const closeAdminUninstallDialog = () => {
    setAdminUninstallTarget(null);
  };

  const handleAdminUninstallConfirm = async () => {
    if (!adminUninstallTarget?.id) return;
    setAdminUninstallLoading(true);
    try {
      await axios.delete(`/api/registry/admin/installations/${adminUninstallTarget.id}`, {
        headers: getAuthHeaders(),
      });
      setAdminInstallations((prev) => {
        if (!adminShowAll) {
          return prev.filter((item) => item.id !== adminUninstallTarget.id);
        }
        return prev.map((item) => (
          item.id === adminUninstallTarget.id
            ? { ...item, status: 'uninstalled' }
            : item
        ));
      });
      closeAdminUninstallDialog();
    } catch (err) {
      console.error('Error uninstalling admin installation:', err);
      setAdminError('Failed to uninstall installation.');
    } finally {
      setAdminUninstallLoading(false);
    }
  };

  const closeInstallDialog = () => {
    setInstallDialogOpen(false);
    setInstallAgent(null);
    setInstallPodIds([]);
    setInstallInstanceName('');
    setInstallInstanceId('');
    setExistingAgentInfo(null);
    setCheckingExisting(false);
  };

  const openCreateDialog = () => {
    setCreateAgentType('');
    setCreateAgentName('');
    setCreateAgentDescription('');
    setCreateAgentVisibility('private');
    setCreateDialogOpen(true);
  };

  const closeCreateDialog = () => {
    setCreateDialogOpen(false);
    setCreateAgentType('');
    setCreateAgentName('');
    setCreateAgentDescription('');
    setCreateAgentVisibility('private');
  };

  /**
   * Derive instanceId from displayName for consistent agent identity across pods.
   * Matches backend logic in registry.js deriveInstanceId()
   */
  const deriveInstanceId = (displayName, agentName) => {
    if (!displayName) return 'default';
    const slug = String(displayName)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '');
    if (!slug || slug === agentName?.toLowerCase()) {
      return 'default';
    }
    return slug;
  };

  /**
   * Check if an agent with the derived instanceId already exists in other pods.
   * Called when displayName changes to detect shared agent identity.
   */
  const checkExistingAgentInstance = async (agentName, instanceId) => {
    if (!agentName || !instanceId) {
      setExistingAgentInfo(null);
      return;
    }
    setCheckingExisting(true);
    try {
      const response = await axios.get(
        `/api/registry/agents/${agentName}/instances/${encodeURIComponent(instanceId)}`,
        { headers: getAuthHeaders() },
      );
      if (response.data.exists) {
        setExistingAgentInfo(response.data);
      } else {
        setExistingAgentInfo(null);
      }
    } catch (err) {
      console.error('Error checking existing agent instance:', err);
      setExistingAgentInfo(null);
    } finally {
      setCheckingExisting(false);
    }
  };

  // Check for existing agent when displayName changes
  useEffect(() => {
    if (!installDialogOpen || !installAgent) return;
    const agentName = installAgent.agentName || installAgent.name;
    const derivedId = deriveInstanceId(installInstanceName, agentName);
    // Debounce the check
    const timeoutId = setTimeout(() => {
      checkExistingAgentInstance(agentName, derivedId);
    }, 300);
    return () => clearTimeout(timeoutId);
  }, [installDialogOpen, installAgent, installInstanceName]);

  const handleInstall = async () => {
    if (!installAgent) return;
    if (installPodIds.length === 0) {
      alert('Select at least one pod to install this agent.');
      return;
    }

    setInstallSaving(true);
    try {
      const agentName = installAgent.agentName || installAgent.name;
      const agentDetails = await axios.get(`/api/registry/agents/${agentName}`, {
        headers: getAuthHeaders(),
      });
      const requiredScopes = agentDetails.data?.manifest?.context?.required || [];
      const installScopes = requiredScopes.length > 0 ? requiredScopes : ['context:read'];
      let resolvedInstanceId = installInstanceId?.trim() || '';
      if (resolvedInstanceId) {
        resolvedInstanceId = resolvedInstanceId
          .toLowerCase()
          .replace(/[^a-z0-9-]/g, '-')
          .replace(/-+/g, '-')
          .replace(/^-+|-+$/g, '') || '';
        if (resolvedInstanceId === agentName.toLowerCase()) {
          resolvedInstanceId = 'default';
        }
      }

      const results = await Promise.allSettled(
        installPodIds.map((podId) => (
          axios.post('/api/registry/install', {
            agentName,
            podId,
            scopes: installScopes,
            instanceId: resolvedInstanceId || undefined,
            displayName: installInstanceName || agentDetails.data?.displayName || agentName,
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

  const handleCreateTemplate = async () => {
    if (!createAgentType || !createAgentName) {
      alert('Select an agent type and enter a name.');
      return;
    }
    setCreateSaving(true);
    try {
      await axios.post('/api/registry/templates', {
        agentName: createAgentType,
        displayName: createAgentName,
        description: createAgentDescription,
        visibility: createAgentVisibility,
      }, {
        headers: getAuthHeaders(),
      });
      await fetchTemplates();
      closeCreateDialog();
    } catch (err) {
      console.error('Error creating agent template:', err);
      alert(err.response?.data?.error || 'Failed to create agent');
    } finally {
      setCreateSaving(false);
    }
  };

  const handleRemove = async (agent) => {
    if (!selectedPodId) return;

    try {
      const resolved = resolveInstalledAgent(agent);
      if (!resolved.instanceId && isInstalled(agent?.name)) {
        alert('Multiple installations found. Open the Installed tab to remove the correct instance.');
        return;
      }
      const instanceId = resolved.instanceId || 'default';
      await axios.delete(
        `/api/registry/agents/${agent.name}/pods/${selectedPodId}?instanceId=${encodeURIComponent(instanceId)}`,
        {
        headers: getAuthHeaders(),
        },
      );
      fetchInstalledAgents();
    } catch (err) {
      console.error('Error removing agent:', err);
      alert(err.response?.data?.error || 'Failed to remove agent');
    }
  };

  const currentPodId = selectedPodId;

  const modelOptions = [
    { value: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash (default)' },
    { value: 'gemini-1.5-pro', label: 'Gemini 1.5 Pro' },
  ];

  const personaToneOptions = [
    'friendly',
    'professional',
    'casual',
    'formal',
    'technical',
  ];
  const toolPolicyHelper = 'Common: commonly (all), commonly_search, commonly_context, commonly_write.';

  const DEFAULT_HEARTBEAT_CHECKLIST = [
    '- Use the `commonly` skill to fetch pod context (`/api/pods/:id/context`), last 20 chat messages, and 10 most recent posts.',
    '- If there is something new, post a concise update to the pod chat and reply to relevant posts/threads.',
    '- Log short-term notes in memory/YYYY-MM-DD.md with message/post ids. Promote durable, agent-specific notes to MEMORY.md.',
    '- If nothing new, reply HEARTBEAT_OK.',
  ].join('\n');


  const formatCommaList = (items = []) => items.filter(Boolean).join(', ');
  const parseCommaList = (value = '') => value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  const clampNumber = (value, fallback, min = 1, max = 1440) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(Math.max(parsed, min), max);
  };
  const parseHeartbeatMinutes = (heartbeat) => {
    if (!heartbeat) return 60;
    if (Number.isFinite(heartbeat.everyMinutes)) return heartbeat.everyMinutes;
    const raw = String(heartbeat.every || '').trim().toLowerCase();
    if (!raw) return 60;
    const match = raw.match(/([0-9]+)\s*m/);
    if (match) return Number(match[1]);
    const value = Number(raw);
    return Number.isFinite(value) ? value : 60;
  };

  const isInstalled = (agentName) => {
    return installedAgents.some((a) => a.name === agentName);
  };

  const getInstallation = (agentName, instanceId = 'default') => {
    return installedAgents.find((a) => a.name === agentName && a.instanceId === instanceId) || null;
  };

  const resolveInstalledAgent = (agent) => {
    if (!agent || agent.instanceId) return agent;
    const matches = installedAgents.filter((installed) => installed.name === agent.name);
    if (matches.length === 1) {
      const match = matches[0];
      return {
        ...agent,
        instanceId: match.instanceId,
        installedBy: match.installedBy,
        profile: match.profile,
        config: match.config,
        displayName: agent.displayName || match.displayName || agent.name,
      };
    }
    return agent;
  };

  const selectedPod = (accessiblePods.length > 0 ? accessiblePods : userPods)
    .find((pod) => pod._id === selectedPodId) || null;
  const canRemoveInSelectedPod = selectedPod ? isPodAdmin(selectedPod) : false;
  const allAgents = [
    ...agents,
    ...templates.map((template) => ({
      name: template.agentName,
      agentName: template.agentName,
      displayName: template.displayName,
      description: template.description,
      verified: false,
      categories: [
        ...(agents.find((agent) => agent.name === template.agentName)?.categories || []),
        'custom',
      ],
      isTemplate: true,
      templateId: template.id,
      visibility: template.visibility,
      createdBy: template.createdBy,
    })),
  ];
  const filteredAgents = category === 'all'
    ? allAgents
    : allAgents.filter((agent) => (agent.categories || []).includes(category));

  const openConfigDialog = (agent) => {
    const resolved = resolveInstalledAgent(agent);
    if (!resolved.instanceId && isInstalled(agent?.name)) {
      alert('Multiple installations found. Open the Installed tab to configure the correct instance.');
      return;
    }
    setConfigAgent(resolved);
    setConfigModel(resolved?.profile?.modelPreferences?.preferred || 'gemini-2.0-flash');
    const persona = resolved?.profile?.persona || {};
    const toolPolicy = resolved?.profile?.toolPolicy || {};
    const heartbeatConfig = resolved?.config?.heartbeat || null;
    const heartbeatChecklist = resolved?.config?.heartbeatChecklist || '';
    const skillSyncConfig = resolved?.config?.skillSync || {};
    setConfigInstructions(resolved?.profile?.instructions || '');
    setConfigPersonaTone(persona.tone || 'friendly');
    setConfigPersonaSpecialties(formatCommaList(persona.specialties || []));
    setConfigPersonaBoundaries(formatCommaList(persona.boundaries || []));
    setConfigPersonaCustomInstructions(persona.customInstructions || '');
    setToolPolicyAllowed(formatCommaList(toolPolicy.allowed || ['commonly']));
    setToolPolicyBlocked(formatCommaList(toolPolicy.blocked || []));
    setToolPolicyRequireApproval(formatCommaList(toolPolicy.requireApproval || []));
    setConfigHeartbeatEnabled(heartbeatConfig?.enabled !== false);
    setConfigHeartbeatInterval(parseHeartbeatMinutes(heartbeatConfig));
    setConfigHeartbeatChecklist(
      heartbeatChecklist && heartbeatChecklist.trim()
        ? heartbeatChecklist
        : DEFAULT_HEARTBEAT_CHECKLIST,
    );
    setSkillSyncMode(skillSyncConfig.mode === 'selected' ? 'selected' : 'all');
    setSkillSyncAllPods(skillSyncConfig.allPods !== false);
    setSkillSyncPods(Array.isArray(skillSyncConfig.podIds) ? skillSyncConfig.podIds : []);
    setSkillSyncSkills(Array.isArray(skillSyncConfig.skillNames) ? skillSyncConfig.skillNames : []);
    setRuntimeTokenValue('');
    setRuntimeTokenLabel('Local dev');
    setUserTokenValue('');
    setUserTokenScopes([]);
    setUserTokenMeta({ hasToken: false, createdAt: null });
    setConfigOpen(true);
    // Fetch Clawdbot gateway status if opening clawdbot-bridge config
    if (agent?.name === 'clawdbot-bridge') {
      fetchClawdbotStatus();
    }
  };

  const handleAutoPersona = async () => {
    if (!selectedPodId || !configAgent) {
      alert('Select a pod and open an agent configuration first.');
      return;
    }
    const resolved = resolveInstalledAgent(configAgent);
    const instanceId = resolved.instanceId || 'default';
    const targetKey = `${resolved.name || resolved.agentName || resolved.name}:${instanceId}`;
    setAutoPersonaLoading(true);
    setAutoPersonaTarget(targetKey);

    try {
      const response = await axios.post(
        `/api/registry/pods/${selectedPodId}/agents/${resolved.name || resolved.agentName || resolved.name}/persona/generate`,
        { instanceId },
        { headers: getAuthHeaders() },
      );
      const persona = response.data?.persona || {};
      const exampleInstructions = response.data?.exampleInstructions || '';

      setConfigPersonaTone(persona.tone || 'friendly');
      setConfigPersonaSpecialties(formatCommaList(persona.specialties || []));
      setConfigPersonaBoundaries(formatCommaList(persona.boundaries || []));
      setConfigPersonaCustomInstructions(persona.customInstructions || '');
      setConfigInstructions((prev) => (prev && prev.trim() ? prev : exampleInstructions));
    } catch (error) {
      console.error('Failed to generate persona:', error);
      alert(error.response?.data?.error || 'Failed to generate persona.');
    } finally {
      setAutoPersonaLoading(false);
      setAutoPersonaTarget('');
    }
  };

  const fetchSkillSyncPods = async () => {
    if (!configAgent || (configAgent.name || configAgent.agentName) !== 'openclaw') return;
    setSkillSyncPodsLoading(true);
    try {
      const instanceId = configAgent.instanceId || 'default';
      const response = await axios.get(
        `/api/registry/agents/${configAgent.name}/installations?instanceId=${encodeURIComponent(instanceId)}`,
        { headers: getAuthHeaders() },
      );
      const pods = response.data?.installations || [];
      setSkillSyncPodOptions(pods);
    } catch (error) {
      console.error('Failed to load skill sync pods:', error);
      setSkillSyncPodOptions([]);
    } finally {
      setSkillSyncPodsLoading(false);
    }
  };

  const fetchSkillSyncSkills = async (podIds) => {
    const targets = Array.isArray(podIds) ? podIds.filter(Boolean) : [];
    if (!targets.length) {
      setSkillSyncSkillOptions([]);
      return;
    }
    setSkillSyncSkillLoading(true);
    try {
      const responses = await Promise.all(
        targets.map((podId) => axios.get(`/api/skills/pods/${podId}/imported`, {
          headers: getAuthHeaders(),
          params: { scope: 'pod' },
        })),
      );
      const items = responses.flatMap((res) => res.data?.items || []);
      const unique = new Map();
      items.forEach((item) => {
        if (!item?.name) return;
        const key = item.name.toLowerCase();
        if (!unique.has(key)) {
          unique.set(key, item);
        }
      });
      setSkillSyncSkillOptions(Array.from(unique.values()));
    } catch (error) {
      console.error('Failed to load skill sync skills:', error);
      setSkillSyncSkillOptions([]);
    } finally {
      setSkillSyncSkillLoading(false);
    }
  };

  const openSkillsCatalog = async () => {
    setSkillsCatalogOpen(true);
    setSkillsCatalogLoading(true);
    setSkillsCatalogError('');
    setSkillsImportNotice('');
    try {
      const response = await axios.get('/api/skills/catalog?source=awesome', {
        headers: getAuthHeaders(),
      });
      setSkillsCatalogItems(response.data?.items || []);
    } catch (error) {
      console.error('Failed to load skills catalog:', error);
      setSkillsCatalogError(error.response?.data?.error || 'Failed to load catalog');
      setSkillsCatalogItems([]);
    } finally {
      setSkillsCatalogLoading(false);
    }
  };

  const closeSkillsCatalog = () => {
    setSkillsCatalogOpen(false);
  };

  const beginSkillImport = (item) => {
    setSkillsImportNotice('');
    setSkillsImportState({
      name: item?.name || '',
      content: item?.content || '',
      tags: (item?.tags || []).join(', '),
      sourceUrl: item?.sourceUrl || '',
      license: item?.license?.name || item?.license || '',
      description: item?.description || '',
    });
    if (!item?.content) {
      setSkillsImportNotice(
        'This catalog entry does not include full skill content yet. Paste content manually or open the source link.',
      );
    }
    requestAnimationFrame(() => {
      skillsSelectedRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
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

  const handleImportSkill = async () => {
    if (!selectedPodId || !configAgent?.name) return;
    const payload = {
      podId: selectedPodId,
      name: skillsImportState.name,
      content: skillsImportState.content,
      tags: skillsImportState.tags
        ? skillsImportState.tags.split(',').map((t) => t.trim()).filter(Boolean)
        : [],
      sourceUrl: skillsImportState.sourceUrl,
      license: skillsImportState.license,
      scope: 'agent',
      agentName: configAgent?.name,
      instanceId: configAgent?.instanceId || 'default',
      description: skillsImportState.description,
    };

    try {
      await axios.post('/api/skills/import', payload, {
        headers: getAuthHeaders(),
      });
      setSkillsCatalogOpen(false);
    } catch (error) {
      console.error('Failed to import skill:', error);
      alert(error.response?.data?.error || 'Failed to import skill');
    }
  };

  const closeConfigDialog = () => {
    setConfigOpen(false);
    setConfigAgent(null);
    setRuntimeTokens([]);
    setRuntimeTokenValue('');
    setUserTokenValue('');
    setUserTokenScopes([]);
    setUserTokenMeta({ hasToken: false, createdAt: null });
    setProvisionLoading(false);
    setProvisionResult(null);
    setProvisionError('');
    setRuntimeStatus(null);
    setRuntimeStatusLoading(false);
    setRuntimeStatusError('');
    setRuntimeLogsOpen(false);
    setRuntimeLogsLoading(false);
    setRuntimeLogsContent('');
    setRuntimeLogsError('');
    setRuntimeLogsAutoRefresh(true);
    setRuntimeLogsFilter('');
    setConfigInstructions('');
    setConfigPersonaTone('friendly');
    setConfigPersonaSpecialties('');
    setConfigPersonaBoundaries('');
    setConfigPersonaCustomInstructions('');
    setToolPolicyAllowed('commonly');
    setToolPolicyBlocked('');
    setToolPolicyRequireApproval('');
  };

  useEffect(() => {
    const fetchRuntimeTokens = async () => {
      if (!configOpen || !configAgent || !selectedPodId) return;
      setRuntimeTokenLoading(true);
      try {
        const instanceId = configAgent.instanceId || 'default';
        const response = await axios.get(
          `/api/registry/pods/${selectedPodId}/agents/${configAgent.name}/runtime-tokens?instanceId=${encodeURIComponent(instanceId)}`,
          { headers: getAuthHeaders() },
        );
        setRuntimeTokens(response.data.tokens || []);
      } catch (err) {
        console.error('Error fetching runtime tokens:', err);
        alert(err.response?.data?.error || 'Failed to load runtime tokens');
        setRuntimeTokens([]);
      } finally {
        setRuntimeTokenLoading(false);
      }
    };
    fetchRuntimeTokens();
  }, [configOpen, configAgent, selectedPodId]);

  useEffect(() => {
    if (!configOpen || !configAgent || !selectedPodId) return;
    fetchRuntimeStatus();
  }, [configOpen, configAgent, selectedPodId]);

  useEffect(() => {
    if (!configOpen || !configAgent) return;
    const nextFilter = configAgent.instanceId || 'default';
    setRuntimeLogsFilter(nextFilter);
  }, [configOpen, configAgent]);

  useEffect(() => {
    if (!configOpen || !configAgent) return;
    if ((configAgent.name || configAgent.agentName) !== 'openclaw') return;
    fetchSkillSyncPods();
  }, [configOpen, configAgent]);

  useEffect(() => {
    if (!configOpen || !configAgent) return;
    if ((configAgent.name || configAgent.agentName) !== 'openclaw') return;
    const availablePods = skillSyncPodOptions.map((pod) => pod.podId);
    const targetPods = skillSyncAllPods ? availablePods : skillSyncPods;
    fetchSkillSyncSkills(targetPods);
  }, [configOpen, configAgent, skillSyncAllPods, skillSyncPods, skillSyncPodOptions]);


  useEffect(() => {
    if (!runtimeLogsOpen || !runtimeLogsAutoRefresh) return () => {};
    const interval = setInterval(() => {
      fetchRuntimeLogs();
    }, 4000);
    return () => clearInterval(interval);
  }, [runtimeLogsOpen, runtimeLogsAutoRefresh, runtimeLogsLines, configAgent, selectedPodId]);

  useEffect(() => {
    const fetchUserTokenMeta = async () => {
      if (!configOpen || !configAgent || !selectedPodId) return;
      setUserTokenLoading(true);
      try {
        const instanceId = configAgent.instanceId || 'default';
        const response = await axios.get(
          `/api/registry/pods/${selectedPodId}/agents/${configAgent.name}/user-token?instanceId=${encodeURIComponent(instanceId)}`,
          { headers: getAuthHeaders() },
        );
        setUserTokenMeta({
          hasToken: !!response.data?.hasToken,
          createdAt: response.data?.createdAt || null,
        });
        setUserTokenScopes(response.data?.scopes || []);
      } catch (err) {
        console.error('Error fetching user token metadata:', err);
        alert(err.response?.data?.error || 'Failed to load user token');
        setUserTokenMeta({ hasToken: false, createdAt: null });
        setUserTokenScopes([]);
      } finally {
        setUserTokenLoading(false);
      }
    };
    fetchUserTokenMeta();
  }, [configOpen, configAgent, selectedPodId]);

  const handleGenerateRuntimeToken = async () => {
    if (!configAgent || !selectedPodId) return;
    setRuntimeTokenLoading(true);
    try {
      const instanceId = configAgent.instanceId || 'default';
      const response = await axios.post(
        `/api/registry/pods/${selectedPodId}/agents/${configAgent.name}/runtime-tokens`,
        { label: runtimeTokenLabel, instanceId },
        { headers: getAuthHeaders() },
      );
      setRuntimeTokenValue(response.data.token || '');
      const refresh = await axios.get(
        `/api/registry/pods/${selectedPodId}/agents/${configAgent.name}/runtime-tokens?instanceId=${encodeURIComponent(instanceId)}`,
        { headers: getAuthHeaders() },
      );
      setRuntimeTokens(refresh.data.tokens || []);
    } catch (err) {
      console.error('Error issuing runtime token:', err);
      alert(err.response?.data?.error || 'Failed to issue runtime token');
    } finally {
      setRuntimeTokenLoading(false);
    }
  };

  const handleProvisionRuntime = async () => {
    if (!selectedPodId || !configAgent) return;
    setProvisionLoading(true);
    setProvisionError('');
    setProvisionResult(null);
    try {
      const resolved = resolveInstalledAgent(configAgent);
      const instanceId = resolved.instanceId || 'default';
      const response = await axios.post(
        `/api/registry/pods/${selectedPodId}/agents/${configAgent.name}/provision`,
        {
          instanceId,
          includeUserToken: provisionIncludeUserToken,
          label: 'Provisioned runtime',
        },
        { headers: getAuthHeaders() },
      );
      setProvisionResult(response.data);
      if (response.data.runtimeToken) {
        setRuntimeTokenValue(response.data.runtimeToken);
      }
      if (response.data.userToken) {
        setUserTokenValue(response.data.userToken);
      }
      const refresh = await axios.get(
        `/api/registry/pods/${selectedPodId}/agents/${configAgent.name}/runtime-tokens?instanceId=${encodeURIComponent(instanceId)}`,
        { headers: getAuthHeaders() },
      );
      setRuntimeTokens(refresh.data.tokens || []);
      fetchInstalledAgents();
    } catch (err) {
      console.error('Error provisioning runtime:', err);
      setProvisionError(err.response?.data?.error || 'Failed to provision runtime');
    } finally {
      setProvisionLoading(false);
    }
  };

  const fetchRuntimeStatus = async () => {
    if (!selectedPodId || !configAgent) return;
    setRuntimeStatusLoading(true);
    setRuntimeStatusError('');
    try {
      const response = await axios.get(
        `/api/registry/pods/${selectedPodId}/agents/${configAgent.name}/runtime-status`,
        { headers: getAuthHeaders() },
      );
      setRuntimeStatus(response.data || null);
    } catch (err) {
      console.error('Error fetching runtime status:', err);
      setRuntimeStatusError(err.response?.data?.error || 'Failed to fetch runtime status');
      setRuntimeStatus(null);
    } finally {
      setRuntimeStatusLoading(false);
    }
  };

  const handleStartRuntime = async () => {
    if (!selectedPodId || !configAgent) return;
    setRuntimeStatusLoading(true);
    try {
      await axios.post(
        `/api/registry/pods/${selectedPodId}/agents/${configAgent.name}/runtime-start`,
        {},
        { headers: getAuthHeaders() },
      );
      await fetchRuntimeStatus();
    } catch (err) {
      console.error('Error starting runtime:', err);
      setRuntimeStatusError(err.response?.data?.error || 'Failed to start runtime');
    } finally {
      setRuntimeStatusLoading(false);
    }
  };

  const handleStopRuntime = async () => {
    if (!selectedPodId || !configAgent) return;
    setRuntimeStatusLoading(true);
    try {
      await axios.post(
        `/api/registry/pods/${selectedPodId}/agents/${configAgent.name}/runtime-stop`,
        {},
        { headers: getAuthHeaders() },
      );
      await fetchRuntimeStatus();
    } catch (err) {
      console.error('Error stopping runtime:', err);
      setRuntimeStatusError(err.response?.data?.error || 'Failed to stop runtime');
    } finally {
      setRuntimeStatusLoading(false);
    }
  };

  const handleRestartRuntime = async () => {
    if (!selectedPodId || !configAgent) return;
    setRuntimeStatusLoading(true);
    try {
      await axios.post(
        `/api/registry/pods/${selectedPodId}/agents/${configAgent.name}/runtime-restart`,
        {},
        { headers: getAuthHeaders() },
      );
      await fetchRuntimeStatus();
    } catch (err) {
      console.error('Error restarting runtime:', err);
      setRuntimeStatusError(err.response?.data?.error || 'Failed to restart runtime');
    } finally {
      setRuntimeStatusLoading(false);
    }
  };

  const fetchRuntimeLogs = async () => {
    if (!selectedPodId || !configAgent) return;
    setRuntimeLogsLoading(true);
    setRuntimeLogsError('');
    try {
      const inputEl = runtimeLogsInputRef.current;
      if (inputEl) {
        const { scrollTop, scrollHeight, clientHeight } = inputEl;
        runtimeLogsScrollRef.current = {
          top: scrollTop,
          atBottom: scrollTop + clientHeight >= scrollHeight - 8,
        };
      }
      const response = await axios.get(
        `/api/registry/pods/${selectedPodId}/agents/${configAgent.name}/runtime-logs?lines=${runtimeLogsLines}`,
        { headers: getAuthHeaders() },
      );
      setRuntimeLogsContent(response.data?.logs || '');
    } catch (err) {
      console.error('Error fetching runtime logs:', err);
      setRuntimeLogsError(err.response?.data?.error || 'Failed to fetch runtime logs');
      setRuntimeLogsContent('');
    } finally {
      setRuntimeLogsLoading(false);
    }
  };

  useEffect(() => {
    if (!runtimeLogsOpen) return;
    const inputEl = runtimeLogsInputRef.current;
    if (!inputEl) return;
    const { top, atBottom } = runtimeLogsScrollRef.current || {};
    requestAnimationFrame(() => {
      if (!inputEl) return;
      if (atBottom) {
        inputEl.scrollTop = inputEl.scrollHeight;
        return;
      }
      if (typeof top === 'number') {
        inputEl.scrollTop = top;
      }
    });
  }, [runtimeLogsContent, runtimeLogsFilter, runtimeLogsOpen]);


  const handleRevokeRuntimeToken = async (tokenId) => {
    if (!configAgent || !selectedPodId || !tokenId) return;
    setRuntimeTokenRevokingId(tokenId);
    try {
      const instanceId = configAgent.instanceId || 'default';
      await axios.delete(
        `/api/registry/pods/${selectedPodId}/agents/${configAgent.name}/runtime-tokens/${tokenId}?instanceId=${encodeURIComponent(instanceId)}`,
        { headers: getAuthHeaders() },
      );
      const refresh = await axios.get(
        `/api/registry/pods/${selectedPodId}/agents/${configAgent.name}/runtime-tokens?instanceId=${encodeURIComponent(instanceId)}`,
        { headers: getAuthHeaders() },
      );
      setRuntimeTokens(refresh.data.tokens || []);
    } catch (err) {
      console.error('Error revoking runtime token:', err);
      alert(err.response?.data?.error || 'Failed to revoke runtime token');
    } finally {
      setRuntimeTokenRevokingId(null);
    }
  };

  const handleToggleUserScope = (scopeId) => {
    setUserTokenScopes((prev) => (
      prev.includes(scopeId) ? prev.filter((scope) => scope !== scopeId) : [...prev, scopeId]
    ));
  };

  const handleGenerateUserToken = async () => {
    if (!configAgent || !selectedPodId) return;
    setUserTokenLoading(true);
    try {
      const instanceId = configAgent.instanceId || 'default';
      const response = await axios.post(
        `/api/registry/pods/${selectedPodId}/agents/${configAgent.name}/user-token`,
        {
          scopes: userTokenScopes,
          instanceId,
          displayName: configAgent.displayName || configAgent.profile?.displayName,
        },
        { headers: getAuthHeaders() },
      );
      setUserTokenValue(response.data?.token || '');
      setUserTokenMeta({
        hasToken: true,
        createdAt: response.data?.createdAt || null,
      });
    } catch (err) {
      console.error('Error issuing agent user token:', err);
      alert(err.response?.data?.error || 'Failed to issue user token');
    } finally {
      setUserTokenLoading(false);
    }
  };

  const handleRevokeUserToken = async () => {
    if (!configAgent || !selectedPodId) return;
    setUserTokenRevoking(true);
    try {
      const instanceId = configAgent.instanceId || 'default';
      await axios.delete(
        `/api/registry/pods/${selectedPodId}/agents/${configAgent.name}/user-token?instanceId=${encodeURIComponent(instanceId)}`,
        { headers: getAuthHeaders() },
      );
      setUserTokenValue('');
      setUserTokenMeta({ hasToken: false, createdAt: null });
      setUserTokenScopes([]);
    } catch (err) {
      console.error('Error revoking agent user token:', err);
      alert(err.response?.data?.error || 'Failed to revoke user token');
    } finally {
      setUserTokenRevoking(false);
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
      const instanceId = configAgent.instanceId || 'default';
      const isOpenClaw = (configAgent.name || configAgent.agentName) === 'openclaw';
      await axios.patch(`/api/registry/pods/${selectedPodId}/agents/${configAgent.name}`, {
        config: {
          heartbeat: {
            enabled: configHeartbeatEnabled,
            everyMinutes: clampNumber(configHeartbeatInterval, 10),
          },
          heartbeatChecklist: configHeartbeatChecklist || '',
          ...(isOpenClaw
            ? {
              skillSync: {
                mode: skillSyncMode,
                allPods: skillSyncAllPods,
                podIds: skillSyncPods,
                skillNames: skillSyncSkills,
              },
            }
            : {}),
        },
        modelPreferences: { preferred: configModel },
        instanceId,
        instructions: configInstructions,
        persona: {
          tone: configPersonaTone,
          specialties: parseCommaList(configPersonaSpecialties),
          boundaries: parseCommaList(configPersonaBoundaries),
          customInstructions: configPersonaCustomInstructions,
        },
        toolPolicy: {
          allowed: parseCommaList(toolPolicyAllowed),
          blocked: parseCommaList(toolPolicyBlocked),
          requireApproval: parseCommaList(toolPolicyRequireApproval),
        },
      }, {
        headers: getAuthHeaders(),
      });

      if (isOpenClaw) {
        await axios.post(
          `/api/registry/pods/${selectedPodId}/agents/${configAgent.name || configAgent.agentName}/heartbeat-file`,
          {
            instanceId,
            content: configHeartbeatChecklist || '',
          },
          { headers: getAuthHeaders() },
        );
      }
      await fetchInstalledAgents();
      closeConfigDialog();
    } catch (err) {
      console.error('Error updating agent model preferences:', err);
      alert(err.response?.data?.error || 'Failed to update agent configuration');
    } finally {
      setConfigSaving(false);
    }
  };

  const handleResetHeartbeatChecklist = async () => {
    if (!configAgent || !selectedPodId) return;
    const isOpenClaw = (configAgent.name || configAgent.agentName) === 'openclaw';
    if (!isOpenClaw) return;
    const instanceId = configAgent.instanceId || 'default';
    setHeartbeatResetLoading(true);
    try {
      setConfigHeartbeatChecklist(DEFAULT_HEARTBEAT_CHECKLIST);
      await axios.post(
        `/api/registry/pods/${selectedPodId}/agents/${configAgent.name || configAgent.agentName}/heartbeat-file`,
        {
          instanceId,
          content: DEFAULT_HEARTBEAT_CHECKLIST,
          reset: true,
        },
        { headers: getAuthHeaders() },
      );
    } catch (error) {
      console.error('Failed to reset heartbeat checklist:', error);
      alert(error.response?.data?.error || 'Failed to reset heartbeat checklist.');
    } finally {
      setHeartbeatResetLoading(false);
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
          <Button variant="outlined" size="small" onClick={openCreateDialog}>
            New Agent
          </Button>
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
          {isGlobalAdmin && (
            <Tab label={`Admin ${adminTotal > 0 ? `(${adminTotal})` : ''}`} />
          )}
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
                : filteredAgents.map((agent) => (
                    <Grid item xs={12} sm={6} md={4} lg={4} key={agent.templateId || agent.name}>
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
                <Grid item xs={12} sm={6} md={4} lg={4} key={`${agent.name}-${agent.instanceId || 'default'}`}>
                  <AgentCard
                    agent={{
                      name: agent.name,
                      displayName: agent.profile?.displayName || agent.displayName || agent.name,
                      description: agent.profile?.purpose || '',
                      version: agent.version,
                      stats: agent.usage,
                      profile: agent.profile,
                      instanceId: agent.instanceId,
                      agentName: agent.name,
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

      {isGlobalAdmin && activeTab === adminTabIndex && (
        <Box>
          <Paper
            variant="outlined"
            sx={{
              p: 2,
              mb: 3,
              display: 'flex',
              flexDirection: 'column',
              gap: 2,
            }}
          >
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} alignItems={{ sm: 'center' }}>
              <TextField
                size="small"
                placeholder="Search agent, instance, or pod..."
                value={adminSearch}
                onChange={(e) => setAdminSearch(e.target.value)}
                InputProps={{
                  startAdornment: (
                    <InputAdornment position="start">
                      <SearchIcon fontSize="small" />
                    </InputAdornment>
                  ),
                }}
                sx={{ minWidth: { xs: '100%', sm: 320 } }}
              />
              <FormControlLabel
                control={(
                  <Checkbox
                    checked={adminShowAll}
                    onChange={(e) => setAdminShowAll(e.target.checked)}
                  />
                )}
                label="Include uninstalled"
              />
              <Box sx={{ flexGrow: 1 }} />
              <Button
                variant="outlined"
                startIcon={<RefreshIcon />}
                onClick={fetchAdminInstallations}
                disabled={adminLoading}
              >
                Refresh
              </Button>
            </Stack>
            <Typography variant="caption" color="text.secondary">
              {adminTotal} total installations
            </Typography>
          </Paper>

          {adminError && (
            <Alert severity="warning" sx={{ mb: 3 }}>
              {adminError}
            </Alert>
          )}

          <TableContainer component={Paper} variant="outlined">
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Agent</TableCell>
                  <TableCell>Instance</TableCell>
                  <TableCell>Pod</TableCell>
                  <TableCell>Status</TableCell>
                  <TableCell>Tokens</TableCell>
                  <TableCell>Last Used</TableCell>
                  <TableCell>Installed By</TableCell>
                  <TableCell align="right">Actions</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {adminLoading && (
                  <TableRow>
                    <TableCell colSpan={8} align="center" sx={{ py: 4 }}>
                      <CircularProgress size={24} />
                    </TableCell>
                  </TableRow>
                )}
                {!adminLoading && adminInstallations.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={8} align="center" sx={{ py: 4 }}>
                      <Typography color="text.secondary">No installations found.</Typography>
                    </TableCell>
                  </TableRow>
                )}
                {!adminLoading && adminInstallations.map((install) => (
                  <TableRow key={install.id}>
                    <TableCell>
                      <Typography variant="subtitle2">
                        {install.displayName || install.agentName}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        {install.agentName}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Typography variant="body2">
                        {install.instanceId || 'default'}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Typography variant="body2">
                        {install.pod?.name || 'Unknown pod'}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        {install.pod?.id || '—'}
                      </Typography>
                    </TableCell>
                    <TableCell>{renderAdminStatusChip(install.status)}</TableCell>
                    <TableCell>
                      <Stack direction="row" spacing={1} alignItems="center">
                        <Typography variant="body2">
                          {(install.runtimeTokens || []).length}
                        </Typography>
                        <Button
                          size="small"
                          variant="text"
                          onClick={() => openAdminTokensDialog(install)}
                        >
                          Manage
                        </Button>
                      </Stack>
                    </TableCell>
                    <TableCell>
                      <Typography variant="body2">
                        {formatDateTime(install.usage?.lastUsedAt)}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Typography variant="body2">
                        {install.installedBy?.username || 'Unknown'}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        {install.installedBy?.email || '—'}
                      </Typography>
                    </TableCell>
                    <TableCell align="right">
                      <Button
                        size="small"
                        color="error"
                        variant="outlined"
                        onClick={() => openAdminUninstallDialog(install)}
                        disabled={install.status === 'uninstalled'}
                      >
                        Uninstall
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        </Box>
      )}

      <Dialog open={configOpen} onClose={closeConfigDialog} fullWidth maxWidth={configAgent?.name === 'clawdbot-bridge' ? 'sm' : 'xs'}>
        <DialogTitle>
          Agent Settings
          {configAgent?.displayName ? ` • ${configAgent.displayName}` : ''}
        </DialogTitle>
        <DialogContent sx={{ pt: 2 }}>
          {configAgent?.instanceId && (
            <Alert severity="info" sx={{ mb: 2 }}>
              Instance ID: {configAgent.instanceId}
            </Alert>
          )}
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
            Persona & Instructions
          </Typography>
          <Box sx={{ display: 'flex', justifyContent: 'flex-end', mb: 2 }}>
            <Button
              variant="outlined"
              size="small"
              onClick={handleAutoPersona}
              disabled={autoPersonaLoading || !selectedPodId || !configAgent}
            >
              {autoPersonaLoading ? 'Generating...' : 'Auto-generate Persona'}
            </Button>
          </Box>
          <TextField
            fullWidth
            label="System instructions"
            value={configInstructions}
            onChange={(e) => setConfigInstructions(e.target.value)}
            multiline
            minRows={3}
            sx={{ mb: 2 }}
          />
          <FormControl fullWidth sx={{ mb: 2 }}>
            <InputLabel id="agent-persona-tone-label">Tone</InputLabel>
            <Select
              labelId="agent-persona-tone-label"
              label="Tone"
              value={configPersonaTone}
              onChange={(e) => setConfigPersonaTone(e.target.value)}
            >
              {personaToneOptions.map((tone) => (
                <MenuItem key={tone} value={tone}>
                  {tone.charAt(0).toUpperCase() + tone.slice(1)}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
          <TextField
            fullWidth
            label="Specialties (comma-separated)"
            value={configPersonaSpecialties}
            onChange={(e) => setConfigPersonaSpecialties(e.target.value)}
            sx={{ mb: 2 }}
          />
          <TextField
            fullWidth
            label="Boundaries (comma-separated)"
            value={configPersonaBoundaries}
            onChange={(e) => setConfigPersonaBoundaries(e.target.value)}
            sx={{ mb: 2 }}
          />
          <TextField
            fullWidth
            label="Custom persona instructions"
            value={configPersonaCustomInstructions}
            onChange={(e) => setConfigPersonaCustomInstructions(e.target.value)}
            multiline
            minRows={2}
            sx={{ mb: 2 }}
          />

          <Divider sx={{ my: 3 }} />

          <Typography variant="subtitle2" sx={{ mb: 1 }}>
            Tool Access Policy
          </Typography>
          <TextField
            fullWidth
            label="Allowed tools/categories (comma-separated)"
            value={toolPolicyAllowed}
            onChange={(e) => setToolPolicyAllowed(e.target.value)}
            helperText={toolPolicyHelper}
            sx={{ mb: 2 }}
          />
          <TextField
            fullWidth
            label="Blocked tools (comma-separated)"
            value={toolPolicyBlocked}
            onChange={(e) => setToolPolicyBlocked(e.target.value)}
            helperText="Blocklist always wins, even if allowed."
            sx={{ mb: 2 }}
          />
          <TextField
            fullWidth
            label="Require approval (comma-separated)"
            value={toolPolicyRequireApproval}
            onChange={(e) => setToolPolicyRequireApproval(e.target.value)}
            helperText="Tools that should request human approval."
            sx={{ mb: 2 }}
          />

          <Divider sx={{ my: 3 }} />

          <Typography variant="subtitle2" sx={{ mb: 1 }}>
            Heartbeat
          </Typography>
          {(configAgent?.name === 'openclaw' || configAgent?.agentName === 'openclaw') && (
            <TextField
              fullWidth
              label="Heartbeat checklist (HEARTBEAT.md)"
              value={configHeartbeatChecklist}
              onChange={(e) => setConfigHeartbeatChecklist(e.target.value)}
              multiline
              minRows={4}
              sx={{ mb: 2 }}
              helperText="Stored in the agent workspace HEARTBEAT.md. Keep this short."
            />
          )}
          {(configAgent?.name === 'openclaw' || configAgent?.agentName === 'openclaw') && (
            <Box sx={{ display: 'flex', justifyContent: 'flex-end', mb: 2 }}>
              <Button
                size="small"
                variant="text"
                onClick={handleResetHeartbeatChecklist}
                disabled={heartbeatResetLoading}
              >
                {heartbeatResetLoading ? 'Resetting...' : 'Reset to Default Checklist'}
              </Button>
            </Box>
          )}
          <FormControlLabel
            control={(
              <Checkbox
                checked={configHeartbeatEnabled}
                onChange={(e) => setConfigHeartbeatEnabled(e.target.checked)}
              />
            )}
            label="Enable heartbeat (auto-check pod messages)"
            sx={{ mb: 1 }}
          />
          <TextField
            fullWidth
            type="number"
            label="Heartbeat interval (minutes)"
            value={configHeartbeatInterval}
            onChange={(e) => setConfigHeartbeatInterval(Number(e.target.value))}
            inputProps={{ min: 1 }}
            sx={{ mb: 2 }}
          />
          <Box sx={{ mt: 2 }}>
            <Button variant="outlined" onClick={openSkillsCatalog}>
              Import Skill from Catalog
            </Button>
          </Box>

          {(configAgent?.name === 'openclaw' || configAgent?.agentName === 'openclaw') && (
            <Box sx={{ mt: 3 }}>
              <Typography variant="subtitle2" sx={{ mb: 1 }}>
                Workspace Skills
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                Sync imported pod skills into this agent’s workspace `skills/` directory. Saving overwrites the
                directory to avoid conflicts.
              </Typography>
              <FormControlLabel
                control={(
                  <Checkbox
                    checked={skillSyncAllPods}
                    onChange={(event) => setSkillSyncAllPods(event.target.checked)}
                  />
                )}
                label="Use all pods where this agent is installed"
                sx={{ mb: 2 }}
              />
              {!skillSyncAllPods && (
                <FormControl fullWidth sx={{ mb: 2 }}>
                  <InputLabel id="skill-sync-pods-label">Pods to sync</InputLabel>
                  <Select
                    labelId="skill-sync-pods-label"
                    label="Pods to sync"
                    multiple
                    value={skillSyncPods}
                    onChange={(event) => setSkillSyncPods(event.target.value)}
                    renderValue={(selected) => {
                      const names = skillSyncPodOptions
                        .filter((pod) => selected.includes(pod.podId))
                        .map((pod) => pod.podName);
                      return names.join(', ');
                    }}
                  >
                    {skillSyncPodOptions.map((pod) => (
                      <MenuItem key={pod.podId} value={pod.podId}>
                        <Checkbox checked={skillSyncPods.includes(pod.podId)} />
                        <ListItemText primary={pod.podName} />
                      </MenuItem>
                    ))}
                  </Select>
                </FormControl>
              )}
              <FormControl fullWidth sx={{ mb: 2 }}>
                <InputLabel id="skill-sync-mode-label">Sync mode</InputLabel>
                <Select
                  labelId="skill-sync-mode-label"
                  label="Sync mode"
                  value={skillSyncMode}
                  onChange={(event) => setSkillSyncMode(event.target.value)}
                >
                  <MenuItem value="all">All imported skills</MenuItem>
                  <MenuItem value="selected">Only selected skills</MenuItem>
                </Select>
              </FormControl>
              {skillSyncMode === 'selected' && (
                <FormControl fullWidth sx={{ mb: 2 }}>
                  <InputLabel id="skill-sync-skills-label">Skills to sync</InputLabel>
                  <Select
                    labelId="skill-sync-skills-label"
                    label="Skills to sync"
                    multiple
                    value={skillSyncSkills}
                    onChange={(event) => setSkillSyncSkills(event.target.value)}
                    renderValue={(selected) => selected.join(', ')}
                  >
                    {skillSyncSkillOptions.map((skill) => (
                      <MenuItem key={skill.name} value={skill.name}>
                        <Checkbox checked={skillSyncSkills.includes(skill.name)} />
                        <ListItemText primary={skill.name} secondary={skill.description || ''} />
                      </MenuItem>
                    ))}
                  </Select>
                </FormControl>
              )}
              {(skillSyncPodsLoading || skillSyncSkillLoading) && (
                <Typography color="text.secondary">Loading skill sync data...</Typography>
              )}
            </Box>
          )}

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
              userTokenValue={userTokenValue}
              userTokenMeta={userTokenMeta}
              userTokenScopes={userTokenScopes}
              userTokenLoading={userTokenLoading}
              userTokenRevoking={userTokenRevoking}
              onToggleUserScope={handleToggleUserScope}
              onGenerateUserToken={handleGenerateUserToken}
              onRevokeUserToken={handleRevokeUserToken}
            />
          ) : (
            <>
              <Typography variant="subtitle2" sx={{ mb: 1 }}>
                Provision Runtime (Local)
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                Create tokens and write local runtime config for this agent instance.
              </Typography>
              <FormControlLabel
                control={(
                  <Checkbox
                    checked={provisionIncludeUserToken}
                    onChange={(event) => setProvisionIncludeUserToken(event.target.checked)}
                  />
                )}
                label="Include bot user token (recommended for OpenClaw)"
                sx={{ mb: 2 }}
              />
              <Button
                variant="contained"
                onClick={handleProvisionRuntime}
                disabled={provisionLoading}
                fullWidth
                sx={{ mb: 2 }}
              >
                {provisionLoading ? 'Provisioning...' : 'Provision Runtime'}
              </Button>
              {provisionError && (
                <Alert severity="error" sx={{ mb: 2 }}>
                  {provisionError}
                </Alert>
              )}
              {provisionResult && (
                <Alert severity={provisionResult.restartRequired ? 'warning' : 'success'} sx={{ mb: 2 }}>
                  {provisionResult.restartRequired
                    ? 'Runtime config written. OpenClaw gateway needs restart.'
                    : 'Runtime config written.'}
                  {provisionResult.runtimeStarted
                    ? ' Runtime container started.'
                    : ' Runtime container not started.'}
                </Alert>
              )}

              <Typography variant="subtitle2" sx={{ mb: 1 }}>
                Runtime Controls
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                Start/stop and inspect the local runtime container.
              </Typography>
              <Stack direction="row" spacing={1} sx={{ mb: 2, flexWrap: 'wrap' }}>
                <Button
                  variant="outlined"
                  onClick={fetchRuntimeStatus}
                  disabled={runtimeStatusLoading}
                >
                  Refresh Status
                </Button>
                <Button
                  variant="outlined"
                  onClick={handleStartRuntime}
                  disabled={runtimeStatusLoading}
                >
                  Start
                </Button>
                <Button
                  variant="outlined"
                  color="error"
                  onClick={handleStopRuntime}
                  disabled={runtimeStatusLoading}
                >
                  Stop
                </Button>
                <Button
                  variant="outlined"
                  onClick={handleRestartRuntime}
                  disabled={runtimeStatusLoading}
                >
                  Restart
                </Button>
                <Button
                  variant="outlined"
                  onClick={() => {
                    setRuntimeLogsOpen(true);
                    fetchRuntimeLogs();
                  }}
                  disabled={runtimeStatusLoading}
                >
                  View Logs
                </Button>
              </Stack>
              {runtimeStatusError && (
                <Alert severity="error" sx={{ mb: 2 }}>
                  {runtimeStatusError}
                </Alert>
              )}
              {runtimeStatus && (
                <Alert severity="info" sx={{ mb: 2 }}>
                  Status: {runtimeStatus.status?.status || runtimeStatus.status?.state || runtimeStatus.status}
                  {runtimeStatus.status?.service ? ` • Service ${runtimeStatus.status.service}` : ''}
                </Alert>
              )}

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

              <Divider sx={{ my: 3 }} />

              <Typography variant="subtitle2" sx={{ mb: 1 }}>
                Designated User Token
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                Use a bot user API token for MCP skills or direct REST access. Leave all
                permissions unchecked for full access. Generating a new token rotates the old one.
              </Typography>

              <FormGroup sx={{ mb: 2 }}>
                {agentUserTokenScopes.map((scope) => (
                  <FormControlLabel
                    key={scope.id}
                    control={(
                      <Checkbox
                        checked={userTokenScopes.includes(scope.id)}
                        onChange={() => handleToggleUserScope(scope.id)}
                      />
                    )}
                    label={scope.label}
                  />
                ))}
              </FormGroup>

              {userTokenMeta.hasToken && (
                <Alert severity="info" sx={{ mb: 2 }}>
                  Token issued {userTokenMeta.createdAt ? new Date(userTokenMeta.createdAt).toLocaleString() : 'recently'}.
                  Revoke to rotate.
                </Alert>
              )}

              <Button
                variant="outlined"
                onClick={handleGenerateUserToken}
                disabled={userTokenLoading}
                fullWidth
                sx={{ mb: 2 }}
              >
                {userTokenLoading ? 'Generating...' : 'Generate User Token'}
              </Button>

              {userTokenValue && (
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2 }}>
                  <TextField
                    fullWidth
                    label="User Token"
                    value={userTokenValue}
                    size="small"
                    InputProps={{ readOnly: true }}
                  />
                  <Tooltip title="Copy">
                    <IconButton onClick={async () => navigator.clipboard.writeText(userTokenValue)}>
                      <CopyIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                </Box>
              )}

              <Button
                variant="text"
                color="error"
                onClick={handleRevokeUserToken}
                disabled={!userTokenMeta.hasToken || userTokenRevoking}
              >
                {userTokenRevoking ? 'Revoking...' : 'Revoke User Token'}
              </Button>
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

      <Dialog open={adminTokensOpen} onClose={closeAdminTokensDialog} fullWidth maxWidth="sm">
        <DialogTitle>
          Runtime Tokens
          {adminTokensInstallation?.displayName
            ? ` • ${adminTokensInstallation.displayName}`
            : adminTokensInstallation?.agentName
          }
        </DialogTitle>
        <DialogContent sx={{ pt: 2 }}>
          {adminTokensInstallation?.runtimeTokens?.length ? (
            <Stack spacing={1.5}>
              {adminTokensInstallation.runtimeTokens.map((token) => (
                <Paper key={token.id} variant="outlined" sx={{ p: 1.5 }}>
                  <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ sm: 'center' }}>
                    <Box sx={{ flexGrow: 1 }}>
                      <Typography variant="subtitle2">
                        {token.label || 'Untitled token'}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        Created {formatDateTime(token.createdAt)} • Last used {formatDateTime(token.lastUsedAt)}
                      </Typography>
                    </Box>
                    <Button
                      size="small"
                      color="error"
                      variant="outlined"
                      onClick={() => handleAdminRevokeToken(token.id)}
                      disabled={adminRevokeLoadingId === token.id}
                    >
                      {adminRevokeLoadingId === token.id ? 'Revoking...' : 'Revoke'}
                    </Button>
                  </Stack>
                </Paper>
              ))}
            </Stack>
          ) : (
            <Alert severity="info">No runtime tokens for this installation.</Alert>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={closeAdminTokensDialog}>Close</Button>
        </DialogActions>
      </Dialog>

      <Dialog open={Boolean(adminUninstallTarget)} onClose={closeAdminUninstallDialog} fullWidth maxWidth="xs">
        <DialogTitle>Uninstall agent instance</DialogTitle>
        <DialogContent sx={{ pt: 2 }}>
          <Typography variant="body2" sx={{ mb: 2 }}>
            This will remove the agent from the pod and revoke access for this installation.
          </Typography>
          {adminUninstallTarget && (
            <Alert severity="warning">
              {adminUninstallTarget.displayName || adminUninstallTarget.agentName}
              {' • '}
              {adminUninstallTarget.instanceId || 'default'}
              {' • '}
              {adminUninstallTarget.pod?.name || 'Unknown pod'}
            </Alert>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={closeAdminUninstallDialog}>Cancel</Button>
          <Button
            color="error"
            variant="contained"
            onClick={handleAdminUninstallConfirm}
            disabled={adminUninstallLoading}
          >
            {adminUninstallLoading ? 'Uninstalling...' : 'Uninstall'}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={runtimeLogsOpen} onClose={() => setRuntimeLogsOpen(false)} fullWidth maxWidth="md">
        <DialogTitle>Runtime Logs</DialogTitle>
        <DialogContent sx={{ display: 'grid', gap: 2, mt: 1 }}>
          <Stack direction="row" spacing={2} alignItems="center">
            <TextField
              label="Lines"
              type="number"
              value={runtimeLogsLines}
              onChange={(event) => setRuntimeLogsLines(Number(event.target.value) || 200)}
              size="small"
              sx={{ width: 120 }}
            />
            <TextField
              label="Filter (instance id)"
              value={runtimeLogsFilter}
              onChange={(event) => setRuntimeLogsFilter(event.target.value)}
              size="small"
              sx={{ minWidth: 220 }}
              placeholder={configAgent?.instanceId || 'default'}
            />
            <Button
              variant="text"
              onClick={() => setRuntimeLogsFilter('')}
              disabled={!runtimeLogsFilter}
            >
              Show All
            </Button>
            <FormControlLabel
              control={(
                <Checkbox
                  checked={runtimeLogsAutoRefresh}
                  onChange={(event) => setRuntimeLogsAutoRefresh(event.target.checked)}
                />
              )}
              label="Live"
            />
            <Button variant="outlined" onClick={fetchRuntimeLogs} disabled={runtimeLogsLoading}>
              Refresh
            </Button>
          </Stack>
          {runtimeLogsError && (
            <Alert severity="error">{runtimeLogsError}</Alert>
          )}
          <TextField
            fullWidth
            multiline
            minRows={12}
            value={(() => {
              if (runtimeLogsLoading) return 'Loading logs...';
              if (!runtimeLogsFilter) return runtimeLogsContent;
              const needle = runtimeLogsFilter.trim();
              if (!needle) return runtimeLogsContent;
              return runtimeLogsContent
                .split('\n')
                .filter((line) => line.includes(`[${needle}]`) || line.includes(needle))
                .join('\n');
            })()}
            InputProps={{ readOnly: true }}
            inputRef={runtimeLogsInputRef}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setRuntimeLogsOpen(false)}>Close</Button>
        </DialogActions>
      </Dialog>

      <Dialog open={skillsCatalogOpen} onClose={closeSkillsCatalog} fullWidth maxWidth="md">
        <DialogTitle>Skills Catalog</DialogTitle>
        <DialogContent sx={{ pt: 2 }}>
          {skillsCatalogLoading && <Typography>Loading catalog...</Typography>}
          {skillsCatalogError && <Typography color="error">{skillsCatalogError}</Typography>}
          {!skillsCatalogLoading && skillsCatalogItems.length === 0 && (
            <Typography color="text.secondary">No skills available yet.</Typography>
          )}
          <Grid container spacing={2} sx={{ mt: 1 }}>
            {skillsCatalogItems.map((item) => (
              <Grid item xs={12} md={6} key={item.id || item.name}>
                <Card variant="outlined">
                  <CardContent>
                    <Typography variant="subtitle1">{item.name}</Typography>
                    <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                      {item.description || 'No description'}
                    </Typography>
                    {item.license && (
                      <Chip
                        size="small"
                        label={`License: ${item.license.name || item.license}`}
                        sx={{ mb: 1, cursor: 'pointer' }}
                        onClick={() => openLicenseDialog(item)}
                      />
                    )}
                    {item.tags?.length ? (
                      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
                        {item.tags.map((tag) => (
                          <Chip key={tag} size="small" label={tag} />
                        ))}
                      </Box>
                    ) : null}
                  </CardContent>
                  <CardActions sx={{ justifyContent: 'space-between' }}>
                    <Button href={item.sourceUrl} target="_blank" rel="noreferrer">
                      Source
                    </Button>
                    {item.license && (
                      <Button variant="text" onClick={() => openLicenseDialog(item)}>
                        View License
                      </Button>
                    )}
                    <Button
                      variant="contained"
                      onClick={() => beginSkillImport(item)}
                    >
                      Use This Skill
                    </Button>
                  </CardActions>
                </Card>
              </Grid>
            ))}
          </Grid>

          <Divider sx={{ my: 2 }} />

          <Typography ref={skillsSelectedRef} variant="subtitle2" sx={{ mb: 1 }}>
            Selected Skill
          </Typography>
          {skillsImportNotice && (
            <Alert severity="info" sx={{ mb: 2 }}>
              {skillsImportNotice}
            </Alert>
          )}
          <TextField
            fullWidth
            label="Skill Name"
            value={skillsImportState.name}
            onChange={(e) => setSkillsImportState((prev) => ({ ...prev, name: e.target.value }))}
            sx={{ mb: 2 }}
          />
          <TextField
            fullWidth
            label="Description"
            value={skillsImportState.description}
            onChange={(e) => setSkillsImportState((prev) => ({ ...prev, description: e.target.value }))}
            sx={{ mb: 2 }}
          />
          <TextField
            fullWidth
            label="Skill Content"
            value={skillsImportState.content}
            onChange={(e) => setSkillsImportState((prev) => ({ ...prev, content: e.target.value }))}
            multiline
            minRows={4}
            sx={{ mb: 2 }}
          />
          <TextField
            fullWidth
            label="Tags (comma separated)"
            value={skillsImportState.tags}
            onChange={(e) => setSkillsImportState((prev) => ({ ...prev, tags: e.target.value }))}
            sx={{ mb: 2 }}
          />
          <TextField
            fullWidth
            label="Source URL"
            value={skillsImportState.sourceUrl}
            onChange={(e) => setSkillsImportState((prev) => ({ ...prev, sourceUrl: e.target.value }))}
            sx={{ mb: 2 }}
          />
          <TextField
            fullWidth
            label="License"
            value={skillsImportState.license}
            onChange={(e) => setSkillsImportState((prev) => ({ ...prev, license: e.target.value }))}
            sx={{ mb: 2 }}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={closeSkillsCatalog}>Close</Button>
          <Button
            variant="contained"
            onClick={handleImportSkill}
            disabled={!skillsImportState.name || !skillsImportState.content || !selectedPodId}
          >
            Import to Agent
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

      <Dialog open={installDialogOpen} onClose={closeInstallDialog} fullWidth maxWidth="xs">
        <DialogTitle>Select pods for install</DialogTitle>
        <DialogContent sx={{ pt: 2 }}>
          <TextField
            fullWidth
            label="Instance name"
            value={installInstanceName}
            onChange={(e) => setInstallInstanceName(e.target.value)}
            size="small"
            sx={{ mb: 2 }}
            helperText="Give this bot a unique name (e.g., Cuz, Como). Use @name to mention in chat."
          />
          {/* Show existing agent info if found */}
          {checkingExisting && (
            <Alert severity="info" sx={{ mb: 2 }}>
              Checking for existing agent...
            </Alert>
          )}
          {existingAgentInfo && !checkingExisting && (
            <Alert
              severity="success"
              sx={{ mb: 2 }}
            >
              <Typography variant="body2" fontWeight="medium">
                This agent already exists in {existingAgentInfo.installations?.length || 0} pod(s)
              </Typography>
              <Typography variant="caption" color="text.secondary">
                {existingAgentInfo.installations?.map((i) => i.podName).join(', ')}
              </Typography>
              <Typography variant="body2" sx={{ mt: 1 }}>
                Installing to new pods will share the same agent identity and memory.
                {existingAgentInfo.hasRuntimeToken && ' Runtime token already provisioned.'}
              </Typography>
            </Alert>
          )}
          <TextField
            fullWidth
            label="Instance ID (optional)"
            value={installInstanceId}
            onChange={(e) => setInstallInstanceId(e.target.value)}
            size="small"
            sx={{ mb: 2 }}
            helperText={`Derived from name: "${deriveInstanceId(installInstanceName, installAgent?.agentName || installAgent?.name)}"`}
          />
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

      <Dialog open={createDialogOpen} onClose={closeCreateDialog} fullWidth maxWidth="xs">
        <DialogTitle>Create Agent</DialogTitle>
        <DialogContent sx={{ pt: 2 }}>
          <FormControl fullWidth size="small" sx={{ mb: 2 }}>
            <InputLabel id="create-agent-type-label">Agent Type</InputLabel>
            <Select
              labelId="create-agent-type-label"
              label="Agent Type"
              value={createAgentType}
              onChange={(e) => setCreateAgentType(e.target.value)}
            >
              {agents.map((agent) => (
                <MenuItem key={agent.name} value={agent.name}>
                  {agent.displayName || agent.name}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
          <TextField
            fullWidth
            label="Agent name"
            value={createAgentName}
            onChange={(e) => setCreateAgentName(e.target.value)}
            size="small"
            sx={{ mb: 2 }}
            helperText="This shows as the card title."
          />
          <TextField
            fullWidth
            label="Description"
            value={createAgentDescription}
            onChange={(e) => setCreateAgentDescription(e.target.value)}
            size="small"
            multiline
            rows={3}
            sx={{ mb: 2 }}
          />
          <FormControl fullWidth size="small">
            <InputLabel id="create-agent-visibility-label">Visibility</InputLabel>
            <Select
              labelId="create-agent-visibility-label"
              label="Visibility"
              value={createAgentVisibility}
              onChange={(e) => setCreateAgentVisibility(e.target.value)}
            >
              <MenuItem value="private">Private (only me)</MenuItem>
              <MenuItem value="public">Public (anyone can install)</MenuItem>
            </Select>
          </FormControl>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={closeCreateDialog}>Cancel</Button>
          <Button variant="contained" onClick={handleCreateTemplate} disabled={createSaving}>
            {createSaving ? 'Creating...' : 'Create'}
          </Button>
        </DialogActions>
      </Dialog>
    </Container>
  );
};

export default AgentsHub;
