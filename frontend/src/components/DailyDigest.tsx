import React, { useState, useEffect } from 'react';
import {
  Paper,
  Box,
  Typography,
  Button,
  CircularProgress,
  Alert,
  Card,
  CardContent,
  IconButton,
  Chip,
  Divider,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  List,
  ListItem,
  ListItemText,
  ListItemSecondaryAction,
  Tabs,
  Tab
} from '@mui/material';
import {
  Refresh as RefreshIcon,
  History as HistoryIcon,
  Email as EmailIcon,
  AutoAwesome as AutoAwesomeIcon,
  Schedule as ScheduleIcon,
  Article as ArticleIcon,
  Close as CloseIcon,
  Analytics as AnalyticsIcon
} from '@mui/icons-material';
import { formatDistanceToNow } from 'date-fns';
import axios from 'axios';
import ReactMarkdown from 'react-markdown';
import AnalyticsDashboard from './analytics/AnalyticsDashboard';
import { useV2Embedded } from '../v2/hooks/useV2Embedded';

interface DigestAnalytics {
  quotes?: unknown[];
  insights?: unknown[];
  timeline?: unknown[];
  atmosphere?: {
    overall_sentiment?: string;
  };
}

interface DigestMetadata {
  totalItems?: number;
  subscribedPods?: number;
}

interface DigestData {
  _id?: string;
  title?: string;
  content?: string;
  createdAt?: string;
  metadata?: DigestMetadata;
  analytics?: DigestAnalytics;
}

