import React, { useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import ReactMarkdown from 'react-markdown';
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
  const [error, setError] = useState(null);

  const authHeaders = useMemo(() => (
    token ? { Authorization: `Bearer ${token}` } : {}
  ), [token]);

  const memoryTypeOptions = useMemo(() => ([
    { value: 'summary', label: 'Summaries' },
    { value: 'integration-summary', label: 'Integration' },
    { value: 'skill', label: 'Skills' },
    { value: 'message', label: 'Messages' },
    { value: 'thread', label: 'Threads' },
    { value: 'file', label: 'Files' },
    { value: 'doc', label: 'Docs' },
    { value: 'link', label: 'Links' },
  ]), []);

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
    <Container maxWidth="lg" sx={{ py: 3 }}>
      <Stack direction="row" spacing={1.5} alignItems="center" sx={{ mb: 1 }}>
        <PsychologyIcon color="primary" />
        <Typography variant="h4" sx={{ fontWeight: 800 }}>
          Pod Context Inspector
        </Typography>
      </Stack>
      <Typography variant="body1" color="text.secondary" sx={{ mb: 3 }}>
        Inspect the structured context that pods expose to agents, including LLM-generated markdown skills.
      </Typography>

      {!token && (
        <Alert severity="warning" sx={{ mb: 3 }}>
          You need to be logged in as an admin to use this tool.
        </Alert>
      )}

      {token && (
        <Card variant="outlined" sx={{ mb: 3 }}>
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
                <Grid item xs={12} md={6}>
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
        <Stack spacing={3}>
          <Card variant="outlined">
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

          <Card variant="outlined">
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

          <Card variant="outlined">
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

          <Grid container spacing={2}>
            <Grid item xs={12} md={6}>
              <Card variant="outlined" sx={{ height: '100%' }}>
                <CardContent>
                  <Typography variant="subtitle1" sx={{ fontWeight: 700, mb: 1.5 }}>
                    Summaries
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
              <Card variant="outlined" sx={{ height: '100%' }}>
                <CardContent>
                  <Typography variant="subtitle1" sx={{ fontWeight: 700, mb: 1.5 }}>
                    Assets
                  </Typography>
                  <Stack spacing={1.5}>
                    {(context.assets || []).map((asset) => (
                      <Box key={asset._id}>
                        <Typography variant="body1" sx={{ fontWeight: 600 }}>
                          {asset.title}
                        </Typography>
                        <Typography variant="caption" color="text.secondary">
                          {formatDate(asset.createdAt)}
                          {typeof asset.relevanceScore === 'number' && ` · score ${asset.relevanceScore}`}
                        </Typography>
                        {!!asset.tags?.length && (
                          <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap sx={{ mt: 0.5 }}>
                            {asset.tags.map((tag) => (
                              <Chip key={`${asset._id}-${tag}`} label={tag} size="small" />
                            ))}
                          </Stack>
                        )}
                      </Box>
                    ))}
                    {!(context.assets || []).length && (
                      <Typography variant="body2" color="text.secondary">
                        No assets found for this pod.
                      </Typography>
                    )}
                  </Stack>
                </CardContent>
              </Card>
            </Grid>
          </Grid>

          <Card variant="outlined">
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
                    <Box key={result.assetId} sx={{ p: 1.25, borderRadius: 1.5, border: (theme) => `1px solid ${theme.palette.divider}` }}>
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
                <Card variant="outlined" sx={{ backgroundColor: 'background.default' }}>
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
  );
};

export default PodContextDevPage;
