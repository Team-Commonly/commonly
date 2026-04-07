import React, { useState } from 'react';
import {
  Box,
  Typography,
  Paper,
  Grid,
  FormControl,
  Select,
  MenuItem,
  FormLabel,
  Divider,
} from '@mui/material';
import ActivityTimeline from './ActivityTimeline';
import KeywordCloud from './KeywordCloud';

interface QuickStats {
  totalSummaries: number;
  totalActivity: number;
  uniqueUsers: number;
  dominantSentiment?: string;
}

interface AnalyticsDashboardProps {
  defaultTimeRange?: string;
}

const AnalyticsDashboard: React.FC<AnalyticsDashboardProps> = ({
  defaultTimeRange = '24h',
}) => {
  const [timeRange, setTimeRange] = useState(defaultTimeRange);
  const [viewMode, setViewMode] = useState('timeline');

  const QuickStatsPanel: React.FC = () => {
    const [stats, setStats] = useState<QuickStats | null>(null);

    React.useEffect(() => {
      const fetchStats = async (): Promise<void> => {
        try {
          const token = localStorage.getItem('token');
          const response = await fetch(`/api/analytics/summary?timeRange=${timeRange}`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          const data = await response.json() as { summary: QuickStats };
          setStats(data.summary);
        } catch (error) {
          console.error('Error fetching stats:', error);
        }
      };

      fetchStats();
    }, []);

    if (!stats) return null;

    return (
      <Grid container spacing={2} sx={{ mb: 3 }}>
        <Grid item xs={12} sm={6} md={3}>
          <Paper sx={{ p: 2, textAlign: 'center' }}>
            <Typography variant="h4" color="primary">
              {stats.totalSummaries}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Summaries Analyzed
            </Typography>
          </Paper>
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <Paper sx={{ p: 2, textAlign: 'center' }}>
            <Typography variant="h4" color="secondary">
              {stats.totalActivity}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Total Activity
            </Typography>
          </Paper>
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <Paper sx={{ p: 2, textAlign: 'center' }}>
            <Typography variant="h4" color="success.main">
              {stats.uniqueUsers}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Active Users
            </Typography>
          </Paper>
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <Paper sx={{ p: 2, textAlign: 'center' }}>
            <Typography variant="h4" color="warning.main">
              {stats.dominantSentiment || 'N/A'}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Community Mood
            </Typography>
          </Paper>
        </Grid>
      </Grid>
    );
  };

  return (
    <Box sx={{ p: 2 }}>
      {/* Header Controls */}
      <Box
        sx={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          mb: 3,
          flexWrap: 'wrap',
          gap: 2,
        }}
      >
        <Typography variant="h5" component="h2" sx={{ fontWeight: 600 }}>
          📊 Community Analytics
        </Typography>

        <Box sx={{ display: 'flex', gap: 2, alignItems: 'center' }}>
          <FormControl size="small">
            <FormLabel sx={{ fontSize: '0.75rem', mb: 0.5 }}>Time Range</FormLabel>
            <Select
              value={timeRange}
              onChange={(e) => setTimeRange(e.target.value)}
              sx={{ minWidth: 100 }}
            >
              <MenuItem value="24h">24 Hours</MenuItem>
              <MenuItem value="3d">3 Days</MenuItem>
              <MenuItem value="7d">7 Days</MenuItem>
            </Select>
          </FormControl>

          <FormControl size="small">
            <FormLabel sx={{ fontSize: '0.75rem', mb: 0.5 }}>View</FormLabel>
            <Select
              value={viewMode}
              onChange={(e) => setViewMode(e.target.value)}
              sx={{ minWidth: 160 }}
            >
              <MenuItem value="timeline">Activity Timeline</MenuItem>
              <MenuItem value="keywords">Keyword Cloud</MenuItem>
              <MenuItem value="both">Timeline + Keywords</MenuItem>
            </Select>
          </FormControl>
        </Box>
      </Box>

      {/* Quick Stats */}
      <QuickStatsPanel />

      <Divider sx={{ my: 3 }} />

      {/* Visualization Grid */}
      <Grid container spacing={3}>
        {(viewMode === 'timeline' || viewMode === 'both') && (
          <Grid item xs={12} lg={viewMode === 'both' ? 6 : 12}>
            <ActivityTimeline timeRange={timeRange} />
          </Grid>
        )}

        {(viewMode === 'keywords' || viewMode === 'both') && (
          <Grid item xs={12} lg={viewMode === 'both' ? 6 : 12}>
            <KeywordCloud timeRange={timeRange} />
          </Grid>
        )}
      </Grid>

      {/* Insights Summary */}
      <Box sx={{ mt: 4 }}>
        <Paper elevation={1} sx={{ p: 3 }}>
          <Typography variant="h6" component="h3" sx={{ mb: 2 }}>
            🔍 Key Insights
          </Typography>
          <Grid container spacing={2}>
            <Grid item xs={12} md={4}>
              <Typography variant="subtitle2" color="primary" sx={{ mb: 1 }}>
                Most Active Time
              </Typography>
              <Typography variant="body2" color="text.secondary">
                Analysis of peak activity hours shows community engagement patterns
              </Typography>
            </Grid>
            <Grid item xs={12} md={4}>
              <Typography variant="subtitle2" color="secondary" sx={{ mb: 1 }}>
                Popular Topics
              </Typography>
              <Typography variant="body2" color="text.secondary">
                Keyword analysis reveals trending discussions and community interests
              </Typography>
            </Grid>
            <Grid item xs={12} md={4}>
              <Typography variant="subtitle2" color="success.main" sx={{ mb: 1 }}>
                Community Health
              </Typography>
              <Typography variant="body2" color="text.secondary">
                Overall sentiment and engagement quality indicate community wellness
              </Typography>
            </Grid>
          </Grid>
        </Paper>
      </Box>
    </Box>
  );
};

export default AnalyticsDashboard;