const DailyDigest: React.FC = () => {
  const v2Embedded = useV2Embedded();
  const [digest, setDigest] = useState<DigestData | null>(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [digestHistory, setDigestHistory] = useState<DigestData[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [activeTab, setActiveTab] = useState(0);

  const fetchLatestDigest = async (): Promise<void> => {
    try {
      const token = localStorage.getItem('token');
      if (!token) return;

      const response = await axios.get('/api/summaries/daily-digest', {
        headers: { Authorization: `Bearer ${token}` }
      });

      setDigest(response.data);
      setError(null);
    } catch (err) {
      const e = err as { response?: { status?: number; data?: { error?: string } } };
      if (e.response?.status === 404) {
        setDigest(null);
        setError('No daily digest found. Generate your first one or wait for the next ' +
          'scheduled generation at 6 AM UTC.');
      } else {
        setError(e.response?.data?.error || 'Failed to fetch daily digest');
      }
    } finally {
      setLoading(false);
    }
  };

  const generateDigest = async (): Promise<void> => {
    try {
      setGenerating(true);
      setError(null);

      const token = localStorage.getItem('token');
      const response = await axios.post('/api/summaries/daily-digest/generate', {}, {
        headers: { Authorization: `Bearer ${token}` }
      });

      setDigest(response.data.digest);

      // Show success message
      setTimeout(() => {
        setError(null);
      }, 3000);
    } catch (err) {
      const e = err as { response?: { data?: { error?: string } } };
      setError(e.response?.data?.error || 'Failed to generate daily digest');
    } finally {
      setGenerating(false);
    }
  };

  const fetchDigestHistory = async (): Promise<void> => {
    try {
      setHistoryLoading(true);
      const token = localStorage.getItem('token');

      const response = await axios.get('/api/summaries/daily-digest/history?limit=10', {
        headers: { Authorization: `Bearer ${token}` }
      });

      setDigestHistory(response.data);
    } catch (err) {
      console.error('Failed to fetch digest history:', err);
    } finally {
      setHistoryLoading(false);
    }
  };

  const openHistory = (): void => {
    setHistoryOpen(true);
    fetchDigestHistory();
  };

  const viewHistoricalDigest = (historicalDigest: DigestData): void => {
    setDigest(historicalDigest);
    setHistoryOpen(false);
  };

  useEffect(() => {
    fetchLatestDigest();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (loading) {
    return (
      <Paper elevation={0} sx={{ p: 3, textAlign: 'center' }}>
        <CircularProgress size={24} />
        <Typography variant="body2" sx={{ mt: 1 }}>
          Loading your daily digest...
        </Typography>
      </Paper>
    );
  }

  return (
    <Box>
      <Paper elevation={0} sx={{ mb: 3, borderRadius: 3, overflow: 'hidden' }}>
        {/* Header */}
        <Box sx={{ p: { xs: 2, md: 3 }, borderBottom: 1, borderColor: 'divider' }}>
          <Box
            className={v2Embedded ? 'v2-filter-bar v2-filter-bar--flat' : undefined}
            sx={v2Embedded ? undefined : {
              display: 'flex',
              flexDirection: { xs: 'column', md: 'row' },
              alignItems: { md: 'center' },
              justifyContent: 'space-between',
              gap: 2,
            }}
          >
            <Box sx={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap' }}>
              {/* The v2 shell renders its own page header. Inside v2 we
                  drop the in-card Daily Digest title and keep the Latest
                  chip as the only inline marker. */}
              {!v2Embedded && (
                <>
                  <EmailIcon sx={{ mr: 1, color: 'primary.main' }} />
                  <Typography variant="h6" component="h2" sx={{ fontWeight: 600 }}>
                    Daily Digest
                  </Typography>
                </>
              )}
              {digest && (
                <Chip
                  size="small"
                  label="Latest"
                  color="primary"
                  variant="outlined"
                  sx={{ ml: v2Embedded ? 0 : 1, fontSize: '0.7rem', height: 20 }}
                />
              )}
            </Box>

            <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
              <Button
                size="small"
                variant="outlined"
                startIcon={<HistoryIcon />}
                onClick={openHistory}
              >
                History
              </Button>
              <Button
                size="small"
                variant="contained"
                startIcon={generating ? <CircularProgress size={14} /> : <RefreshIcon />}
                onClick={generateDigest}
                disabled={generating}
              >
                {generating ? 'Generating\u2026' : 'Generate'}
              </Button>
            </Box>
            {v2Embedded && (
              <span className="v2-filter-bar__summary">
                {digest?.metadata?.totalItems
                  ? `${digest.metadata.totalItems} items analyzed`
                  : 'No digest data yet'}
                {digest?.createdAt ? ` · Updated ${formatDistanceToNow(new Date(digest.createdAt), { addSuffix: true })}` : ''}
              </span>
            )}
          </Box>

          {/* Quick Stats */}
          {digest && (
            <Box sx={{ display: 'flex', gap: 1, mt: 2, flexWrap: 'wrap' }}>
              <Chip
                size="small"
                icon={<ScheduleIcon sx={{ fontSize: 14 }} />}
                label={formatDistanceToNow(new Date(digest.createdAt!), { addSuffix: true })}
                variant="outlined"
                sx={{ fontSize: '0.7rem', height: 22 }}
              />
              {digest.metadata?.totalItems && (
                <Chip
                  size="small"
                  icon={<ArticleIcon sx={{ fontSize: 14 }} />}
                  label={`${digest.metadata.totalItems} items analyzed`}
                  variant="outlined"
                  sx={{ fontSize: '0.7rem', height: 22 }}
                />
              )}
              {digest.metadata?.subscribedPods && (
                <Chip
                  size="small"
                  icon={<AutoAwesomeIcon sx={{ fontSize: 14 }} />}
                  label={`${digest.metadata.subscribedPods} communities`}
                  variant="outlined"
                  sx={{ fontSize: '0.7rem', height: 22 }}
                />
              )}
            </Box>
          )}
        </Box>

        {/* Tabs */}
        <Box sx={{ borderBottom: 1, borderColor: 'divider' }}>
          <Tabs value={activeTab} onChange={(e, newValue) => setActiveTab(newValue)} aria-label="digest tabs">
            <Tab icon={<EmailIcon />} label="Digest" />
            <Tab icon={<AnalyticsIcon />} label="Analytics" />
          </Tabs>
        </Box>

        {/* Content */}
        <Box sx={{ p: 2 }}>
          {activeTab === 0 && (
            <>
              {error && (
                <Alert
                  severity={digest ? "info" : "warning"}
                  sx={{ mb: 2 }}
                  action={
                    !digest && (
                      <Button
                        color="inherit"
                        size="small"
                        onClick={generateDigest}
                        disabled={generating}
                      >
                        Generate Now
                      </Button>
                    )
                  }
                >
                  {error}
                </Alert>
              )}

              {generating && (
                <Alert severity="info" sx={{ mb: 2 }}>
                  <Box sx={{ display: 'flex', alignItems: 'center' }}>
                    <CircularProgress size={16} sx={{ mr: 1 }} />
                    Generating your personalized daily digest... This may take a few moments.
                  </Box>
                </Alert>
              )}

              {digest ? (
            <Card variant="outlined" sx={{ backgroundColor: 'background.paper' }}>
              <CardContent sx={{ p: 3 }}>
                <Typography variant="h5" component="h3" sx={{ mb: 2, color: 'primary.main' }}>
                  {digest.title}
                </Typography>

                <Box sx={{
                  '& h1': { fontSize: '1.5rem', fontWeight: 600, mt: 3, mb: 2, color: 'primary.main' },
                  '& h2': { fontSize: '1.25rem', fontWeight: 600, mt: 2, mb: 1.5, color: 'text.primary' },
                  '& h3': { fontSize: '1.1rem', fontWeight: 600, mt: 2, mb: 1, color: 'text.primary' },
                  '& p': { mb: 1.5, lineHeight: 1.6 },
                  '& ul': { mb: 1.5, pl: 2 },
                  '& li': { mb: 0.5 },
                  '& blockquote': {
                    borderLeft: '4px solid',
                    borderLeftColor: 'primary.main',
                    pl: 2,
                    ml: 0,
                    mb: 2,
                    py: 1,
                    backgroundColor: 'rgba(30, 41, 59, 0.65)',
                    fontStyle: 'italic',
                    color: 'text.primary'
                  },
                  '& hr': {
                    border: 'none',
                    borderTop: '1px solid',
                    borderColor: 'divider',
                    my: 3
                  },
                  '& strong': { fontWeight: 600 },
                  '& em': { fontStyle: 'italic' }
                }}>
                  <ReactMarkdown>{digest.content ?? ''}</ReactMarkdown>
                </Box>

                {/* Analytics Preview */}
                {digest.analytics && (
                  (() => {
                    const hasQuotes = (digest.analytics.quotes?.length ?? 0) > 0;
                    const hasInsights = (digest.analytics.insights?.length ?? 0) > 0;
                    const hasTimeline = (digest.analytics.timeline?.length ?? 0) > 0;
                    const hasMood = digest.analytics.atmosphere?.overall_sentiment;

                    // Only show analytics if there's meaningful data
                    if (hasQuotes || hasInsights || hasTimeline || hasMood) {
                      return (
                        <Box sx={{ mt: 3, pt: 2, borderTop: 1, borderColor: 'divider' }}>
                          <Typography variant="subtitle2" sx={{ mb: 1, color: 'text.secondary' }}>
                            📊 Digest Analytics
                          </Typography>
                          <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
                            {hasQuotes && (
                              <Chip
                                size="small"
                                label={`${digest.analytics.quotes!.length} quotes`}
                                variant="outlined"
                                sx={{ fontSize: '0.7rem', height: 20 }}
                              />
                            )}
                            {hasInsights && (
                              <Chip
                                size="small"
                                label={`${digest.analytics.insights!.length} insights`}
                                variant="outlined"
                                sx={{ fontSize: '0.7rem', height: 20 }}
                              />
                            )}
                            {hasTimeline && (
                              <Chip
                                size="small"
                                label={`${digest.analytics.timeline!.length} events`}
                                variant="outlined"
                                sx={{ fontSize: '0.7rem', height: 20 }}
                              />
                            )}
                            {hasMood && (
                              <Chip
                                size="small"
                                label={`${digest.analytics.atmosphere!.overall_sentiment} mood`}
                                color={digest.analytics.atmosphere!.overall_sentiment!.includes('positive') ?
                                'success' : 'default'}
                                variant="outlined"
                                sx={{ fontSize: '0.7rem', height: 20 }}
                              />
                            )}
                          </Box>
                        </Box>
                      );
                    }
                    return null;
                  })()
                )}
              </CardContent>
            </Card>
          ) : (
            <Box sx={{ textAlign: 'center', py: 4 }}>
              <EmailIcon sx={{ fontSize: 64, color: 'text.secondary', mb: 2 }} />
              <Typography variant="h6" sx={{ mb: 1 }}>
                No Daily Digest Yet
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
                Daily digests are automatically generated every morning at 6 AM UTC.<br />
                You can also generate one manually right now.
              </Typography>
              <Button
                variant="contained"
                onClick={generateDigest}
                disabled={generating}
                startIcon={generating ? <CircularProgress size={16} /> : <AutoAwesomeIcon />}
              >
                {generating ? 'Generating...' : 'Generate My Digest'}
              </Button>
            </Box>
          )}
            </>
          )}

          {activeTab === 1 && (
            <AnalyticsDashboard defaultTimeRange="24h" />
          )}
        </Box>
      </Paper>

      {/* History Dialog */}
      <Dialog
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        maxWidth="md"
        fullWidth
      >
        <DialogTitle>
          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <Box sx={{ display: 'flex', alignItems: 'center' }}>
              <HistoryIcon sx={{ mr: 1 }} />
              Digest History
            </Box>
            <IconButton onClick={() => setHistoryOpen(false)}>
              <CloseIcon />
            </IconButton>
          </Box>
        </DialogTitle>
        <DialogContent>
          {historyLoading ? (
            <Box sx={{ textAlign: 'center', py: 4 }}>
              <CircularProgress />
              <Typography sx={{ mt: 1 }}>Loading digest history...</Typography>
            </Box>
          ) : digestHistory.length > 0 ? (
            <List>
              {digestHistory.map((historicalDigest, index) => (
                <React.Fragment key={historicalDigest._id || index}>
                  <ListItem
                    onClick={() => viewHistoricalDigest(historicalDigest)}
                    sx={{
                      borderRadius: 1,
                      mb: 1,
                      cursor: 'pointer',
                      '&:hover': {
                        backgroundColor: 'action.hover'
                      }
                    }}
                  >
                    <ListItemText
                      primary={historicalDigest.title}
                      secondary={
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 0.5 }}>
                          <Typography variant="caption">
                            {formatDistanceToNow(new Date(historicalDigest.createdAt!), { addSuffix: true })}
                          </Typography>
                          {historicalDigest.metadata?.totalItems && (
                            <Chip
                              size="small"
                              label={`${historicalDigest.metadata.totalItems} items`}
                              variant="outlined"
                              sx={{ fontSize: '0.65rem', height: 18 }}
                            />
                          )}
                        </Box>
                      }
                    />
                    <ListItemSecondaryAction>
                      <Button size="small" variant="outlined">
                        View
                      </Button>
                    </ListItemSecondaryAction>
                  </ListItem>
                  {index < digestHistory.length - 1 && <Divider />}
                </React.Fragment>
              ))}
            </List>
          ) : (
            <Box sx={{ textAlign: 'center', py: 4 }}>
              <HistoryIcon sx={{ fontSize: 48, color: 'text.secondary', mb: 1 }} />
              <Typography>No digest history found</Typography>
              <Typography variant="body2" color="text.secondary">
                Generate your first digest to start building history
              </Typography>
            </Box>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setHistoryOpen(false)}>Close</Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
};

export default DailyDigest;
