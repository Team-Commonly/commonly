/**
 * ActivityFeedPage
 *
 * Page wrapper for the ActivityFeed component.
 * Fetches activity data and provides filtering.
 */

import React, { useState, useEffect } from 'react';
import {
  Container,
  Box,
  Typography,
  Tabs,
  Tab,
  Paper,
  Alert,
  Button,
  FormControl,
  Select,
  MenuItem,
  InputLabel,
  Snackbar,
} from '@mui/material';
import {
  People as AllIcon,
  Person as HumansIcon,
  SmartToy as AgentsIcon,
  AutoAwesome as SkillsIcon,
  Refresh as RefreshIcon,
} from '@mui/icons-material';
import ActivityFeed from './ActivityFeed';
import axios from 'axios';

const ActivityFeedPage = () => {
  const [activities, setActivities] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState('all');
  const [hasMore, setHasMore] = useState(true);
  const [userPods, setUserPods] = useState([]);
  const [selectedPodId, setSelectedPodId] = useState('all');
  const [snackbar, setSnackbar] = useState({ open: false, message: '', severity: 'info' });

  const getAuthHeaders = () => {
    const token = localStorage.getItem('token');
    return { 'x-auth-token': token };
  };

  // Fetch user's pods for the selector
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
  }, []);

  useEffect(() => {
    fetchActivities();
  }, [filter, selectedPodId]);

  const fetchActivities = async () => {
    setLoading(true);
    try {
      const params = { limit: 20 };
      if (filter !== 'all') {
        params.filter = filter;
      }

      let url = '/api/activity/feed';
      if (selectedPodId !== 'all') {
        url = `/api/activity/pods/${selectedPodId}`;
      }

      const response = await axios.get(url, {
        headers: getAuthHeaders(),
        params,
      });

      const fetchedActivities = response.data.activities || [];
      setActivities(fetchedActivities);
      setHasMore(response.data.hasMore || false);
      setError(fetchedActivities.length === 0 ? 'No activity yet' : null);
    } catch (err) {
      console.error('Error fetching activities:', err);
      setError('Failed to load activities');
      setActivities([]);
    } finally {
      setLoading(false);
    }
  };

  const handleLike = async (activity) => {
    try {
      await axios.post(
        `/api/activity/${activity.id}/like`,
        {},
        { headers: getAuthHeaders() }
      );
      // Optimistically update the UI
      setActivities((prev) =>
        prev.map((a) =>
          a.id === activity.id
            ? {
                ...a,
                reactions: {
                  ...a.reactions,
                  likes: (a.reactions?.likes || 0) + 1,
                  liked: true,
                },
              }
            : a
        )
      );
    } catch (err) {
      console.error('Error liking activity:', err);
      setSnackbar({ open: true, message: 'Failed to like', severity: 'error' });
    }
  };

  const handleReply = async (activity, content) => {
    try {
      const response = await axios.post(
        `/api/activity/${activity.id}/reply`,
        { content },
        { headers: getAuthHeaders() }
      );

      if (response.data.success) {
        // Update the activity with the new reply
        setActivities((prev) =>
          prev.map((a) =>
            a.id === activity.id
              ? {
                  ...a,
                  replyCount: (a.replyCount || 0) + 1,
                  replies: [...(a.replies || []), response.data.reply],
                }
              : a
          )
        );
        setSnackbar({ open: true, message: 'Reply added', severity: 'success' });
      }
    } catch (err) {
      console.error('Error replying to activity:', err);
      setSnackbar({ open: true, message: 'Failed to reply', severity: 'error' });
    }
  };

  const handleApprove = async (activity) => {
    try {
      const response = await axios.post(
        `/api/activity/${activity.id}/approve`,
        { notes: 'Approved via UI' },
        { headers: getAuthHeaders() }
      );

      if (response.data.success) {
        // Update the activity status
        setActivities((prev) =>
          prev.map((a) =>
            a.id === activity.id
              ? {
                  ...a,
                  approval: { ...a.approval, status: 'approved' },
                }
              : a
          )
        );
        setSnackbar({ open: true, message: 'Approved successfully', severity: 'success' });
      }
    } catch (err) {
      console.error('Error approving:', err);
      setSnackbar({ open: true, message: 'Failed to approve', severity: 'error' });
    }
  };

  const handleReject = async (activity) => {
    try {
      const response = await axios.post(
        `/api/activity/${activity.id}/reject`,
        { notes: 'Rejected via UI' },
        { headers: getAuthHeaders() }
      );

      if (response.data.success) {
        // Update the activity status
        setActivities((prev) =>
          prev.map((a) =>
            a.id === activity.id
              ? {
                  ...a,
                  approval: { ...a.approval, status: 'rejected' },
                }
              : a
          )
        );
        setSnackbar({ open: true, message: 'Rejected', severity: 'info' });
      }
    } catch (err) {
      console.error('Error rejecting:', err);
      setSnackbar({ open: true, message: 'Failed to reject', severity: 'error' });
    }
  };

  const handleLoadMore = async () => {
    if (activities.length === 0 || loading) return;

    const lastActivity = activities[activities.length - 1];
    try {
      const params = { limit: 20, before: lastActivity.timestamp };
      if (filter !== 'all') {
        params.filter = filter;
      }

      let url = '/api/activity/feed';
      if (selectedPodId !== 'all') {
        url = `/api/activity/pods/${selectedPodId}`;
      }

      const response = await axios.get(url, {
        headers: getAuthHeaders(),
        params,
      });

      setActivities([...activities, ...(response.data.activities || [])]);
      setHasMore(response.data.hasMore || false);
    } catch (err) {
      console.error('Error loading more activities:', err);
    }
  };

  const handleSeedActivities = async () => {
    if (selectedPodId === 'all') {
      setSnackbar({ open: true, message: 'Select a specific pod to seed activities', severity: 'warning' });
      return;
    }

    try {
      const response = await axios.post(
        `/api/activity/seed/${selectedPodId}`,
        {},
        { headers: getAuthHeaders() }
      );

      if (response.data.success) {
        setSnackbar({
          open: true,
          message: `Seeded ${response.data.count} demo activities`,
          severity: 'success',
        });
        // Refresh the feed
        fetchActivities();
      }
    } catch (err) {
      console.error('Error seeding activities:', err);
      setSnackbar({ open: true, message: 'Failed to seed activities', severity: 'error' });
    }
  };

  return (
    <Container maxWidth="md" sx={{ py: 4 }}>
      {/* Header */}
      <Box sx={{ mb: 4, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <Box>
          <Typography variant="h4" fontWeight={700} gutterBottom>
            Activity
          </Typography>
          <Typography variant="body1" color="text.secondary">
            See what&apos;s happening across your pods
          </Typography>
        </Box>

        {/* Pod Selector */}
        <Box sx={{ display: 'flex', gap: 1 }}>
          <FormControl sx={{ minWidth: 150 }} size="small">
            <InputLabel>Pod</InputLabel>
            <Select
              value={selectedPodId}
              label="Pod"
              onChange={(e) => setSelectedPodId(e.target.value)}
            >
              <MenuItem value="all">All Pods</MenuItem>
              {userPods.map((pod) => (
                <MenuItem key={pod._id} value={pod._id}>
                  {pod.name}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
          <Button
            variant="outlined"
            size="small"
            startIcon={<RefreshIcon />}
            onClick={fetchActivities}
          >
            Refresh
          </Button>
        </Box>
      </Box>

      {/* Filter tabs */}
      <Paper elevation={0} sx={{ mb: 3, borderRadius: 2 }}>
        <Tabs
          value={filter}
          onChange={(e, v) => setFilter(v)}
          variant="fullWidth"
          sx={{
            '& .MuiTab-root': {
              minHeight: 48,
              textTransform: 'none',
              fontWeight: 500,
            },
          }}
        >
          <Tab icon={<AllIcon />} iconPosition="start" label="All" value="all" />
          <Tab icon={<HumansIcon />} iconPosition="start" label="Humans" value="humans" />
          <Tab icon={<AgentsIcon />} iconPosition="start" label="Agents" value="agents" />
          <Tab icon={<SkillsIcon />} iconPosition="start" label="Skills" value="skills" />
        </Tabs>
      </Paper>

      {error && (
        <Alert
          severity="info"
          sx={{ mb: 2 }}
          action={
            selectedPodId !== 'all' && (
              <Button color="inherit" size="small" onClick={handleSeedActivities}>
                Seed Demo Data
              </Button>
            )
          }
        >
          {error}
        </Alert>
      )}

      {/* Activity feed */}
      <ActivityFeed
        activities={activities}
        loading={loading}
        filter={filter}
        onLike={handleLike}
        onReply={handleReply}
        onApprove={handleApprove}
        onReject={handleReject}
        onLoadMore={handleLoadMore}
        hasMore={hasMore}
      />

      {/* Snackbar for notifications */}
      <Snackbar
        open={snackbar.open}
        autoHideDuration={3000}
        onClose={() => setSnackbar({ ...snackbar, open: false })}
        message={snackbar.message}
      />
    </Container>
  );
};

export default ActivityFeedPage;
