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
  Container,
  FormControlLabel,
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
  const [error, setError] = useState(null);

  const authHeaders = useMemo(() => (
    token ? { Authorization: `Bearer ${token}` } : {}
  ), [token]);

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
        </Stack>
      )}
    </Container>
  );
};

export default PodContextDevPage;
