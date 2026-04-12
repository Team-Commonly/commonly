import React, { useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import {
  Avatar,
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
  IconButton,
  InputLabel,
  LinearProgress,
  List,
  ListItem,
  ListItemAvatar,
  ListItemText,
  MenuItem,
  Rating,
  Select,
  Stack,
  Switch,
  Tabs,
  Tab,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import RefreshIcon from '@mui/icons-material/Refresh';
import { useAuth } from '../../context/AuthContext';

interface CatalogItem {
  id?: string;
  name?: string;
  description?: string;
  category?: string;
  tags?: string[];
  sourceUrl?: string;
  license?: { name?: string; text?: string; path?: string } | string;
  stars?: number;
  type?: string;
  repo?: string;
}

interface RatingHistogram {
  1: number;
  2: number;
  3: number;
  4: number;
  5: number;
}

interface RatingSummary {
  count: number;
  avg: number;
  histogram: RatingHistogram;
  mine?: { rating: number; comment: string } | null;
}

interface RatingRecord {
  _id: string;
  skillId: string;
  rating: number;
  comment: string;
  createdAt: string;
  updatedAt: string;
  user: {
    _id: string;
    username: string;
    profilePicture: string;
  } | null;
}

interface Pod {
  _id: string;
  name: string;
}

interface PodAgent {
  name: string;
  instanceId: string;
  displayName?: string;
}

interface Gateway {
  _id: string;
  name: string;
}

interface GatewayEntryInfo {
  envKeys?: string[];
  apiKeyPresent?: boolean;
}

interface LicenseState {
  title: string;
  text: string;
  path: string;
}

interface ImportState {
  podId: string;
  scope: string;
  agentKey: string;
  name: string;
  tags: string;
  sourceUrl: string;
  license: string;
  description: string;
}

interface GatewayForm {
  name: string;
  slug: string;
  mode: string;
  baseUrl: string;
  configPath: string;
  namespace: string;
  image: string;
}

const getAuthHeaders = (): { headers: { Authorization: string } } => {
  const token = localStorage.getItem('token');
  return { headers: { Authorization: `Bearer ${token}` } };
};

const SkillsCatalogPage: React.FC = () => {
  const [catalogItems, setCatalogItems] = useState<CatalogItem[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState('');
  const [catalogPage, setCatalogPage] = useState(1);
  const [catalogTotalPages, setCatalogTotalPages] = useState(1);
  const [catalogTotalItems, setCatalogTotalItems] = useState(0);
  const [categories, setCategories] = useState<string[]>([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('all');
  const [sortBy, setSortBy] = useState('default');
  const [groupByCategory, setGroupByCategory] = useState(true);
  const [activeTab, setActiveTab] = useState('catalog');
  const { currentUser } = useAuth();
  const isGlobalAdmin = currentUser?.role === 'admin';

  const [pods, setPods] = useState<Pod[]>([]);
  const [selectedPodId, setSelectedPodId] = useState('');
  const [podAgents, setPodAgents] = useState<PodAgent[]>([]);

  const [importOpen, setImportOpen] = useState(false);
  const [licenseOpen, setLicenseOpen] = useState(false);
  const [licenseState, setLicenseState] = useState<LicenseState>({ title: '', text: '', path: '' });
  const [requirementsLoading, setRequirementsLoading] = useState(false);
  const [requirementsError, setRequirementsError] = useState('');
  const [requirementsList, setRequirementsList] = useState<string[]>([]);
  const [gatewayLoading, setGatewayLoading] = useState(false);
  const [gatewayError, setGatewayError] = useState('');
  const [gatewayEntries, setGatewayEntries] = useState<Record<string, GatewayEntryInfo>>({});
  const [gatewayId, setGatewayId] = useState('');
  const [gatewaySkillKey, setGatewaySkillKey] = useState('');
  const [gatewayHintLoading, setGatewayHintLoading] = useState(false);
  const [gatewayHintError, setGatewayHintError] = useState('');
  const [gatewayHintList, setGatewayHintList] = useState<string[]>([]);
  const [gatewayPrimaryEnv, setGatewayPrimaryEnv] = useState('');
  const [gatewayEnvInputs, setGatewayEnvInputs] = useState<Record<string, string>>({});
  const [gatewayEnvClears, setGatewayEnvClears] = useState<Set<string>>(new Set());
  const [gatewayApiKeyInput, setGatewayApiKeyInput] = useState('');
  const [gatewayApiKeyClear, setGatewayApiKeyClear] = useState(false);
  const [gatewayAdvancedOpen, setGatewayAdvancedOpen] = useState(false);
  const [gatewayAdvancedJson, setGatewayAdvancedJson] = useState('');
  const [gatewayCustomKey, setGatewayCustomKey] = useState('');
  const [gatewayCustomValue, setGatewayCustomValue] = useState('');
  const [gatewaySaving, setGatewaySaving] = useState(false);
  const [gatewayList, setGatewayList] = useState<Gateway[]>([]);
  const [gatewayDialogOpen, setGatewayDialogOpen] = useState(false);
  const [gatewayForm, setGatewayForm] = useState<GatewayForm>({
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
  const [importedSkills, setImportedSkills] = useState<Set<string>>(new Set());
  const [installedItems, setInstalledItems] = useState<CatalogItem[]>([]);
  // Ratings state — batch summaries for card display + detail dialog state.
  const [ratingSummaries, setRatingSummaries] = useState<Record<string, RatingSummary>>({});
  const [detailItem, setDetailItem] = useState<CatalogItem | null>(null);
  const [detailSummary, setDetailSummary] = useState<RatingSummary | null>(null);
  const [detailRatings, setDetailRatings] = useState<RatingRecord[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [myRating, setMyRating] = useState<number>(0);
  const [myComment, setMyComment] = useState<string>('');
  const [mySubmitting, setMySubmitting] = useState(false);
  // Catalog freshness metadata — surfaced as "Last updated X ago".
  const [catalogLocalRefreshedAt, setCatalogLocalRefreshedAt] = useState<string | null>(null);
  const [catalogUpstreamRefreshedAt, setCatalogUpstreamRefreshedAt] = useState<string | null>(null);
  const [importState, setImportState] = useState<ImportState>({
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

  const normalizeSkillKey = (value: unknown): string => String(value || '').trim().toLowerCase();

  const catalogSkillOptions = useMemo(() => {
    const map = new Map<string, CatalogItem>();
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
      const map = new Map<string, CatalogItem>();
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

  const getCategory = (item: CatalogItem): string => {
    if (item?.category) return item.category;
    return 'Other';
  };

  const filteredItems = useMemo(() => {
    const term = searchTerm.trim().toLowerCase();
    const base = catalogItems.filter((item) => {
      if (selectedCategory !== 'all' && getCategory(item) !== selectedCategory) return false;
      if (!term) return true;
      const haystack = `${item.name || ''} ${item.description || ''}`.toLowerCase();
      return haystack.includes(term);
    });
    // Client-side rating sort — the backend already handles name and stars.
    // Avg rating is layered on top of the cached summaries.
    if (sortBy === 'rating') {
      return [...base].sort((a, b) => {
        const aSummary = ratingSummaries[a.id || a.name || ''];
        const bSummary = ratingSummaries[b.id || b.name || ''];
        const aAvg = aSummary?.avg || 0;
        const bAvg = bSummary?.avg || 0;
        if (bAvg !== aAvg) return bAvg - aAvg;
        const aCount = aSummary?.count || 0;
        const bCount = bSummary?.count || 0;
        return bCount - aCount;
      });
    }
    return base;
  }, [catalogItems, searchTerm, selectedCategory, sortBy, ratingSummaries]);

  const groupedItems = useMemo(() => {
    if (!groupByCategory) {
      return [{ category: 'All Skills', items: filteredItems }];
    }
    const groups = new Map<string, CatalogItem[]>();
    filteredItems.forEach((item) => {
      const category = getCategory(item);
      if (!groups.has(category)) groups.set(category, []);
      groups.get(category)!.push(item);
    });
    return Array.from(groups.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([category, items]) => ({ category, items }));
  }, [filteredItems, groupByCategory]);

  const fetchCatalog = async (): Promise<void> => {
    setCatalogLoading(true);
    setCatalogError('');
    try {
      const response = await axios.get<{
        items?: CatalogItem[];
        totalPages?: number;
        total?: number;
        categories?: string[];
        localRefreshedAt?: string | null;
        upstreamRefreshedAt?: string | null;
      }>('/api/skills/catalog', {
        ...getAuthHeaders(),
        params: {
          source: 'awesome',
          q: searchTerm || undefined,
          category: selectedCategory !== 'all' ? selectedCategory : undefined,
          sort: sortBy !== 'default' ? sortBy : undefined,
          page: catalogPage,
          limit: 60,
        },
      });
      setCatalogItems(response.data?.items || []);
      setCatalogTotalPages(response.data?.totalPages || 1);
      setCatalogTotalItems(response.data?.total || 0);
      setCategories(response.data?.categories || []);
      setCatalogLocalRefreshedAt(response.data?.localRefreshedAt || null);
      setCatalogUpstreamRefreshedAt(response.data?.upstreamRefreshedAt || null);
    } catch (error: unknown) {
      const axiosErr = error as { response?: { data?: { error?: string } } };
      console.error('Failed to fetch skills catalog:', error);
      setCatalogError(axiosErr.response?.data?.error || 'Failed to load catalog');
      setCatalogItems([]);
    } finally {
      setCatalogLoading(false);
    }
  };

  const fetchPods = async (): Promise<void> => {
    try {
      const response = await axios.get<Pod[]>('/api/pods', getAuthHeaders());
      setPods(response.data || []);
    } catch (error) {
      console.error('Failed to fetch pods:', error);
    }
  };

  // Batch-fetch rating summaries for every visible card so we don't issue
  // one HTTP call per skill.
  const fetchRatingSummariesForItems = async (items: CatalogItem[]): Promise<void> => {
    const ids = Array.from(new Set(items.map((item) => item.id || item.name || '').filter(Boolean)));
    if (!ids.length) return;
    try {
      const response = await axios.get<{ summaries?: Record<string, RatingSummary> }>(
        '/api/skills/ratings/summary',
        { ...getAuthHeaders(), params: { skillIds: ids.join(',') } },
      );
      const summaries = response.data?.summaries || {};
      setRatingSummaries((prev) => ({ ...prev, ...summaries }));
    } catch (error) {
      console.warn('Failed to fetch rating summaries:', error);
    }
  };

  const fetchSkillDetail = async (item: CatalogItem): Promise<void> => {
    const skillId = item.id || item.name;
    if (!skillId) return;
    setDetailLoading(true);
    try {
      const [summaryRes, listRes] = await Promise.all([
        axios.get<RatingSummary>(`/api/skills/${encodeURIComponent(skillId)}/ratings/summary`, getAuthHeaders()),
        axios.get<{ items: RatingRecord[] }>(
          `/api/skills/${encodeURIComponent(skillId)}/ratings`,
          { ...getAuthHeaders(), params: { limit: 50 } },
        ),
      ]);
      const summary = summaryRes.data || { count: 0, avg: 0, histogram: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } };
      setDetailSummary(summary);
      setDetailRatings(listRes.data?.items || []);
      setMyRating(summary.mine?.rating || 0);
      setMyComment(summary.mine?.comment || '');
      setRatingSummaries((prev) => ({ ...prev, [skillId]: summary }));
    } catch (error) {
      console.error('Failed to load skill detail:', error);
      setDetailRatings([]);
      setDetailSummary({ count: 0, avg: 0, histogram: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } });
    } finally {
      setDetailLoading(false);
    }
  };

  const openDetailDialog = (item: CatalogItem): void => {
    setDetailItem(item);
    setDetailSummary(null);
    setDetailRatings([]);
    setMyRating(0);
    setMyComment('');
    fetchSkillDetail(item);
  };

  const closeDetailDialog = (): void => {
    setDetailItem(null);
    setDetailSummary(null);
    setDetailRatings([]);
    setMyRating(0);
    setMyComment('');
  };

  const submitMyRating = async (): Promise<void> => {
    if (!detailItem || !myRating) return;
    const skillId = detailItem.id || detailItem.name;
    if (!skillId) return;
    setMySubmitting(true);
    try {
      await axios.post(
        `/api/skills/${encodeURIComponent(skillId)}/rating`,
        { rating: myRating, comment: myComment },
        getAuthHeaders(),
      );
      await fetchSkillDetail(detailItem);
    } catch (error) {
      console.error('Failed to submit rating:', error);
    } finally {
      setMySubmitting(false);
    }
  };

  const deleteMyRating = async (): Promise<void> => {
    if (!detailItem) return;
    const skillId = detailItem.id || detailItem.name;
    if (!skillId) return;
    setMySubmitting(true);
    try {
      await axios.delete(
        `/api/skills/${encodeURIComponent(skillId)}/rating`,
        getAuthHeaders(),
      );
      await fetchSkillDetail(detailItem);
      setMyRating(0);
      setMyComment('');
    } catch (error) {
      console.error('Failed to delete rating:', error);
    } finally {
      setMySubmitting(false);
    }
  };

  const formatRelativeTime = (iso: string | null): string => {
    if (!iso) return 'never';
    const then = Date.parse(iso);
    if (Number.isNaN(then)) return 'never';
    const diffSec = Math.max(0, Math.floor((Date.now() - then) / 1000));
    if (diffSec < 60) return `${diffSec}s ago`;
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `${diffMin} minute${diffMin === 1 ? '' : 's'} ago`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr} hour${diffHr === 1 ? '' : 's'} ago`;
    const diffDay = Math.floor(diffHr / 24);
    return `${diffDay} day${diffDay === 1 ? '' : 's'} ago`;
  };

  const fetchPodAgents = async (podId: string): Promise<void> => {
    if (!podId) {
      setPodAgents([]);
      return;
    }
    try {
      const response = await axios.get<{ agents?: PodAgent[] }>(
        `/api/registry/pods/${podId}/agents`,
        getAuthHeaders(),
      );
      setPodAgents(response.data?.agents || []);
    } catch (error: unknown) {
      const axiosErr = error as { response?: { status?: number } };
      console.warn('Failed to fetch pod agents:', axiosErr.response?.status);
      setPodAgents([]);
    }
  };

  const fetchImportedSkills = async (
    podId: string,
    scope: string,
    agent: PodAgent | null | undefined,
  ): Promise<void> => {
    if (!podId) {
      setImportedSkills(new Set());
      return;
    }
    try {
      const params: Record<string, string | undefined> = { scope };
      if (scope === 'agent') {
        params.agentName = agent?.name;
        params.instanceId = agent?.instanceId;
      }
      const response = await axios.get<{ items?: CatalogItem[] }>(
        `/api/skills/pods/${podId}/imported`,
        { ...getAuthHeaders(), params },
      );
      const items = response.data?.items || [];
      const names = items
        .map((item) => (item?.name || '').toLowerCase())
        .filter(Boolean);
      setImportedSkills(new Set(names));
      setInstalledItems(items);
    } catch (error: unknown) {
      const axiosErr = error as { response?: { status?: number } };
      console.warn('Failed to fetch imported skills:', axiosErr.response?.status);
      setImportedSkills(new Set());
      setInstalledItems([]);
    }
  };

  const fetchSkillRequirements = async (sourceUrl: string): Promise<void> => {
    if (!sourceUrl) {
      setRequirementsList([]);
      setRequirementsError('');
      return;
    }
    setRequirementsLoading(true);
    setRequirementsError('');
    try {
      const response = await axios.get<{ requirements?: string[] }>(
        '/api/skills/requirements',
        { ...getAuthHeaders(), params: { sourceUrl } },
      );
      const requirements = response.data?.requirements || [];
      setRequirementsList(requirements);
    } catch (error: unknown) {
      const axiosErr = error as { response?: { data?: { error?: string } } };
      console.warn('Failed to fetch skill requirements:', error);
      setRequirementsError(axiosErr.response?.data?.error || 'Failed to detect credentials');
      setRequirementsList([]);
    } finally {
      setRequirementsLoading(false);
    }
  };

  const fetchGatewayCredentials = async (): Promise<void> => {
    if (!isGlobalAdmin) return;
    setGatewayLoading(true);
    setGatewayError('');
    try {
      const gatewaysResponse = await axios.get<{ gateways?: Gateway[] }>(
        '/api/gateways',
        getAuthHeaders(),
      );
      const gateways = gatewaysResponse.data?.gateways || [];
      setGatewayList(gateways);
      const selectedGatewayId =
        gateways.find((g) => g._id === gatewayId)?._id || gateways[0]?._id || '';
      if (selectedGatewayId && !gatewayId) {
        setGatewayId(selectedGatewayId);
      }
      const response = await axios.get<{ entries?: Record<string, GatewayEntryInfo> }>(
        '/api/skills/gateway-credentials',
        {
          ...getAuthHeaders(),
          params: selectedGatewayId ? { gatewayId: selectedGatewayId } : {},
        },
      );
      setGatewayEntries(response.data?.entries || {});
    } catch (error: unknown) {
      const axiosErr = error as { response?: { data?: { error?: string } } };
      console.warn('Failed to load gateway credentials:', error);
      setGatewayError(axiosErr.response?.data?.error || 'Failed to load gateway credentials');
      setGatewayEntries({});
    } finally {
      setGatewayLoading(false);
    }
  };

  const fetchGatewayHints = async (skillName: string): Promise<void> => {
    if (!skillName) return;
    setGatewayHintLoading(true);
    setGatewayHintError('');
    setGatewayHintList([]);
    setGatewayPrimaryEnv('');
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
      const response = await axios.get<{ requirements?: string[]; primaryEnv?: string }>(
        '/api/skills/requirements',
        { ...getAuthHeaders(), params: { sourceUrl } },
      );
      const requirements = response.data?.requirements || [];
      const primaryEnv = response.data?.primaryEnv || '';
      setGatewayPrimaryEnv(primaryEnv);
      setGatewayHintList(requirements.filter((hint) => hint !== primaryEnv));
    } catch (error: unknown) {
      const axiosErr = error as { response?: { data?: { error?: string } } };
      console.warn('Failed to load gateway hints:', error);
      setGatewayHintError(axiosErr.response?.data?.error || 'Failed to detect credentials');
    } finally {
      setGatewayHintLoading(false);
    }
  };

  const updateGatewayEnvInput = (key: string, value: string): void => {
    setGatewayEnvInputs((prev) => ({ ...prev, [key]: value }));
    setGatewayEnvClears((prev) => {
      const next = new Set(prev);
      if (value) {
        next.delete(key);
      }
      return next;
    });
  };

  const markGatewayClear = (key: string): void => {
    setGatewayEnvClears((prev) => new Set([...prev, key]));
    setGatewayEnvInputs((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

  const markGatewayApiKeyClear = (): void => {
    setGatewayApiKeyInput('');
    setGatewayApiKeyClear(true);
  };

  const addGatewayCustomEnv = (): void => {
    const key = gatewayCustomKey.trim();
    if (!key) return;
    updateGatewayEnvInput(key, gatewayCustomValue.trim());
    setGatewayCustomKey('');
    setGatewayCustomValue('');
  };

  const saveGatewayCredentials = async (): Promise<void> => {
    if (!gatewayId || !gatewaySkillKey) return;
    const trimmedAdvanced = gatewayAdvancedJson.trim();
    if (gatewayAdvancedOpen) {
      if (!trimmedAdvanced) {
        alert('Advanced JSON is enabled. Provide a JSON entry to save.');
        return;
      }
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(trimmedAdvanced);
      } catch (error) {
        alert('Advanced JSON must be valid JSON.');
        return;
      }
      const parsedObj = parsed as Record<string, unknown>;
      let entry: Record<string, unknown> | null = null;
      if (
        parsedObj?.skills &&
        typeof (parsedObj.skills as Record<string, unknown>).entries === 'object'
      ) {
        const entries = (parsedObj.skills as Record<string, unknown>).entries as Record<string, unknown>;
        entry = (entries[normalizeSkillKey(gatewaySkillKey)] ||
          entries[gatewaySkillKey] ||
          null) as Record<string, unknown> | null;
      } else if (parsedObj?.entries && typeof parsedObj.entries === 'object') {
        const entries = parsedObj.entries as Record<string, unknown>;
        entry = (entries[normalizeSkillKey(gatewaySkillKey)] ||
          entries[gatewaySkillKey] ||
          null) as Record<string, unknown> | null;
      } else {
        entry = parsedObj;
      }
      if (!entry || typeof entry !== 'object') {
        alert('Advanced JSON must be an object representing the skill entry.');
        return;
      }
      setGatewaySaving(true);
      try {
        await axios.patch(
          '/api/skills/gateway-credentials',
          {
            gatewayId,
            entries: {
              [gatewaySkillKey]: { __raw: true, ...entry },
            },
          },
          getAuthHeaders(),
        );
        await fetchGatewayCredentials();
        setGatewayEnvInputs({});
        setGatewayEnvClears(new Set());
        setGatewayApiKeyInput('');
        setGatewayApiKeyClear(false);
        return;
      } catch (error: unknown) {
        const axiosErr = error as { response?: { data?: { error?: string } } };
        console.error('Failed to save gateway credentials:', error);
        alert(axiosErr.response?.data?.error || 'Failed to save credentials');
        return;
      } finally {
        setGatewaySaving(false);
      }
    }

    const env: Record<string, string> = {};
    Object.entries(gatewayEnvInputs).forEach(([key, value]) => {
      if (value) env[key] = value;
    });
    gatewayEnvClears.forEach((key) => {
      if (!(key in env)) env[key] = '';
    });
    const hasPrimaryEnv = Boolean(gatewayPrimaryEnv);
    const shouldSendApiKey = Boolean(gatewayApiKeyInput) || gatewayApiKeyClear;
    if (!Object.keys(env).length && !shouldSendApiKey) {
      alert('Add at least one key or clear an existing key before saving.');
      return;
    }
    setGatewaySaving(true);
    try {
      const payloadEntry: Record<string, unknown> = {};
      const payloadEnv = { ...env };
      if (hasPrimaryEnv) {
        if (gatewayApiKeyInput) payloadEnv[gatewayPrimaryEnv] = gatewayApiKeyInput;
        if (gatewayApiKeyClear) payloadEnv[gatewayPrimaryEnv] = '';
      }
      if (Object.keys(payloadEnv).length) {
        payloadEntry.env = payloadEnv;
      } else if (Object.keys(env).length) {
        payloadEntry.env = env;
      }
      if (shouldSendApiKey) {
        payloadEntry.apiKey = gatewayApiKeyInput ? gatewayApiKeyInput : '';
      }
      await axios.patch(
        '/api/skills/gateway-credentials',
        {
          gatewayId,
          entries: { [gatewaySkillKey]: payloadEntry },
        },
        getAuthHeaders(),
      );
      await fetchGatewayCredentials();
      setGatewayEnvInputs({});
      setGatewayEnvClears(new Set());
      setGatewayApiKeyInput('');
      setGatewayApiKeyClear(false);
    } catch (error: unknown) {
      const axiosErr = error as { response?: { data?: { error?: string } } };
      console.error('Failed to save gateway credentials:', error);
      alert(axiosErr.response?.data?.error || 'Failed to save credentials');
    } finally {
      setGatewaySaving(false);
    }
  };

  const openGatewayDialog = (): void => {
    setGatewayCreateError('');
    setGatewayDialogOpen(true);
  };

  const closeGatewayDialog = (): void => {
    setGatewayDialogOpen(false);
  };

  const handleCreateGateway = async (): Promise<void> => {
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
    } catch (error: unknown) {
      const axiosErr = error as { response?: { data?: { error?: string } } };
      console.error('Failed to create gateway:', error);
      setGatewayCreateError(axiosErr.response?.data?.error || 'Failed to create gateway');
    } finally {
      setGatewayCreateLoading(false);
    }
  };

  useEffect(() => {
    fetchCatalog();
    fetchPods();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    setCatalogPage(1);
  }, [searchTerm, selectedCategory, sortBy]);

  useEffect(() => {
    fetchCatalog();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchTerm, selectedCategory, sortBy, catalogPage]);

  // Whenever the catalog items change, refresh rating summaries for the
  // visible slice so the card chips stay accurate.
  useEffect(() => {
    if (!catalogItems.length) return;
    fetchRatingSummariesForItems(catalogItems);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalogItems]);

  useEffect(() => {
    if (activeTab === 'gateway') {
      fetchGatewayCredentials();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);

  useEffect(() => {
    if (selectedPodId) {
      fetchPodAgents(selectedPodId);
      fetchImportedSkills(selectedPodId, 'pod', null);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
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
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [importState.podId, importState.scope, selectedAgent]);

  useEffect(() => {
    if (!importOpen) return;
    fetchSkillRequirements(importState.sourceUrl);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [importOpen, importState.sourceUrl]);

  useEffect(() => {
    if (importState.scope !== 'agent') {
      setImportState((prev) => ({ ...prev, agentKey: '' }));
    }
  }, [importState.scope]);

  useEffect(() => {
    if (activeTab !== 'gateway') return;
    if (!gatewaySkillKey && gatewaySkillOptions.length > 0) {
      setGatewaySkillKey(gatewaySkillOptions[0].name ?? '');
    }
  }, [activeTab, gatewaySkillKey, gatewaySkillOptions]);

  useEffect(() => {
    if (activeTab !== 'gateway') return;
    if (!gatewaySkillKey) return;
    fetchGatewayHints(gatewaySkillKey);
    setGatewayEnvInputs({});
    setGatewayEnvClears(new Set());
    setGatewayApiKeyInput('');
    setGatewayApiKeyClear(false);
    setGatewayAdvancedJson('');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, gatewaySkillKey]);

  useEffect(() => {
    if (activeTab !== 'gateway') return;
    if (!gatewayId) return;
    fetchGatewayCredentials();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, gatewayId]);

  const openImportDialog = (item: CatalogItem): void => {
    const license = item?.license;
    const licenseStr =
      typeof license === 'object' ? license?.name || '' : license || '';
    setImportState({
      podId: selectedPodId || '',
      scope: 'pod',
      agentKey: '',
      name: item?.name || '',
      tags: (item?.tags || []).join(', '),
      sourceUrl: item?.sourceUrl || '',
      license: licenseStr,
      description: item?.description || '',
    });
    setImportOpen(true);
  };

  const openLicenseDialog = (item: CatalogItem): void => {
    const license = item?.license;
    const title = typeof license === 'object' ? license?.name || 'License' : 'License';
    const text = typeof license === 'object' ? license?.text || 'No license text available.' : 'No license text available.';
    const path = typeof license === 'object' ? license?.path || '' : '';
    setLicenseState({ title, text, path });
    setLicenseOpen(true);
  };

  const closeLicenseDialog = (): void => {
    setLicenseOpen(false);
  };

  const closeImportDialog = (): void => {
    setImportOpen(false);
    setRequirementsList([]);
    setRequirementsError('');
    setRequirementsLoading(false);
  };

  const isImported = (itemName?: string): boolean => {
    if (!itemName) return false;
    return importedSkills.has(itemName.toLowerCase());
  };

  const handleImport = async (): Promise<void> => {
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
    } catch (error: unknown) {
      const axiosErr = error as { response?: { data?: { error?: string } } };
      console.error('Failed to import skill:', error);
      alert(axiosErr.response?.data?.error || 'Failed to import skill');
    }
  };

  const handleUninstall = async (itemName?: string): Promise<void> => {
    if (!importState.podId || !itemName) return;
    try {
      const params: Record<string, string | undefined> = {
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
    } catch (error: unknown) {
      const axiosErr = error as { response?: { data?: { error?: string } } };
      console.error('Failed to uninstall skill:', error);
      alert(axiosErr.response?.data?.error || 'Failed to uninstall skill');
    }
  };

  const getLicenseLabel = (item: CatalogItem): string => {
    if (!item.license) return '';
    if (typeof item.license === 'object') return item.license.name || 'License';
    return item.license;
  };

  return (
    <Container maxWidth="lg" sx={{ py: 4 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 1 }}>
        <AutoAwesomeIcon sx={{ color: '#7DD3FC' }} />
        <Typography variant="h4">Skills Catalog</Typography>
      </Box>
      <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 3 }}>
        <Typography variant="body2" color="text.secondary">
          {catalogLocalRefreshedAt
            ? `Last updated ${formatRelativeTime(catalogLocalRefreshedAt)}`
            : 'Refresh status unknown'}
        </Typography>
        <Tooltip title="Refresh catalog">
          <IconButton size="small" onClick={() => fetchCatalog()}>
            <RefreshIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        {catalogUpstreamRefreshedAt && (
          <Typography variant="caption" color="text.secondary">
            (upstream: {formatRelativeTime(catalogUpstreamRefreshedAt)})
          </Typography>
        )}
      </Stack>

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

        <FormControl sx={{ minWidth: 200 }}>
          <InputLabel id="skills-sort-label">Sort</InputLabel>
          <Select
            labelId="skills-sort-label"
            value={sortBy}
            label="Sort"
            onChange={(event) => setSortBy(event.target.value)}
          >
            <MenuItem value="default">Name</MenuItem>
            <MenuItem value="stars">Most stars</MenuItem>
            <MenuItem value="rating">Highest rated</MenuItem>
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
        <Tabs value={activeTab} onChange={(_event, value: string) => setActiveTab(value)}>
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
                {group.items.map((item) => {
                  const skillId = item.id || item.name || '';
                  const summary = ratingSummaries[skillId];
                  return (
                    <Card
                      key={item.id || item.name}
                      sx={{
                        cursor: 'pointer',
                        transition: 'all 0.2s',
                        '&:hover': { boxShadow: 4, transform: 'translateY(-2px)' },
                      }}
                      onClick={() => openDetailDialog(item)}
                    >
                      <CardContent>
                        <Typography variant="h6">{item.name}</Typography>
                        <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                          {item.description || 'No description'}
                        </Typography>
                        <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}>
                          <Rating
                            value={summary?.avg || 0}
                            precision={0.5}
                            size="small"
                            readOnly
                          />
                          <Typography variant="caption" color="text.secondary">
                            {summary && summary.count > 0
                              ? `${summary.avg.toFixed(1)} (${summary.count} review${summary.count === 1 ? '' : 's'})`
                              : 'No reviews yet'}
                          </Typography>
                        </Stack>
                        {Number.isFinite(item.stars) && (item.stars ?? -1) >= 0 && (
                          <Chip
                            size="small"
                            label={`★ ${item.stars!.toLocaleString()}`}
                            sx={{ mb: 1 }}
                          />
                        )}
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
                            label={`License: ${getLicenseLabel(item)}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              openLicenseDialog(item);
                            }}
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
                      <CardActions sx={{ justifyContent: 'space-between' }} onClick={(e) => e.stopPropagation()}>
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
                          {isImported(item.name) ? 'Imported' : item.type === 'plugin' ? 'Plugin' : 'Import'}
                        </Button>
                      </CardActions>
                    </Card>
                  );
                })}
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
          {selectedPodId &&
            installedItems.map((item) => (
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
                  <Button size="small" color="error" onClick={() => handleUninstall(item.name)}>
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
              These credentials apply to all agents running on this host gateway. Store only what
              you intend to share across agents.
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
                  {gatewayPrimaryEnv && (
                    <Box sx={{ mt: 2 }}>
                      <Typography variant="subtitle2">Primary API key</Typography>
                      <TextField
                        fullWidth
                        type="password"
                        label={`${gatewayPrimaryEnv}`}
                        placeholder="Stored directly under the skill entry"
                        value={gatewayApiKeyInput}
                        onChange={(event) => {
                          setGatewayApiKeyInput(event.target.value);
                          if (event.target.value) {
                            setGatewayApiKeyClear(false);
                          }
                        }}
                        sx={{ mt: 1 }}
                      />
                      <Typography
                        variant="caption"
                        color="text.secondary"
                        sx={{ display: 'block', mt: 1 }}
                      >
                        {`This value is saved to \`skills.entries.${normalizeSkillKey(gatewaySkillKey)}.${gatewayPrimaryEnv}\`.`}
                      </Typography>
                      <Typography
                        variant="caption"
                        color="text.secondary"
                        sx={{ display: 'block', mt: 0.5 }}
                      >
                        Use the Advanced JSON option to store keys directly under the skill entry.
                      </Typography>
                      <Box
                        component="pre"
                        sx={{
                          mt: 1,
                          mb: 0,
                          p: 1.5,
                          borderRadius: 1,
                          bgcolor: 'action.hover',
                          fontSize: '0.75rem',
                          overflowX: 'auto',
                        }}
                      >
                        {`skills:\n  entries:\n    ${normalizeSkillKey(gatewaySkillKey) || '<skill>'}:\n      apiKey: ${gatewayPrimaryEnv}`}
                      </Box>
                    </Box>
                  )}
                </Box>
                <Box>
                  <Typography variant="subtitle2">Existing keys</Typography>
                  <Stack spacing={1} sx={{ mt: 1 }}>
                    {(gatewayEntries[normalizeSkillKey(gatewaySkillKey)]?.envKeys || []).length ===
                      0 &&
                      !gatewayEntries[normalizeSkillKey(gatewaySkillKey)]?.apiKeyPresent && (
                        <Typography variant="body2" color="text.secondary">
                          No keys stored for this skill yet.
                        </Typography>
                      )}
                    {(gatewayEntries[normalizeSkillKey(gatewaySkillKey)]?.envKeys || []).map(
                      (key) => (
                        <Box key={key} sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
                          <Typography variant="body2">{key}</Typography>
                          <Chip size="small" label="set" />
                          <Button size="small" onClick={() => markGatewayClear(key)}>
                            Clear
                          </Button>
                        </Box>
                      ),
                    )}
                    {gatewayEntries[normalizeSkillKey(gatewaySkillKey)]?.apiKeyPresent && (
                      <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
                        <Typography variant="body2">apiKey</Typography>
                        <Chip size="small" label="set" />
                        <Button size="small" onClick={markGatewayApiKeyClear}>
                          Clear
                        </Button>
                      </Box>
                    )}
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
                <Box>
                  <FormControlLabel
                    control={
                      <Switch
                        checked={gatewayAdvancedOpen}
                        onChange={(event) => setGatewayAdvancedOpen(event.target.checked)}
                      />
                    }
                    label="Advanced JSON entry"
                  />
                  {gatewayAdvancedOpen && (
                    <Box sx={{ mt: 1 }}>
                      <TextField
                        fullWidth
                        multiline
                        minRows={4}
                        label="Custom entry JSON"
                        placeholder={`{\n  "${gatewayPrimaryEnv || 'TAVILY_API_KEY'}": "${gatewayPrimaryEnv ? '...' : '...'}"\n}`}
                        value={gatewayAdvancedJson}
                        onChange={(event) => setGatewayAdvancedJson(event.target.value)}
                      />
                      <Typography
                        variant="caption"
                        color="text.secondary"
                        sx={{ display: 'block', mt: 1 }}
                      >
                        {`This replaces the fields above and is saved as \`skills.entries.${normalizeSkillKey(gatewaySkillKey)}\`.`}
                      </Typography>
                    </Box>
                  )}
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
              onChange={(event) =>
                setImportState((prev) => ({ ...prev, podId: event.target.value }))
              }
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
              onChange={(event) =>
                setImportState((prev) => ({ ...prev, scope: event.target.value }))
              }
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
                onChange={(event) =>
                  setImportState((prev) => ({ ...prev, agentKey: event.target.value }))
                }
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
            onChange={(event) =>
              setImportState((prev) => ({ ...prev, name: event.target.value }))
            }
            fullWidth
          />
          <TextField
            label="Description"
            value={importState.description}
            onChange={(event) =>
              setImportState((prev) => ({ ...prev, description: event.target.value }))
            }
            fullWidth
          />
          <TextField
            label="Tags (comma separated)"
            value={importState.tags}
            onChange={(event) =>
              setImportState((prev) => ({ ...prev, tags: event.target.value }))
            }
            fullWidth
          />
          <TextField
            label="Source URL"
            value={importState.sourceUrl}
            onChange={(event) =>
              setImportState((prev) => ({ ...prev, sourceUrl: event.target.value }))
            }
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
            onChange={(event) =>
              setImportState((prev) => ({ ...prev, license: event.target.value }))
            }
            fullWidth
            helperText={
              importState.license
                ? 'License info from the catalog (editable).'
                : 'No license info available.'
            }
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={closeImportDialog}>Cancel</Button>
          <Button
            variant="contained"
            onClick={handleImport}
            disabled={!importState.podId || !importState.name || !importState.sourceUrl}
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
            onChange={(event) =>
              setGatewayForm((prev) => ({ ...prev, name: event.target.value }))
            }
            fullWidth
          />
          <TextField
            label="Slug (optional)"
            value={gatewayForm.slug}
            onChange={(event) =>
              setGatewayForm((prev) => ({ ...prev, slug: event.target.value }))
            }
            fullWidth
          />
          <FormControl fullWidth>
            <InputLabel id="gateway-mode-label">Mode</InputLabel>
            <Select
              labelId="gateway-mode-label"
              label="Mode"
              value={gatewayForm.mode}
              onChange={(event) =>
                setGatewayForm((prev) => ({ ...prev, mode: event.target.value }))
              }
            >
              <MenuItem value="local">Local (host-managed)</MenuItem>
              <MenuItem value="remote">Remote</MenuItem>
              <MenuItem value="k8s">Kubernetes</MenuItem>
            </Select>
          </FormControl>
          <TextField
            label="Base URL (optional)"
            value={gatewayForm.baseUrl}
            onChange={(event) =>
              setGatewayForm((prev) => ({ ...prev, baseUrl: event.target.value }))
            }
            fullWidth
          />
          <TextField
            label="Config path (local gateway)"
            value={gatewayForm.configPath}
            onChange={(event) =>
              setGatewayForm((prev) => ({ ...prev, configPath: event.target.value }))
            }
            fullWidth
          />
          <TextField
            label="K8s namespace"
            value={gatewayForm.namespace}
            onChange={(event) =>
              setGatewayForm((prev) => ({ ...prev, namespace: event.target.value }))
            }
            fullWidth
          />
          <TextField
            label="Gateway image (placeholder)"
            value={gatewayForm.image}
            onChange={(event) =>
              setGatewayForm((prev) => ({ ...prev, image: event.target.value }))
            }
            fullWidth
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={closeGatewayDialog}>Cancel</Button>
          <Button
            variant="contained"
            onClick={handleCreateGateway}
            disabled={gatewayCreateLoading}
          >
            {gatewayCreateLoading ? 'Creating...' : 'Create'}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={!!detailItem} onClose={closeDetailDialog} fullWidth maxWidth="md">
        <DialogTitle>
          {detailItem?.name || 'Skill'}
          {detailItem?.category && (
            <Chip size="small" label={detailItem.category} sx={{ ml: 1 }} />
          )}
        </DialogTitle>
        <DialogContent sx={{ pt: 2 }}>
          {detailItem && (
            <Stack spacing={2}>
              <Typography variant="body2" color="text.secondary">
                {detailItem.description || 'No description'}
              </Typography>
              <Stack direction="row" spacing={2} alignItems="center" flexWrap="wrap">
                {Number.isFinite(detailItem.stars) && (detailItem.stars ?? -1) >= 0 && (
                  <Chip size="small" label={`★ ${detailItem.stars!.toLocaleString()} GitHub stars`} />
                )}
                {detailItem.sourceUrl && (
                  <Button
                    size="small"
                    href={detailItem.sourceUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    View Source
                  </Button>
                )}
              </Stack>

              <Divider />

              <Box>
                <Typography variant="h6" gutterBottom>
                  Ratings
                </Typography>
                {detailLoading && <LinearProgress />}
                {detailSummary && (
                  <Stack direction={{ xs: 'column', sm: 'row' }} spacing={3} alignItems="flex-start">
                    <Stack alignItems="center" sx={{ minWidth: 140 }}>
                      <Typography variant="h3">
                        {detailSummary.count > 0 ? detailSummary.avg.toFixed(1) : '—'}
                      </Typography>
                      <Rating
                        value={detailSummary.avg || 0}
                        precision={0.5}
                        size="small"
                        readOnly
                      />
                      <Typography variant="caption" color="text.secondary">
                        {detailSummary.count} review{detailSummary.count === 1 ? '' : 's'}
                      </Typography>
                    </Stack>
                    <Stack spacing={0.5} sx={{ flex: 1, minWidth: 200 }}>
                      {([5, 4, 3, 2, 1] as const).map((bucket) => {
                        const count = detailSummary.histogram?.[bucket] || 0;
                        const total = detailSummary.count || 1;
                        const pct = (count / total) * 100;
                        return (
                          <Stack key={bucket} direction="row" spacing={1} alignItems="center">
                            <Typography variant="caption" sx={{ width: 16 }}>
                              {bucket}
                            </Typography>
                            <LinearProgress
                              variant="determinate"
                              value={pct}
                              sx={{ flex: 1, height: 8, borderRadius: 1 }}
                            />
                            <Typography variant="caption" sx={{ width: 32, textAlign: 'right' }}>
                              {count}
                            </Typography>
                          </Stack>
                        );
                      })}
                    </Stack>
                  </Stack>
                )}
              </Box>

              <Divider />

              <Box>
                <Typography variant="subtitle1" gutterBottom>
                  Your rating
                </Typography>
                <Stack direction="row" spacing={2} alignItems="center" sx={{ mb: 1 }}>
                  <Rating
                    value={myRating}
                    onChange={(_event, value) => setMyRating(value || 0)}
                    size="large"
                  />
                  {detailSummary?.mine && (
                    <Typography variant="caption" color="text.secondary">
                      (you rated this before — update to replace)
                    </Typography>
                  )}
                </Stack>
                <TextField
                  fullWidth
                  multiline
                  minRows={2}
                  maxRows={6}
                  placeholder="Optional comment (max 2000 chars)"
                  value={myComment}
                  onChange={(event) => setMyComment(event.target.value.slice(0, 2000))}
                  inputProps={{ maxLength: 2000 }}
                  sx={{ mb: 1 }}
                />
                <Stack direction="row" spacing={1}>
                  <Button
                    variant="contained"
                    disabled={!myRating || mySubmitting}
                    onClick={submitMyRating}
                  >
                    {mySubmitting ? 'Saving...' : 'Submit'}
                  </Button>
                  {detailSummary?.mine && (
                    <Button
                      variant="text"
                      color="error"
                      startIcon={<DeleteOutlineIcon />}
                      onClick={deleteMyRating}
                      disabled={mySubmitting}
                    >
                      Delete my rating
                    </Button>
                  )}
                </Stack>
              </Box>

              <Divider />

              <Box>
                <Typography variant="subtitle1" gutterBottom>
                  Community reviews
                </Typography>
                {detailRatings.length === 0 && !detailLoading && (
                  <Typography variant="body2" color="text.secondary">
                    No reviews yet. Be the first.
                  </Typography>
                )}
                <List dense>
                  {detailRatings.map((record) => (
                    <ListItem key={record._id} alignItems="flex-start" disableGutters>
                      <ListItemAvatar>
                        <Avatar>{(record.user?.username || '?').slice(0, 1).toUpperCase()}</Avatar>
                      </ListItemAvatar>
                      <ListItemText
                        primary={
                          <Stack direction="row" spacing={1} alignItems="center">
                            <Typography variant="subtitle2">
                              {record.user?.username || 'unknown'}
                            </Typography>
                            <Rating value={record.rating} size="small" readOnly />
                            <Typography variant="caption" color="text.secondary">
                              {formatRelativeTime(record.createdAt)}
                            </Typography>
                          </Stack>
                        }
                        secondary={record.comment || <em>(no comment)</em>}
                      />
                    </ListItem>
                  ))}
                </List>
              </Box>
            </Stack>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={closeDetailDialog}>Close</Button>
          {detailItem && (
            <Button
              variant="contained"
              disabled={!selectedPodId || detailItem.type === 'plugin' || isImported(detailItem.name)}
              onClick={() => {
                openImportDialog(detailItem);
                closeDetailDialog();
              }}
            >
              {isImported(detailItem.name) ? 'Imported' : detailItem.type === 'plugin' ? 'Plugin' : 'Import to pod'}
            </Button>
          )}
        </DialogActions>
      </Dialog>
    </Container>
  );
};

export default SkillsCatalogPage;
