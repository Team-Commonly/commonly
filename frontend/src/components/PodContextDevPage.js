import React, { useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import ReactMarkdown from 'react-markdown';
import './PodContextDevPage.css';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  CircularProgress,
  Checkbox,
  Container,
  FormControlLabel,
  FormGroup,
  Grid,
  MenuItem,
  Stack,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import PsychologyIcon from '@mui/icons-material/Psychology';
import RefreshIcon from '@mui/icons-material/Refresh';
import { useAuth } from '../context/AuthContext';

function formatDate(value) {
  if (!value) return 'Unknown time';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Unknown time';
  return date.toLocaleString();
}

const PodContextDevPage = () => {
  const { token } = useAuth();
  const [pods, setPods] = useState([]);
  const [podId, setPodId] = useState('');
  const [task, setTask] = useState('');
  const [summaryLimit, setSummaryLimit] = useState('6');
  const [assetLimit, setAssetLimit] = useState('12');
  const [tagLimit, setTagLimit] = useState('16');
  const [skillLimit, setSkillLimit] = useState('6');
  const [skillMode, setSkillMode] = useState('llm');
  const [skillRefreshHours, setSkillRefreshHours] = useState('6');
  const [showSummaryContent, setShowSummaryContent] = useState(false);
  const [showSummaryAssets, setShowSummaryAssets] = useState(false);
  const [assetScopeFilter, setAssetScopeFilter] = useState('shared');
  const [groupAssetsByType, setGroupAssetsByType] = useState(true);
  const [context, setContext] = useState(null);
  const [loadingPods, setLoadingPods] = useState(true);
  const [loadingContext, setLoadingContext] = useState(false);
  const [memoryQuery, setMemoryQuery] = useState('');
  const [memoryLimit, setMemoryLimit] = useState('8');
  const [memoryIncludeSkills, setMemoryIncludeSkills] = useState(false);
  const [memoryTypes, setMemoryTypes] = useState([]);
  const [autoLoadExcerpt, setAutoLoadExcerpt] = useState(true);
  const [memoryResults, setMemoryResults] = useState([]);
  const [memoryLoading, setMemoryLoading] = useState(false);
  const [memoryError, setMemoryError] = useState(null);
  const [excerptAssetId, setExcerptAssetId] = useState('');
  const [excerptFrom, setExcerptFrom] = useState('1');
  const [excerptLines, setExcerptLines] = useState('12');
  const [excerptData, setExcerptData] = useState(null);
  const [excerptLoading, setExcerptLoading] = useState(false);
  const [excerptError, setExcerptError] = useState(null);
  const [indexStats, setIndexStats] = useState(null);
  const [indexStatsLoading, setIndexStatsLoading] = useState(false);
  const [indexStatsError, setIndexStatsError] = useState(null);
  const [indexRebuildLoading, setIndexRebuildLoading] = useState(false);
  const [indexRebuildError, setIndexRebuildError] = useState(null);
  const [indexRebuildSuccess, setIndexRebuildSuccess] = useState(null);
  const [indexRebuildAllLoading, setIndexRebuildAllLoading] = useState(false);
  const [indexRebuildAllError, setIndexRebuildAllError] = useState(null);
  const [indexRebuildAllSuccess, setIndexRebuildAllSuccess] = useState(null);
  const [error, setError] = useState(null);

  const authHeaders = useMemo(() => (
    token ? { Authorization: `Bearer ${token}` } : {}
  ), [token]);

  const memoryTypeOptions = useMemo(() => ([
    { value: 'summary', label: 'Summary Assets' },
    { value: 'integration-summary', label: 'Integration Assets' },
    { value: 'memory', label: 'Memory' },
    { value: 'daily-log', label: 'Daily Logs' },
    { value: 'skill', label: 'Skills' },
    { value: 'message', label: 'Messages' },
    { value: 'thread', label: 'Threads' },
    { value: 'file', label: 'Files' },
    { value: 'doc', label: 'Docs' },
    { value: 'link', label: 'Links' },
  ]), []);

  const summaryAssetTypes = useMemo(() => new Set(['summary', 'integration-summary']), []);
  const summaryAssets = useMemo(
    () => (context?.assets || []).filter((asset) => summaryAssetTypes.has(asset.type)),
    [context, summaryAssetTypes],
  );
  const nonSummaryAssets = useMemo(
    () => (context?.assets || []).filter((asset) => !summaryAssetTypes.has(asset.type)),
    [context, summaryAssetTypes],
  );

  const scopeFilterLabel = useMemo(() => ({
    all: 'All scopes',
    shared: 'Shared (pod)',
    agent: 'Agent-only',
  }), []);

  const filterAssetsByScope = (assets) => {
    if (!Array.isArray(assets)) return [];
    if (assetScopeFilter === 'all') return assets;
    if (assetScopeFilter === 'agent') {
      return assets.filter((asset) => asset?.metadata?.scope === 'agent');
    }
    return assets.filter((asset) => asset?.metadata?.scope !== 'agent');
  };

  const filteredNonSummaryAssets = useMemo(
    () => filterAssetsByScope(nonSummaryAssets),
    [nonSummaryAssets, assetScopeFilter],
  );

  const filteredSummaryAssets = useMemo(
    () => filterAssetsByScope(summaryAssets),
    [summaryAssets, assetScopeFilter],
  );

  const typeLabels = useMemo(() => ({
    summary: 'Summary',
    'integration-summary': 'Integration Summary',
    memory: 'Memory',
    'daily-log': 'Daily Log',
    message: 'Message',
    thread: 'Thread',
    file: 'File',
    doc: 'Doc',
    link: 'Link',
    skill: 'Skill',
  }), []);

  const groupAssets = (assets) => {
    if (!groupAssetsByType) return [{ type: 'all', items: assets }];
    const groups = new Map();
    assets.forEach((asset) => {
      const type = asset?.type || 'unknown';
      if (!groups.has(type)) groups.set(type, []);
      groups.get(type).push(asset);
    });
    return Array.from(groups.entries())
      .map(([type, items]) => ({ type, items }))
      .sort((a, b) => b.items.length - a.items.length || a.type.localeCompare(b.type));
  };

  const groupedNonSummaryAssets = useMemo(
    () => groupAssets(filteredNonSummaryAssets),
    [filteredNonSummaryAssets, groupAssetsByType],
  );

  const groupedSummaryAssets = useMemo(
    () => groupAssets(filteredSummaryAssets),
    [filteredSummaryAssets, groupAssetsByType],
  );

  useEffect(() => {
    const fetchPods = async () => {
      if (!token) {
        setPods([]);
        setPodId('');
        setLoadingPods(false);
        return;
      }

      try {
        setLoadingPods(true);
        const res = await axios.get('/api/pods', { headers: authHeaders });
        const podList = res.data || [];
        setPods(podList);
        setPodId((prev) => prev || podList[0]?._id || '');
        setError(null);
      } catch (err) {
        console.error('Failed to load pods for context inspector:', err);
        setError('Failed to load pods.');
      } finally {
        setLoadingPods(false);
      }
    };

    fetchPods();
  }, [authHeaders, token]);

  const handleFetchContext = async () => {
    if (!podId || !token) return;

    try {
      setLoadingContext(true);
      const res = await axios.get(`/api/pods/${podId}/context`, {
        headers: authHeaders,
        params: {
          task: task || undefined,
          summaryLimit: summaryLimit || undefined,
          assetLimit: assetLimit || undefined,
          tagLimit: tagLimit || undefined,
          skillLimit: skillLimit || undefined,
          skillMode: skillMode || undefined,
          skillRefreshHours: skillRefreshHours || undefined,
        },
      });
      setContext(res.data);
      setError(null);
    } catch (err) {
      console.error('Failed to fetch pod context:', err);
      setError(err.response?.data?.message || 'Failed to fetch pod context.');
    } finally {
      setLoadingContext(false);
    }
  };

  const handleFetchIndexStats = async () => {
    if (!podId || !token) return;
    try {
      setIndexStatsLoading(true);
      const res = await axios.get(`/api/v1/pods/${podId}/index/stats`, { headers: authHeaders });
      setIndexStats(res.data);
      setIndexStatsError(null);
    } catch (err) {
      console.error('Failed to fetch index stats:', err);
      setIndexStatsError(err.response?.data?.error || 'Failed to fetch index stats.');
    } finally {
      setIndexStatsLoading(false);
    }
  };

  const handleRebuildIndex = async (reset = false) => {
    if (!podId || !token) return;
    try {
      setIndexRebuildLoading(true);
      setIndexRebuildSuccess(null);
      const res = await axios.post(
        `/api/v1/pods/${podId}/index/rebuild`,
        { reset },
        { headers: authHeaders },
      );
      setIndexRebuildSuccess(res.data);
      setIndexRebuildError(null);
      await handleFetchIndexStats();
    } catch (err) {
      console.error('Failed to rebuild index:', err);
      setIndexRebuildError(err.response?.data?.error || 'Failed to rebuild index.');
    } finally {
      setIndexRebuildLoading(false);
    }
  };

  const handleRebuildAllIndices = async (reset = false) => {
    if (!token) return;
    try {
      setIndexRebuildAllLoading(true);
      setIndexRebuildAllSuccess(null);
      const res = await axios.post(
        '/api/v1/index/rebuild-all',
        { reset },
        { headers: authHeaders },
      );
      setIndexRebuildAllSuccess(res.data);
      setIndexRebuildAllError(null);
      if (podId) {
        await handleFetchIndexStats();
      }
    } catch (err) {
      console.error('Failed to rebuild all indices:', err);
      setIndexRebuildAllError(err.response?.data?.error || 'Failed to rebuild all indices.');
    } finally {
      setIndexRebuildAllLoading(false);
    }
  };

  const handleSearchMemory = async () => {
    if (!podId || !token || !memoryQuery.trim()) return;

    try {
      setMemoryLoading(true);
      const res = await axios.get(`/api/pods/${podId}/context/search`, {
        headers: authHeaders,
        params: {
          query: memoryQuery,
          limit: memoryLimit || undefined,
          includeSkills: memoryIncludeSkills ? 'true' : undefined,
          types: memoryTypes.length ? memoryTypes.join(',') : undefined,
        },
      });
      setMemoryResults(res.data?.results || []);
      setMemoryError(null);
    } catch (err) {
      console.error('Failed to search pod memory:', err);
      setMemoryError(err.response?.data?.message || 'Failed to search pod memory.');
    } finally {
      setMemoryLoading(false);
    }
  };

  const handleFetchExcerpt = async (assetId) => {
    if (!podId || !token || !assetId) return;

    try {
      setExcerptLoading(true);
      setExcerptAssetId(assetId);
      const res = await axios.get(`/api/pods/${podId}/context/assets/${assetId}`, {
        headers: authHeaders,
        params: {
          from: excerptFrom || undefined,
          lines: excerptLines || undefined,
        },
      });
      setExcerptData(res.data);
      setExcerptError(null);
    } catch (err) {
      console.error('Failed to fetch pod memory excerpt:', err);
      setExcerptError(err.response?.data?.message || 'Failed to fetch asset excerpt.');
    } finally {
      setExcerptLoading(false);
    }
  };

  const handleSelectResult = (assetId) => {
    setExcerptAssetId(assetId);
    if (autoLoadExcerpt) {
      handleFetchExcerpt(assetId);
    }
  };

  const toggleMemoryType = (value) => {
    setMemoryTypes((prev) => (
      prev.includes(value)
        ? prev.filter((entry) => entry !== value)
        : [...prev, value]
    ));
  };

  const hasContext = Boolean(context?.pod);

  return (
    <Box className="pod-context-dev-root">
      <Container maxWidth="lg" className="pod-context-dev-container">
        <Box className="pod-context-hero">
          <Box className="pod-context-hero-main">
            <Stack direction="row" spacing={1.5} alignItems="center">
              <PsychologyIcon className="pod-context-hero-icon" />
              <Typography variant="h4" className="pod-context-hero-title">
                Pod Context Inspector
              </Typography>
            </Stack>
            <Typography variant="body1" className="pod-context-hero-subtitle">
              Inspect the structured context that pods expose to agents, including LLM-generated markdown skills.
            </Typography>
          </Box>
          <Box className="pod-context-hero-tags">
            <Chip size="small" label="Memory Search" />
            <Chip size="small" label="Vector Index" />
            <Chip size="small" label="LLM Skills" />
          </Box>
        </Box>

        {!token && (
          <Alert severity="warning" sx={{ mb: 3 }}>
            You need to be logged in as an admin to use this tool.
          </Alert>
        )}

        {token && (
          <Card variant="outlined" className="pod-context-card" sx={{ mb: 3 }}>
            <CardContent>
              <Stack spacing={2}>
                <Grid container spacing={2}>
                  <Grid item xs={12} md={6}>
                    <TextField
                      select
                      fullWidth
                      label="Pod"
                      value={podId}
                      onChange={(event) => setPodId(event.target.value)}
                      disabled={loadingPods || !pods.length}
                      helperText={pods.length ? 'Select a pod to inspect.' : 'No pods available.'}
                    >
                      {pods.map((pod) => (
                        <MenuItem key={pod._id} value={pod._id}>
                          {pod.name}
                        </MenuItem>
                      ))}
                    </TextField>
                  </Grid>
                  <Grid item xs={12} md={6}>
                    <TextField
                      fullWidth
                      label="Task (optional)"
                      value={task}
                      onChange={(event) => setTask(event.target.value)}
                      placeholder="e.g. incident runbook checklist"
                    />
                  </Grid>
                </Grid>

              <Grid container spacing={2}>
                <Grid item xs={12} sm={6} md={3}>
                  <TextField
                    fullWidth
                    label="Summary Limit"
                    value={summaryLimit}
                    onChange={(event) => setSummaryLimit(event.target.value)}
                    type="number"
                    inputProps={{ min: 1, max: 20 }}
                  />
                </Grid>
                <Grid item xs={12} sm={6} md={3}>
                  <TextField
                    fullWidth
                    label="Asset Limit"
                    value={assetLimit}
                    onChange={(event) => setAssetLimit(event.target.value)}
                    type="number"
                    inputProps={{ min: 1, max: 40 }}
                  />
                </Grid>
                <Grid item xs={12} sm={6} md={3}>
                  <TextField
                    fullWidth
                    label="Tag Limit"
                    value={tagLimit}
                    onChange={(event) => setTagLimit(event.target.value)}
                    type="number"
                    inputProps={{ min: 1, max: 40 }}
                  />
                </Grid>
                <Grid item xs={12} sm={6} md={3}>
                  <TextField
                    fullWidth
                    label="Skill Limit"
                    value={skillLimit}
                    onChange={(event) => setSkillLimit(event.target.value)}
                    type="number"
                    inputProps={{ min: 1, max: 12 }}
                  />
                </Grid>
              </Grid>

              <Grid container spacing={2}>
                <Grid item xs={12} md={6}>
                  <TextField
                    select
                    fullWidth
                    label="Skill Mode"
                    value={skillMode}
                    onChange={(event) => setSkillMode(event.target.value)}
                    helperText="LLM mode generates markdown skill docs and stores them as pod assets."
                  >
                    <MenuItem value="llm">LLM (Gemini)</MenuItem>
                    <MenuItem value="heuristic">Heuristic (fallback)</MenuItem>
                    <MenuItem value="none">Disabled</MenuItem>
                  </TextField>
                </Grid>
                <Grid item xs={12} md={3}>
                  <TextField
                    fullWidth
                    label="Skill Refresh Hours"
                    value={skillRefreshHours}
                    onChange={(event) => setSkillRefreshHours(event.target.value)}
                    type="number"
                    inputProps={{ min: 1, max: 72 }}
                    helperText="LLM skills refresh when stale or when a task is provided."
                  />
                </Grid>
                <Grid item xs={12} md={3}>
                  <TextField
                    select
                    fullWidth
                    label="Asset Scope"
                    value={assetScopeFilter}
                    onChange={(event) => setAssetScopeFilter(event.target.value)}
                    helperText={scopeFilterLabel[assetScopeFilter] || 'Scope filter'}
                  >
                    <MenuItem value="shared">Shared (pod)</MenuItem>
                    <MenuItem value="agent">Agent-only</MenuItem>
                    <MenuItem value="all">All scopes</MenuItem>
                  </TextField>
                </Grid>
              </Grid>

              <FormControlLabel
                control={(
                  <Switch
                    checked={showSummaryContent}
                    onChange={(event) => setShowSummaryContent(event.target.checked)}
                  />
                )}
                label="Show Summary Content (Markdown)"
              />
              <FormControlLabel
                control={(
                  <Switch
                    checked={showSummaryAssets}
                    onChange={(event) => setShowSummaryAssets(event.target.checked)}
                  />
                )}
                label="Show Summary Assets (pod assets)"
              />
              <FormControlLabel
                control={(
                  <Switch
                    checked={groupAssetsByType}
                    onChange={(event) => setGroupAssetsByType(event.target.checked)}
                  />
                )}
                label="Group assets by type"
              />

              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                <Button
                  variant="contained"
                  onClick={handleFetchContext}
                  disabled={!podId || loadingPods || loadingContext}
                  startIcon={loadingContext ? <CircularProgress size={16} /> : <RefreshIcon />}
                >
                  Fetch Context
                </Button>
                {loadingPods && (
                  <Typography variant="body2" color="text.secondary">
                    Loading pods...
                  </Typography>
                )}
              </Box>
            </Stack>
          </CardContent>
        </Card>
      )}

      {error && (
        <Alert severity="error" sx={{ mb: 3 }}>
          {error}
        </Alert>
      )}

      {hasContext && (
        <Stack spacing={3} className="pod-context-sections">
          <Card variant="outlined" className="pod-context-card">
            <CardContent>
              <Stack spacing={1.5}>
                <Typography variant="h6" sx={{ fontWeight: 700 }}>
                  {context.pod.name}
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  {context.pod.description || 'No description provided.'}
                </Typography>
                <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                  <Chip label={`Summaries: ${context.stats?.summaries ?? 0}`} />
                  <Chip label={`Assets: ${context.stats?.assets ?? 0}`} />
                  <Chip label={`Assets (non-summary): ${filteredNonSummaryAssets.length}`} variant="outlined" />
                  <Chip label={`Summary Assets: ${filteredSummaryAssets.length}`} variant="outlined" />
                  <Chip label={`Tags: ${context.stats?.tags ?? 0}`} />
                  <Chip label={`Skills: ${context.stats?.skills ?? 0}`} />
                  {context.skillModeUsed && (
                    <Chip label={`Skill Mode: ${context.skillModeUsed}`} variant="outlined" />
                  )}
                </Stack>
                {context.task && (
                  <Typography variant="body2" color="text.secondary">
                    Task: {context.task}
                  </Typography>
                )}
                {!!context.skillWarnings?.length && (
                  <Alert severity="warning">
                    {context.skillWarnings.join(' ')}
                  </Alert>
                )}
              </Stack>
            </CardContent>
          </Card>

          <Card variant="outlined" className="pod-context-card">
            <CardContent>
              <Typography variant="subtitle1" sx={{ fontWeight: 700, mb: 1 }}>
                Skills (LLM Markdown)
              </Typography>
              <Stack spacing={1.5}>
                {(context.skills || []).map((skill) => (
                  <Box key={skill._id || skill.id}>
                    <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
                      <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
                        {skill.title || skill.metadata?.skillName || 'Skill'}
                      </Typography>
                      {typeof (skill.metadata?.score || skill.score) === 'number' && (
                        <Typography variant="caption" color="text.secondary">
                          score {skill.metadata?.score ?? skill.score}
                        </Typography>
                      )}
                    </Stack>

                    {!!(skill.tags || skill.metadata?.tags)?.length && (
                      <Stack
                        direction="row"
                        spacing={0.5}
                        flexWrap="wrap"
                        useFlexGap
                        sx={{ mt: 0.5 }}
                      >
                        {(skill.tags || skill.metadata?.tags || []).map((tag) => (
                          <Chip key={`${skill._id || skill.id}-${tag}`} label={tag} size="small" />
                        ))}
                      </Stack>
                    )}

                    {(skill.content || skill.metadata?.markdown) ? (
                      <Box
                        className="pod-context-markdown"
                        sx={{
                          mt: 1,
                          p: 1.25,
                          borderRadius: 1.5,
                          border: (theme) => `1px solid ${theme.palette.divider}`,
                          backgroundColor: (theme) => theme.palette.background.default,
                        }}
                      >
                        <ReactMarkdown>{skill.content || skill.metadata?.markdown}</ReactMarkdown>
                      </Box>
                    ) : (
                      <Typography variant="body2" color="text.secondary" sx={{ mt: 0.75 }}>
                        No markdown content available for this skill.
                      </Typography>
                    )}
                  </Box>
                ))}
                {!(context.skills || []).length && (
                  <Typography variant="body2" color="text.secondary">
                    No skills generated yet. Use Skill Mode = LLM and click Fetch Context.
                  </Typography>
                )}
              </Stack>
            </CardContent>
          </Card>

          <Card variant="outlined" className="pod-context-card">
            <CardContent>
              <Typography variant="subtitle1" sx={{ fontWeight: 700, mb: 1 }}>
                Top Tags
              </Typography>
              <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                {(context.tags || []).map((tagEntry) => (
                  <Chip key={tagEntry.tag} label={`${tagEntry.tag} (${tagEntry.count})`} />
                ))}
                {!(context.tags || []).length && (
                  <Typography variant="body2" color="text.secondary">
                    No tags available yet.
                  </Typography>
                )}
              </Stack>
            </CardContent>
          </Card>

          <Card variant="outlined" className="pod-context-card">
            <CardContent>
              <Stack spacing={2}>
                <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
                  Vector Index
                </Typography>
                <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                  <Button
                    variant="outlined"
                    onClick={handleFetchIndexStats}
                    disabled={indexStatsLoading || !podId}
                    startIcon={indexStatsLoading ? <CircularProgress size={16} /> : <RefreshIcon />}
                  >
                    Fetch Stats
                  </Button>
                  <Button
                    variant="contained"
                    color="warning"
                    onClick={() => handleRebuildIndex(false)}
                    disabled={indexRebuildLoading || !podId}
                  >
                    Rebuild Index
                  </Button>
                  <Button
                    variant="contained"
                    color="error"
                    onClick={() => handleRebuildIndex(true)}
                    disabled={indexRebuildLoading || !podId}
                  >
                    Reset + Rebuild
                  </Button>
                  <Button
                    variant="contained"
                    color="secondary"
                    onClick={() => handleRebuildAllIndices(true)}
                    disabled={indexRebuildAllLoading}
                  >
                    Reset + Rebuild All Pods
                  </Button>
                  {indexRebuildLoading && (
                    <Stack direction="row" spacing={1} alignItems="center">
                      <CircularProgress size={16} />
                      <Typography variant="body2" color="text.secondary">
                        Rebuilding...
                      </Typography>
                    </Stack>
                  )}
                  {indexRebuildAllLoading && (
                    <Stack direction="row" spacing={1} alignItems="center">
                      <CircularProgress size={16} />
                      <Typography variant="body2" color="text.secondary">
                        Rebuilding all pods...
                      </Typography>
                    </Stack>
                  )}
                </Stack>
                {indexStatsError && <Alert severity="error">{indexStatsError}</Alert>}
                {indexRebuildError && <Alert severity="error">{indexRebuildError}</Alert>}
                {indexRebuildAllError && <Alert severity="error">{indexRebuildAllError}</Alert>}
                {indexRebuildSuccess && (
                  <Alert severity="success">
                    Rebuilt index: {indexRebuildSuccess.indexed} indexed, {indexRebuildSuccess.errors} errors.
                  </Alert>
                )}
                {indexRebuildAllSuccess && (
                  <Alert severity="success">
                    Rebuilt {indexRebuildAllSuccess.pods} pods: {indexRebuildAllSuccess.indexed} indexed, {indexRebuildAllSuccess.errors} errors.
                  </Alert>
                )}
                {indexStats?.stats && (
                  <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                    <Chip label={`Available: ${indexStats.stats.available}`} />
                    <Chip label={`Chunks: ${indexStats.stats.chunks ?? 0}`} />
                    <Chip label={`Assets: ${indexStats.stats.assets ?? 0}`} />
                    <Chip label={`Embeddings: ${indexStats.stats.embeddings ?? 0}`} />
                  </Stack>
                )}
              </Stack>
            </CardContent>
          </Card>

          <Grid container spacing={2}>
            <Grid item xs={12} md={6}>
              <Card variant="outlined" className="pod-context-card" sx={{ height: '100%' }}>
                <CardContent>
                  <Typography variant="subtitle1" sx={{ fontWeight: 700, mb: 1.5 }}>
                    Chat Summaries (Summary collection)
                  </Typography>
                  <Typography variant="caption" color="text.secondary" sx={{ mb: 1, display: 'block' }}>
                    These are the chat summary documents (separate from PodAsset memory).
                  </Typography>
                  <Stack spacing={1.5}>
                    {(context.summaries || []).map((summary) => (
                      <Box key={summary._id}>
                        <Typography variant="body1" sx={{ fontWeight: 600 }}>
                          {summary.title}
                        </Typography>
                        <Typography variant="caption" color="text.secondary">
                          {formatDate(summary.createdAt)}
                          {typeof summary.relevanceScore === 'number' && ` · score ${summary.relevanceScore}`}
                        </Typography>
                        {!!summary.tags?.length && (
                          <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap sx={{ mt: 0.5 }}>
                            {summary.tags.map((tag) => (
                              <Chip key={`${summary._id}-${tag}`} label={tag} size="small" />
                            ))}
                          </Stack>
                        )}
                        {showSummaryContent && summary.content && (
                          <Box
                            className="pod-context-markdown"
                            sx={{
                              mt: 1,
                              p: 1.25,
                              borderRadius: 1.5,
                              border: (theme) => `1px solid ${theme.palette.divider}`,
                              backgroundColor: (theme) => theme.palette.background.default,
                            }}
                          >
                            <ReactMarkdown>{summary.content}</ReactMarkdown>
                          </Box>
                        )}
                      </Box>
                    ))}
                    {!(context.summaries || []).length && (
                      <Typography variant="body2" color="text.secondary">
                        No summaries found for this pod.
                      </Typography>
                    )}
                  </Stack>
                </CardContent>
              </Card>
            </Grid>

            <Grid item xs={12} md={6}>
              <Card variant="outlined" className="pod-context-card" sx={{ height: '100%' }}>
                <CardContent>
                  <Typography variant="subtitle1" sx={{ fontWeight: 700, mb: 1.5 }}>
                    Assets (non-summary)
                  </Typography>
                  <Typography variant="caption" color="text.secondary" sx={{ mb: 1, display: 'block' }}>
                    PodAssets excluding summary/integration-summary to avoid duplication with chat summaries.
                  </Typography>
                  <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap sx={{ mb: 1 }}>
                    {groupedNonSummaryAssets
                      .filter((group) => group.type !== 'all')
                      .map((group) => (
                        <Chip
                          key={`asset-type-${group.type}`}
                          label={`${typeLabels[group.type] || group.type} (${group.items.length})`}
                          size="small"
                          variant="outlined"
                        />
                      ))}
                  </Stack>
                  <Stack spacing={1.5}>
                    {groupedNonSummaryAssets.map((group) => (
                      <Box key={`asset-group-${group.type}`}>
                        {group.type !== 'all' && (
                          <Typography variant="subtitle2" sx={{ fontWeight: 700, mb: 0.5 }}>
                            {typeLabels[group.type] || group.type} · {group.items.length}
                          </Typography>
                        )}
                        <Stack spacing={1.25}>
                          {group.items.map((asset) => (
                            <Box key={asset._id}>
                              <Typography variant="body1" sx={{ fontWeight: 600 }}>
                                {asset.title}
                              </Typography>
                              <Typography variant="caption" color="text.secondary">
                                {formatDate(asset.createdAt)}
                                {typeof asset.relevanceScore === 'number' && ` · score ${asset.relevanceScore}`}
                              </Typography>
                              <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap sx={{ mt: 0.5 }}>
                                {asset.type && (
                                  <Chip label={asset.type} size="small" variant="outlined" />
                                )}
                                {asset.metadata?.scope && (
                                  <Chip label={`scope: ${asset.metadata.scope}`} size="small" />
                                )}
                              </Stack>
                              {!!asset.tags?.length && (
                                <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap sx={{ mt: 0.5 }}>
                                  {asset.tags.map((tag) => (
                                    <Chip key={`${asset._id}-${tag}`} label={tag} size="small" />
                                  ))}
                                </Stack>
                              )}
                            </Box>
                          ))}
                        </Stack>
                      </Box>
                    ))}
                    {!filteredNonSummaryAssets.length && (
                      <Typography variant="body2" color="text.secondary">
                        No assets found for this pod.
                      </Typography>
                    )}
                  </Stack>
                </CardContent>
              </Card>
            </Grid>
          </Grid>

          {showSummaryAssets && (
            <Card variant="outlined" className="pod-context-card">
              <CardContent>
                <Typography variant="subtitle1" sx={{ fontWeight: 700, mb: 1.5 }}>
                  Summary Assets (PodAsset)
                </Typography>
                <Typography variant="caption" color="text.secondary" sx={{ mb: 1, display: 'block' }}>
                  These are summary/integration-summary PodAssets (often derived from chat summaries).
                </Typography>
                <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap sx={{ mb: 1 }}>
                  {groupedSummaryAssets
                    .filter((group) => group.type !== 'all')
                    .map((group) => (
                      <Chip
                        key={`summary-type-${group.type}`}
                        label={`${typeLabels[group.type] || group.type} (${group.items.length})`}
                        size="small"
                        variant="outlined"
                      />
                    ))}
                </Stack>
                <Stack spacing={1.5}>
                  {groupedSummaryAssets.map((group) => (
                    <Box key={`summary-group-${group.type}`}>
                      {group.type !== 'all' && (
                        <Typography variant="subtitle2" sx={{ fontWeight: 700, mb: 0.5 }}>
                          {typeLabels[group.type] || group.type} · {group.items.length}
                        </Typography>
                      )}
                      <Stack spacing={1.25}>
                        {group.items.map((asset) => (
                          <Box key={asset._id}>
                            <Typography variant="body1" sx={{ fontWeight: 600 }}>
                              {asset.title}
                            </Typography>
                            <Typography variant="caption" color="text.secondary">
                              {formatDate(asset.createdAt)}
                              {typeof asset.relevanceScore === 'number' && ` · score ${asset.relevanceScore}`}
                            </Typography>
                            <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap sx={{ mt: 0.5 }}>
                              {asset.type && (
                                <Chip label={asset.type} size="small" variant="outlined" />
                              )}
                              {asset.metadata?.scope && (
                                <Chip label={`scope: ${asset.metadata.scope}`} size="small" />
                              )}
                            </Stack>
                            {!!asset.tags?.length && (
                              <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap sx={{ mt: 0.5 }}>
                                {asset.tags.map((tag) => (
                                  <Chip key={`${asset._id}-${tag}`} label={tag} size="small" />
                                ))}
                              </Stack>
                            )}
                          </Box>
                        ))}
                      </Stack>
                    </Box>
                  ))}
                  {!filteredSummaryAssets.length && (
                    <Typography variant="body2" color="text.secondary">
                      No summary assets found for this pod.
                    </Typography>
                  )}
                </Stack>
              </CardContent>
            </Card>
          )}

          <Card variant="outlined" className="pod-context-card">
            <CardContent>
              <Stack spacing={2}>
                <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
                  Pod Memory Search
                </Typography>
                <Grid container spacing={2}>
                  <Grid item xs={12} md={6}>
                    <Stack spacing={1}>
                      <TextField
                        fullWidth
                        label="Memory Query"
                        value={memoryQuery}
                        onChange={(event) => setMemoryQuery(event.target.value)}
                        placeholder="Search pod memory..."
                      />
                      {task && (
                        <Button
                          size="small"
                          variant="text"
                          onClick={() => setMemoryQuery(task)}
                          sx={{ alignSelf: 'flex-start' }}
                        >
                          Use task as query
                        </Button>
                      )}
                    </Stack>
                  </Grid>
                  <Grid item xs={12} sm={6} md={3}>
                    <TextField
                      fullWidth
                      label="Result Limit"
                      value={memoryLimit}
                      onChange={(event) => setMemoryLimit(event.target.value)}
                      type="number"
                      inputProps={{ min: 1, max: 40 }}
                    />
                  </Grid>
                  <Grid item xs={12} sm={6} md={3}>
                    <FormGroup>
                      <Typography variant="caption" color="text.secondary" sx={{ mb: 0.5 }}>
                        Filter types
                      </Typography>
                      <Stack direction="row" flexWrap="wrap" gap={1}>
                        {memoryTypeOptions.map((option) => (
                          <FormControlLabel
                            key={option.value}
                            control={(
                              <Checkbox
                                size="small"
                                checked={memoryTypes.includes(option.value)}
                                onChange={() => toggleMemoryType(option.value)}
                              />
                            )}
                            label={option.label}
                          />
                        ))}
                      </Stack>
                    </FormGroup>
                  </Grid>
                </Grid>
                <Stack direction="row" spacing={2} flexWrap="wrap" useFlexGap>
                  <FormControlLabel
                    control={(
                      <Switch
                        checked={memoryIncludeSkills}
                        onChange={(event) => setMemoryIncludeSkills(event.target.checked)}
                      />
                    )}
                    label="Include skills in search"
                  />
                  <FormControlLabel
                    control={(
                      <Switch
                        checked={autoLoadExcerpt}
                        onChange={(event) => setAutoLoadExcerpt(event.target.checked)}
                      />
                    )}
                    label="Auto-load excerpt on select"
                  />
                </Stack>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
                  <Button
                    variant="contained"
                    onClick={handleSearchMemory}
                    disabled={!memoryQuery.trim() || memoryLoading}
                    startIcon={memoryLoading ? <CircularProgress size={16} /> : <RefreshIcon />}
                  >
                    Search Memory
                  </Button>
                  <Button
                    variant="text"
                    onClick={() => {
                      setMemoryQuery('');
                      setMemoryTypes([]);
                      setMemoryResults([]);
                      setMemoryError(null);
                    }}
                  >
                    Clear
                  </Button>
                </Box>
                {memoryError && (
                  <Alert severity="error">{memoryError}</Alert>
                )}
                <Stack spacing={1.5}>
                  {(memoryResults || []).map((result) => (
                    <Box
                      key={result.assetId}
                      className="pod-context-result-card"
                      sx={{ p: 1.25, borderRadius: 1.5, border: (theme) => `1px solid ${theme.palette.divider}` }}
                    >
                      <Stack spacing={0.5}>
                        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
                          <Typography variant="body1" sx={{ fontWeight: 600 }}>
                            {result.title}
                          </Typography>
                          {result.type && (
                            <Chip label={result.type} size="small" variant="outlined" />
                          )}
                          {typeof result.score === 'number' && (
                            <Typography variant="caption" color="text.secondary">
                              score {result.score.toFixed(2)}
                            </Typography>
                          )}
                        </Stack>
                        {!!result.tags?.length && (
                          <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
                            {result.tags.map((tag) => (
                              <Chip key={`${result.assetId}-${tag}`} label={tag} size="small" />
                            ))}
                          </Stack>
                        )}
                        {result.snippet && (
                          <Typography variant="body2" color="text.secondary">
                            {result.snippet}
                          </Typography>
                        )}
                        <Box>
                          <Button
                            size="small"
                            variant="outlined"
                            onClick={() => handleSelectResult(result.assetId)}
                          >
                            {autoLoadExcerpt ? 'Open Excerpt' : 'Select for Excerpt'}
                          </Button>
                        </Box>
                      </Stack>
                    </Box>
                  ))}
                  {memoryQuery.trim() && !memoryResults.length && !memoryLoading && (
                    <Typography variant="body2" color="text.secondary">
                      No matches yet. Try widening the query or types.
                    </Typography>
                  )}
                </Stack>
                <Card variant="outlined" className="pod-context-card pod-context-card-compact" sx={{ backgroundColor: 'background.default' }}>
                  <CardContent>
                    <Stack spacing={1}>
                      <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
                        Asset Excerpt
                      </Typography>
                      <Grid container spacing={2}>
                        <Grid item xs={6} sm={3}>
                          <TextField
                            fullWidth
                            label="From Line"
                            value={excerptFrom}
                            onChange={(event) => setExcerptFrom(event.target.value)}
                            type="number"
                            inputProps={{ min: 1, max: 10000 }}
                          />
                        </Grid>
                        <Grid item xs={6} sm={3}>
                          <TextField
                            fullWidth
                            label="Lines"
                            value={excerptLines}
                            onChange={(event) => setExcerptLines(event.target.value)}
                            type="number"
                            inputProps={{ min: 1, max: 100 }}
                          />
                        </Grid>
                        <Grid item xs={12} sm={6} sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                          <Typography variant="caption" color="text.secondary">
                            {excerptAssetId ? `Selected asset: ${excerptAssetId}` : 'Select a search result to load an excerpt.'}
                          </Typography>
                          {excerptAssetId && !excerptLoading && (
                            <Button
                              size="small"
                              variant="text"
                              onClick={() => handleFetchExcerpt(excerptAssetId)}
                            >
                              Load excerpt
                            </Button>
                          )}
                        </Grid>
                      </Grid>
                      {excerptLoading && (
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                          <CircularProgress size={18} />
                          <Typography variant="body2" color="text.secondary">
                            Loading excerpt...
                          </Typography>
                        </Box>
                      )}
                      {excerptError && <Alert severity="error">{excerptError}</Alert>}
                      {excerptData && !excerptLoading && (
                        <Stack spacing={1}>
                          <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
                            <Typography variant="body2" sx={{ fontWeight: 600 }}>
                              {excerptData.title || 'Excerpt'}
                            </Typography>
                            {excerptData.type && (
                              <Chip label={excerptData.type} size="small" variant="outlined" />
                            )}
                            {excerptData.startLine && (
                              <Typography variant="caption" color="text.secondary">
                                lines {excerptData.startLine}-{excerptData.endLine}
                              </Typography>
                            )}
                          </Stack>
                          {!!excerptData.tags?.length && (
                            <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
                              {excerptData.tags.map((tag) => (
                                <Chip key={`${excerptData.assetId}-${tag}`} label={tag} size="small" />
                              ))}
                            </Stack>
                          )}
                          <Box
                            className="pod-context-excerpt"
                            sx={{
                              mt: 1,
                              p: 1.25,
                              borderRadius: 1.5,
                              border: (theme) => `1px solid ${theme.palette.divider}`,
                              backgroundColor: (theme) => theme.palette.background.paper,
                              whiteSpace: 'pre-wrap',
                              fontFamily: 'Monaco, Consolas, "Liberation Mono", monospace',
                              fontSize: '0.85rem',
                            }}
                          >
                            {excerptData.text || 'No content available.'}
                          </Box>
                        </Stack>
                      )}
                    </Stack>
                  </CardContent>
                </Card>
              </Stack>
            </CardContent>
          </Card>
        </Stack>
      )}
      </Container>
    </Box>
  );
};

export default PodContextDevPage;
