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
  NotificationsActive as NotificationsIcon,
  DynamicFeed as UpdatesIcon,
  Bolt as ActionsIcon,
  AlternateEmail as MentionsIcon,
  Forum as ThreadsIcon,
  Favorite as FollowingIcon,
  Chat as PodsIcon,
} from '@mui/icons-material';
import ActivityFeed, { Activity } from './ActivityFeed';
import axios from 'axios';
import { useSocket } from '../../context/SocketContext';
import { useAuth } from '../../context/AuthContext';

interface UserPod {
  _id: string;
  name: string;
}

interface QuickPod {
  id: string;
  name: string;
}

interface FollowedThread {
  postId: string;
  url: string;
  preview?: string;
  newReplies: number;
}

interface QuickData {
  social?: { followers?: number; following?: number };
  recentPods?: QuickPod[];
  followedThreads?: FollowedThread[];
}

interface SnackbarState {
  open: boolean;
  message: string;
  severity: 'info' | 'error' | 'success' | 'warning';
}

const ActivityFeedPage: React.FC = () => {
  const [activities, setActivities] = useState<Activity[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState('updates');
  const [filter, setFilter] = useState('all');
  const [hasMore, setHasMore] = useState(true);
  const [userPods, setUserPods] = useState<UserPod[]>([]);
  const [quick, setQuick] = useState<QuickData | null>(null);
  const [liveUpdates, setLiveUpdates] = useState(0);
  const [unreadCount, setUnreadCount] = useState(0);
  const [selectedPodId, setSelectedPodId] = useState('all');
  const [snackbar, setSnackbar] = useState<SnackbarState>({
    open: false,
    message: '',
    severity: 'info',
  });
  const { socket, connected } = useSocket();
  const { currentUser } = useAuth();

  const getAuthHeaders = (): Record<string, string> => {
    const token = localStorage.getItem('token');
    return { 'x-auth-token': token ?? '' };
  };

  // Fetch user's pods for the selector
  useEffect(() => {
    const fetchUserPods = async (): Promise<void> => {
      try {
        const response = await axios.get<UserPod[]>('/api/pods', {
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
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, filter, selectedPodId]);

  useEffect(() => {
    fetchUnreadCount();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, filter]);

  const fetchUnreadCount = async (): Promise<void> => {
    try {
      const response = await axios.get<{ unreadCount?: number }>('/api/activity/unread-count', {
        headers: getAuthHeaders(),
        params: { mode, filter },
      });
      setUnreadCount(response.data?.unreadCount || 0);
    } catch {
      // keep current value
    }
  };

  const fetchActivities = async (): Promise<void> => {
    setLoading(true);
    try {
      const params: Record<string, unknown> = { limit: 20 };
      if (filter !== 'all') params.filter = filter;
      params.mode = mode;

      let url = '/api/activity/feed';
      if (selectedPodId !== 'all') {
        url = `/api/activity/pods/${selectedPodId}`;
      }

      const response = await axios.get<{
        activities?: Activity[];
        hasMore?: boolean;
        quick?: QuickData;
        unreadCount?: number;
      }>(url, {
        headers: getAuthHeaders(),
        params,
      });

      const fetchedActivities = response.data.activities || [];
      setActivities(fetchedActivities);
      setHasMore(response.data.hasMore || false);
      setQuick(response.data.quick || null);
      setLiveUpdates(0);
      setUnreadCount(
        response.data.unreadCount !== undefined
          ? response.data.unreadCount
          : fetchedActivities.filter((item) => !item.read).length,
      );
      setError(fetchedActivities.length === 0 ? 'No activity yet' : null);
    } catch (err) {
      console.error('Error fetching activities:', err);
      setError('Failed to load activities');
      setActivities([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!socket || !connected || !Array.isArray(userPods) || userPods.length === 0) {
      return undefined;
    }
    userPods.forEach((pod) => socket.emit('joinPod', pod._id));

    const handleNewMessage = (message: Record<string, unknown>): void => {
      const pod = userPods.find(
        (item) => item._id === (message.podId || message.pod_id),
      );
      const actorName =
        (message.username as string) ||
        ((message.userId as Record<string, unknown>)?.username as string) ||
        'User';
      const isAgent =
        actorName.toLowerCase().includes('bot') || actorName === 'commonly-ai-agent';

      const activity: Activity = {
        id: `live_${(message._id as string) || (message.id as string) || Date.now()}`,
        type: 'message',
        actor: {
          id:
            ((message.userId as Record<string, unknown>)?._id as string) ||
            (message.userId as string) ||
            (message.user_id as string),
          name: actorName,
          type: isAgent ? 'agent' : 'human',
          verified: isAgent,
          profilePicture:
            (message.profilePicture as string) ||
            (message.profile_picture as string) ||
            ((message.userId as Record<string, unknown>)?.profilePicture as string),
        },
        action: 'message',
        content: (message.content as string) || (message.text as string) || '',
        preview: ((message.content as string) || (message.text as string) || '').slice(0, 200),
        timestamp:
          (message.createdAt as string) ||
          (message.created_at as string) ||
          new Date().toISOString(),
        pod: pod ? { id: pod._id, name: pod.name } : null,
        reactions: { likes: 0, liked: false },
        replyCount: 0,
        replies: [],
        flags: {
          isAgentAction: isAgent,
          isMention: Boolean(
            currentUser?.username &&
              ((message.content as string) || '').toLowerCase().includes(
                `@${currentUser.username.toLowerCase()}`,
              ),
          ),
          isFollowing: false,
          isThreadUpdate: false,
        },
      };

      setActivities((prev) =>
        [activity, ...prev.filter((item) => item.id !== activity.id)].slice(0, 50),
      );
      setLiveUpdates((count) => count + 1);
      setUnreadCount((count) => count + 1);
    };

    socket.on('newMessage', handleNewMessage);
    return () => {
      socket.off('newMessage', handleNewMessage);
      userPods.forEach((pod) => socket.emit('leavePod', pod._id));
    };
  }, [socket, connected, userPods, currentUser]);

  const handleMarkRead = async (activity: Activity): Promise<void> => {
    if (!activity?.id) return;
    try {
      await axios.post(
        '/api/activity/mark-read',
        { activityId: activity.id },
        { headers: getAuthHeaders() },
      );
      setActivities((prev) =>
        prev.map((item) => (item.id === activity.id ? { ...item, read: true } : item)),
      );
      setUnreadCount((count) => Math.max(0, count - 1));
    } catch {
      setSnackbar({ open: true, message: 'Failed to mark as read', severity: 'error' });
    }
  };

  const handleMarkAllRead = async (): Promise<void> => {
    try {
      await axios.post(
        '/api/activity/mark-read',
        { all: true },
        { headers: getAuthHeaders() },
      );
      setActivities((prev) => prev.map((item) => ({ ...item, read: true })));
      setUnreadCount(0);
      setSnackbar({ open: true, message: 'All caught up', severity: 'success' });
    } catch {
      setSnackbar({ open: true, message: 'Failed to mark all as read', severity: 'error' });
    }
  };

  const handleLike = async (activity: Activity): Promise<void> => {
    try {
      await axios.post(`/api/activity/${activity.id}/like`, {}, { headers: getAuthHeaders() });
      setActivities((prev) =>
        prev.map((a) =>
          a.id === activity.id
            ? {
                ...a,
                reactions: { ...a.reactions, likes: (a.reactions?.likes || 0) + 1, liked: true },
              }
            : a,
        ),
      );
    } catch (err) {
      console.error('Error liking activity:', err);
      setSnackbar({ open: true, message: 'Failed to like', severity: 'error' });
    }
  };

  const handleReply = async (activity: Activity, content?: string): Promise<void> => {
    try {
      const response = await axios.post<{ success: boolean; reply: unknown }>(
        `/api/activity/${activity.id}/reply`,
        { content },
        { headers: getAuthHeaders() },
      );
      if (response.data.success) {
        setActivities((prev) =>
          prev.map((a) =>
            a.id === activity.id
              ? {
                  ...a,
                  replyCount: (a.replyCount || 0) + 1,
                  replies: [
                    ...(a.replies || []),
                    response.data.reply as Activity['replies'][0],
                  ],
                }
              : a,
          ),
        );
        setSnackbar({ open: true, message: 'Reply added', severity: 'success' });
      }
    } catch (err) {
      console.error('Error replying to activity:', err);
      setSnackbar({ open: true, message: 'Failed to reply', severity: 'error' });
    }
  };

  const handleApprove = async (activity: Activity): Promise<void> => {
    try {
      const response = await axios.post<{ success: boolean }>(
        `/api/activity/${activity.id}/approve`,
        { notes: 'Approved via UI' },
        { headers: getAuthHeaders() },
      );
      if (response.data.success) {
        setActivities((prev) =>
          prev.map((a) =>
            a.id === activity.id
              ? { ...a, approval: { ...a.approval, status: 'approved' } }
              : a,
          ),
        );
        setSnackbar({ open: true, message: 'Approved successfully', severity: 'success' });
      }
    } catch (err) {
      console.error('Error approving:', err);
      setSnackbar({ open: true, message: 'Failed to approve', severity: 'error' });
    }
  };

  const handleReject = async (activity: Activity): Promise<void> => {
    try {
      const response = await axios.post<{ success: boolean }>(
        `/api/activity/${activity.id}/reject`,
        { notes: 'Rejected via UI' },
        { headers: getAuthHeaders() },
      );
      if (response.data.success) {
        setActivities((prev) =>
          prev.map((a) =>
            a.id === activity.id
              ? { ...a, approval: { ...a.approval, status: 'rejected' } }
              : a,
          ),
        );
        setSnackbar({ open: true, message: 'Rejected', severity: 'info' });
      }
    } catch (err) {
      console.error('Error rejecting:', err);
      setSnackbar({ open: true, message: 'Failed to reject', severity: 'error' });
    }
  };

  const handleLoadMore = async (): Promise<void> => {
    if (activities.length === 0 || loading) return;

    const lastActivity = activities[activities.length - 1];
    try {
      const params: Record<string, unknown> = {
        limit: 20,
        before: lastActivity.timestamp,
      };
      if (filter !== 'all') params.filter = filter;
      params.mode = mode;

      let url = '/api/activity/feed';
      if (selectedPodId !== 'all') {
        url = `/api/activity/pods/${selectedPodId}`;
      }

      const response = await axios.get<{ activities?: Activity[]; hasMore?: boolean }>(url, {
        headers: getAuthHeaders(),
        params,
      });

      setActivities([...activities, ...(response.data.activities || [])]);
      setHasMore(response.data.hasMore || false);
    } catch (err) {
      console.error('Error loading more activities:', err);
    }
  };

  const handleSeedActivities = async (): Promise<void> => {
    if (selectedPodId === 'all') {
      setSnackbar({
        open: true,
        message: 'Select a specific pod to seed activities',
        severity: 'warning',
      });
      return;
    }

    try {
      const response = await axios.post<{ success: boolean; count: number }>(
        `/api/activity/seed/${selectedPodId}`,
        {},
        { headers: getAuthHeaders() },
      );

      if (response.data.success) {
        setSnackbar({
          open: true,
          message: `Seeded ${response.data.count} demo activities`,
          severity: 'success',
        });
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
      <Box
        sx={{ mb: 4, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}
      >
        <Box>
          <Typography variant="h4" fontWeight={700} gutterBottom>
            Activity
          </Typography>
          <Typography variant="body1" color="text.secondary">
            Real-time social updates across your pods, threads, and follows
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
            onClick={() => {
              fetchActivities();
              fetchUnreadCount();
            }}
          >
            Refresh
          </Button>
          <Button variant="contained" size="small" onClick={handleMarkAllRead}>
            Mark all read ({unreadCount})
          </Button>
        </Box>
      </Box>

      {liveUpdates > 0 && (
        <Alert severity="info" sx={{ mb: 2 }} icon={<NotificationsIcon />}>
          {liveUpdates} new live update{liveUpdates === 1 ? '' : 's'} received
        </Alert>
      )}

      {quick && (
        <Paper
          elevation={0}
          sx={{ mb: 3, borderRadius: 2, p: 2, border: '1px solid', borderColor: 'divider' }}
        >
          <Typography variant="subtitle2" sx={{ mb: 1 }}>
            Quick View
          </Typography>
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1.5, mb: 1.5 }}>
            <Button size="small" variant="outlined" disableElevation>
              Followers: {quick.social?.followers || 0}
            </Button>
            <Button size="small" variant="outlined" disableElevation>
              Following: {quick.social?.following || 0}
            </Button>
          </Box>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 0.5 }}>
            Recent Joined/Active Pods
          </Typography>
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
            {(quick.recentPods || []).slice(0, 4).map((pod) => (
              <Button
                key={pod.id}
                size="small"
                onClick={() => setSelectedPodId(pod.id)}
                variant={selectedPodId === pod.id ? 'contained' : 'outlined'}
              >
                {pod.name}
              </Button>
            ))}
          </Box>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1.5, mb: 0.5 }}>
            Followed Threads
          </Typography>
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75 }}>
            {(quick.followedThreads || []).slice(0, 3).map((thread) => (
              <Typography
                key={thread.postId}
                variant="body2"
                sx={{ cursor: 'pointer' }}
                onClick={() => {
                  window.location.href = thread.url;
                }}
              >
                {thread.preview || 'Thread'}{' '}
                {thread.newReplies > 0 ? `• ${thread.newReplies} new replies` : ''}
              </Typography>
            ))}
            {(quick.followedThreads || []).length === 0 && (
              <Typography variant="body2" color="text.secondary">
                No followed threads yet.
              </Typography>
            )}
          </Box>
        </Paper>
      )}

      {/* Mode tabs */}
      <Paper elevation={0} sx={{ mb: 3, borderRadius: 2 }}>
        <Tabs
          value={mode}
          onChange={(_e, v: string) => {
            setMode(v);
            setFilter('all');
          }}
          variant="fullWidth"
          sx={{ '& .MuiTab-root': { minHeight: 48, textTransform: 'none', fontWeight: 500 } }}
        >
          <Tab icon={<UpdatesIcon />} iconPosition="start" label="Updates" value="updates" />
          <Tab icon={<ActionsIcon />} iconPosition="start" label="Actions" value="actions" />
        </Tabs>
      </Paper>

      {/* Filter tabs */}
      <Paper elevation={0} sx={{ mb: 3, borderRadius: 2 }}>
        <Tabs
          value={filter}
          onChange={(_e, v: string) => setFilter(v)}
          variant="scrollable"
          allowScrollButtonsMobile
          sx={{ '& .MuiTab-root': { minHeight: 44, textTransform: 'none', fontWeight: 500 } }}
        >
          <Tab icon={<AllIcon />} iconPosition="start" label="All" value="all" />
          {mode === 'updates' && (
            <Tab
              icon={<MentionsIcon />}
              iconPosition="start"
              label="Mentions"
              value="mentions"
            />
          )}
          {mode === 'updates' && (
            <Tab
              icon={<FollowingIcon />}
              iconPosition="start"
              label="Following"
              value="following"
            />
          )}
          {mode === 'updates' && (
            <Tab
              icon={<ThreadsIcon />}
              iconPosition="start"
              label="Threads"
              value="threads"
            />
          )}
          {mode === 'updates' && (
            <Tab icon={<PodsIcon />} iconPosition="start" label="Pods" value="pods" />
          )}
          {mode === 'actions' && (
            <Tab icon={<AgentsIcon />} iconPosition="start" label="Agents" value="agents" />
          )}
          {mode === 'actions' && (
            <Tab icon={<HumansIcon />} iconPosition="start" label="Humans" value="humans" />
          )}
          {mode === 'actions' && (
            <Tab icon={<SkillsIcon />} iconPosition="start" label="Skills" value="skills" />
          )}
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
        onMarkRead={handleMarkRead}
        onActorClick={(actorId) => {
          window.location.href = `/profile/${actorId}`;
        }}
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
