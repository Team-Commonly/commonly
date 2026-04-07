/**
 * ActivityFeed Component
 *
 * Unified activity feed showing both human and AI agent interactions.
 * The core social experience of Commonly.
 */

import React, { useState } from 'react';
import {
  Box,
  Paper,
  Typography,
  Avatar,
  IconButton,
  Button,
  Chip,
  Tooltip,
  Skeleton,
  alpha,
  useTheme,
  Collapse,
} from '@mui/material';
import {
  VerifiedUser as VerifiedIcon,
  ThumbUp as LikeIcon,
  ThumbUpOutlined as LikeOutlinedIcon,
  ChatBubbleOutline as ReplyIcon,
  MoreHoriz as MoreIcon,
  PushPin as PinIcon,
  AutoAwesome as SkillIcon,
  Link as LinkIcon,
  Search as QueryIcon,
  Check as ApproveIcon,
  Close as RejectIcon,
  SmartToy as AgentIcon,
  Person as HumanIcon,
} from '@mui/icons-material';
import { SvgIconComponent } from '@mui/icons-material';
import { Theme } from '@mui/material/styles';

interface Actor {
  id?: string;
  name?: string;
  type?: string;
  verified?: boolean;
  profilePicture?: string;
}

interface Target {
  title?: string;
  preview?: string;
  description?: string;
}

interface AgentMetadata {
  sources?: Array<{ title?: string }>;
}

interface Pod {
  id: string;
  name: string;
}

interface Participant {
  name?: string;
  type?: string;
}

interface Reply {
  actor: { name?: string; type?: string };
  content?: string;
}

export interface Activity {
  id: string;
  type?: string;
  actor: Actor;
  action?: string;
  content?: string;
  preview?: string;
  timestamp: string;
  reactions?: { likes?: number; liked?: boolean };
  replyCount?: number;
  replies?: Reply[];
  target?: Target;
  involves?: Participant[];
  agentMetadata?: AgentMetadata;
  pod?: Pod | null;
  read?: boolean;
  approval?: { status?: string };
  flags?: Record<string, boolean>;
}

interface ParticipantStyle {
  avatarShape: 'circular' | 'rounded';
  badgeIcon: SvgIconComponent | null;
  glowColor: ((theme: Theme) => string) | null;
}

// Participant type styling
const participantStyles: Record<string, ParticipantStyle> = {
  human: { avatarShape: 'circular', badgeIcon: null, glowColor: null },
  agent: {
    avatarShape: 'rounded',
    badgeIcon: AgentIcon,
    glowColor: (theme) => theme.palette.primary.main,
  },
  system: { avatarShape: 'rounded', badgeIcon: null, glowColor: null },
};

interface ActivityTypeInfo {
  icon: SvgIconComponent | null;
  color: string;
  label: string;
}

// Activity type icons and colors
const activityTypes: Record<string, ActivityTypeInfo> = {
  message: { icon: null, color: 'text.primary', label: '' },
  reply: { icon: ReplyIcon, color: 'text.secondary', label: 'replied' },
  skill_created: { icon: SkillIcon, color: 'secondary.main', label: 'created a skill' },
  joined: { icon: null, color: 'success.main', label: 'joined' },
  mentioned: { icon: null, color: 'primary.main', label: 'mentioned' },
  task_completed: { icon: null, color: 'success.main', label: 'completed a task' },
  query: { icon: QueryIcon, color: 'info.main', label: 'searched' },
  approval_needed: { icon: null, color: 'warning.main', label: 'needs approval' },
  pod_linked: { icon: LinkIcon, color: 'primary.main', label: 'linked pods' },
  agent_action: { icon: AgentIcon, color: 'primary.main', label: '' },
  summary: { icon: SkillIcon, color: 'info.main', label: 'summarized' },
  thread_comment: { icon: ReplyIcon, color: 'info.main', label: 'replied on thread' },
  thread_followed: { icon: LinkIcon, color: 'primary.main', label: 'followed thread' },
  user_followed: { icon: HumanIcon, color: 'success.main', label: 'followed' },
};

interface ActivityItemProps {
  activity: Activity;
  onLike?: (activity: Activity) => void;
  onReply?: (activity: Activity, content?: string) => void;
  onApprove?: (activity: Activity) => void;
  onReject?: (activity: Activity) => void;
  onMarkRead?: (activity: Activity) => void;
  onActorClick?: (actorId: string) => void;
}

// Single activity item
const ActivityItem: React.FC<ActivityItemProps> = ({
  activity,
  onLike,
  onReply,
  onApprove,
  onReject,
  onMarkRead,
  onActorClick,
}) => {
  const theme = useTheme();
  const [showReplies, setShowReplies] = useState(false);
  const [isLiked, setIsLiked] = useState(false);

  const {
    actor,
    action,
    content,
    preview,
    timestamp,
    reactions = {},
    replyCount = 0,
    replies = [],
    target,
    involves = [],
    agentMetadata,
    pod,
    read,
  } = activity;

  const isAgent = actor.type === 'agent';
  const isUnread = !read;
  const style = participantStyles[actor.type ?? 'human'] || participantStyles.human;
  const actionType = activityTypes[action ?? 'message'] || activityTypes.message;

  const formatTime = (ts: string): string => {
    const date = new Date(ts);
    const now = new Date();
    const diff = (now.getTime() - date.getTime()) / 1000;

    if (diff < 60) return 'now';
    if (diff < 3600) return `${Math.floor(diff / 60)}m`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
    return date.toLocaleDateString();
  };

  const handleLike = (): void => {
    setIsLiked(!isLiked);
    onLike?.(activity);
  };

  return (
    <Paper
      elevation={0}
      sx={{
        p: 2,
        mb: 1.5,
        borderRadius: 3,
        border: `1px solid ${isUnread ? alpha(theme.palette.error.main, 0.35) : theme.palette.divider}`,
        borderLeft: `4px solid ${isUnread ? theme.palette.error.main : 'transparent'}`,
        backgroundColor: isUnread
          ? alpha(theme.palette.error.main, 0.05)
          : theme.palette.background.paper,
        transition: 'all 0.2s ease',
        '&:hover': {
          borderColor: isUnread
            ? alpha(theme.palette.error.main, 0.5)
            : theme.palette.grey[300],
          backgroundColor: alpha(theme.palette.primary.main, 0.02),
        },
        opacity: read ? 0.92 : 1,
      }}
    >
      {/* Header */}
      <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1.5, mb: 1.5 }}>
        {/* Avatar with agent indicator */}
        <Box sx={{ position: 'relative' }}>
          <Avatar
            sx={{
              width: 44,
              height: 44,
              borderRadius: style.avatarShape === 'rounded' ? 2 : '50%',
              backgroundColor: isAgent
                ? alpha(theme.palette.primary.main, 0.1)
                : theme.palette.grey[200],
              color: isAgent ? theme.palette.primary.main : theme.palette.text.primary,
              boxShadow: isAgent
                ? `0 0 0 2px ${alpha(theme.palette.primary.main, 0.2)}`
                : 'none',
              fontSize: isAgent ? '1.25rem' : '1rem',
            }}
          >
            {isAgent ? '🤖' : actor.name?.charAt(0).toUpperCase()}
          </Avatar>
          {isAgent && actor.verified && (
            <Box
              sx={{
                position: 'absolute',
                bottom: -2,
                right: -2,
                backgroundColor: theme.palette.background.paper,
                borderRadius: '50%',
                p: 0.25,
              }}
            >
              <VerifiedIcon sx={{ fontSize: 14, color: theme.palette.primary.main }} />
            </Box>
          )}
        </Box>

        {/* Content */}
        <Box sx={{ flex: 1, minWidth: 0 }}>
          {/* Actor info */}
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, mb: 0.5 }}>
            <Typography
              variant="subtitle2"
              fontWeight={600}
              sx={{ cursor: actor?.id ? 'pointer' : 'default' }}
              onClick={() => actor?.id && onActorClick?.(actor.id)}
            >
              {actor.name}
            </Typography>
            {isUnread && (
              <Box
                sx={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  backgroundColor: theme.palette.error.main,
                }}
              />
            )}
            {isUnread && (
              <Chip
                label="Unread"
                size="small"
                color="error"
                sx={{ height: 18, fontSize: '0.625rem', fontWeight: 700 }}
              />
            )}
            {isAgent && (
              <Chip
                label="Agent"
                size="small"
                sx={{
                  height: 18,
                  fontSize: '0.625rem',
                  fontWeight: 600,
                  backgroundColor: alpha(theme.palette.primary.main, 0.1),
                  color: theme.palette.primary.main,
                }}
              />
            )}
            {actionType.label && (
              <Typography variant="body2" color="text.secondary">
                {actionType.label}
              </Typography>
            )}
            {involves.length > 0 && (
              <>
                <Typography variant="body2" color="text.secondary">
                  with
                </Typography>
                {involves.slice(0, 2).map((p, i) => (
                  <Typography key={i} variant="body2" color="primary.main" fontWeight={500}>
                    @{p.name}
                  </Typography>
                ))}
              </>
            )}
            {pod && (
              <Chip
                label={pod.name}
                size="small"
                variant="outlined"
                sx={{ height: 18, fontSize: '0.625rem', ml: 0.5 }}
              />
            )}
            <Typography variant="caption" color="text.secondary" sx={{ ml: 'auto' }}>
              {formatTime(timestamp)}
            </Typography>
          </Box>

          {/* Main content */}
          {(content || preview) && (
            <Typography
              variant="body2"
              sx={{ color: 'text.primary', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}
            >
              {content || preview}
            </Typography>
          )}

          {/* Target card (for skills, links, etc.) */}
          {target && action === 'skill_created' && (
            <Box
              sx={{
                mt: 1.5,
                p: 1.5,
                borderRadius: 2,
                border: `1px solid ${alpha(theme.palette.secondary.main, 0.3)}`,
                backgroundColor: alpha(theme.palette.secondary.main, 0.05),
              }}
            >
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                <SkillIcon sx={{ color: theme.palette.secondary.main, fontSize: 20 }} />
                <Typography variant="subtitle2" fontWeight={600}>
                  {target.title || target.preview}
                </Typography>
              </Box>
              {target.description && (
                <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                  {target.description}
                </Typography>
              )}
              <Box sx={{ display: 'flex', gap: 1, mt: 1 }}>
                <Button size="small" variant="text">
                  View Skill
                </Button>
                <Button size="small" variant="text">
                  Add to Favorites
                </Button>
              </Box>
            </Box>
          )}

          {/* Approval request */}
          {action === 'approval_needed' && (
            <Box sx={{ mt: 1.5 }}>
              {activity.approval?.status === 'pending' ? (
                <Box sx={{ display: 'flex', gap: 1 }}>
                  <Button
                    size="small"
                    variant="contained"
                    color="success"
                    startIcon={<ApproveIcon />}
                    onClick={() => onApprove?.(activity)}
                  >
                    Approve
                  </Button>
                  <Button
                    size="small"
                    variant="outlined"
                    color="error"
                    startIcon={<RejectIcon />}
                    onClick={() => onReject?.(activity)}
                  >
                    Reject
                  </Button>
                </Box>
              ) : (
                <Chip
                  label={activity.approval?.status === 'approved' ? 'Approved' : 'Rejected'}
                  size="small"
                  color={activity.approval?.status === 'approved' ? 'success' : 'error'}
                  sx={{ fontWeight: 600 }}
                />
              )}
            </Box>
          )}

          {/* Agent metadata */}
          {isAgent && agentMetadata?.sources && agentMetadata.sources.length > 0 && (
            <Box sx={{ mt: 1, display: 'flex', gap: 0.5, flexWrap: 'wrap' }}>
              <Typography variant="caption" color="text.secondary">
                Sources:
              </Typography>
              {agentMetadata.sources.slice(0, 3).map((src, i) => (
                <Chip
                  key={i}
                  label={src.title || `Source ${i + 1}`}
                  size="small"
                  variant="outlined"
                  sx={{ height: 20, fontSize: '0.625rem' }}
                />
              ))}
            </Box>
          )}
        </Box>

        {/* Actions */}
        <IconButton size="small" sx={{ opacity: 0.5, '&:hover': { opacity: 1 } }}>
          <MoreIcon fontSize="small" />
        </IconButton>
      </Box>

      {/* Reactions & Reply bar */}
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 2,
          pt: 1,
          borderTop: `1px solid ${theme.palette.divider}`,
        }}
      >
        <Button
          size="small"
          startIcon={isLiked ? <LikeIcon /> : <LikeOutlinedIcon />}
          onClick={handleLike}
          sx={{ color: isLiked ? 'primary.main' : 'text.secondary', fontWeight: 500 }}
        >
          {(reactions.likes || 0) + (isLiked ? 1 : 0)}
        </Button>
        <Button
          size="small"
          startIcon={<ReplyIcon />}
          onClick={() => setShowReplies(!showReplies)}
          sx={{ color: 'text.secondary', fontWeight: 500 }}
        >
          {replyCount} {replyCount === 1 ? 'reply' : 'replies'}
        </Button>
        <Box sx={{ flex: 1 }} />
        {isAgent && (
          <Tooltip title="Pin this response">
            <IconButton size="small">
              <PinIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        )}
        {isUnread && (
          <Button
            size="small"
            onClick={() => onMarkRead?.(activity)}
            sx={{ color: 'text.secondary' }}
          >
            Mark read
          </Button>
        )}
      </Box>

      {/* Replies */}
      <Collapse in={showReplies && replies.length > 0}>
        <Box sx={{ mt: 2, pl: 4, borderLeft: `2px solid ${theme.palette.divider}` }}>
          {replies.map((reply, i) => (
            <Box key={i} sx={{ display: 'flex', gap: 1.5, mb: 1.5 }}>
              <Avatar
                sx={{
                  width: 32,
                  height: 32,
                  fontSize: '0.875rem',
                  borderRadius: reply.actor.type === 'agent' ? 1 : '50%',
                  backgroundColor:
                    reply.actor.type === 'agent'
                      ? alpha(theme.palette.primary.main, 0.1)
                      : theme.palette.grey[200],
                }}
              >
                {reply.actor.type === 'agent' ? '🤖' : reply.actor.name?.charAt(0)}
              </Avatar>
              <Box sx={{ flex: 1 }}>
                <Typography variant="caption" fontWeight={600}>
                  {reply.actor.name}
                </Typography>
                <Typography variant="body2">{reply.content}</Typography>
              </Box>
            </Box>
          ))}
        </Box>
      </Collapse>
    </Paper>
  );
};

interface ActivityFeedProps {
  activities?: Activity[];
  loading?: boolean;
  onLike?: (activity: Activity) => void;
  onReply?: (activity: Activity, content?: string) => void;
  onApprove?: (activity: Activity) => void;
  onReject?: (activity: Activity) => void;
  onMarkRead?: (activity: Activity) => void;
  onActorClick?: (actorId: string) => void;
  onLoadMore?: () => void;
  hasMore?: boolean;
  filter?: string;
}

// Main ActivityFeed component
const ActivityFeed: React.FC<ActivityFeedProps> = ({
  activities = [],
  loading = false,
  onLike,
  onReply,
  onApprove,
  onReject,
  onMarkRead,
  onActorClick,
  onLoadMore,
  hasMore = false,
  filter = 'all',
}) => {
  const filteredActivities = activities.filter((a) => {
    if (filter === 'all') return true;
    if (filter === 'humans') return a.actor.type === 'human';
    if (filter === 'agents') return a.actor.type === 'agent';
    if (filter === 'skills') return a.action === 'skill_created';
    return true;
  });

  if (loading && activities.length === 0) {
    return (
      <Box>
        {[1, 2, 3].map((i) => (
          <ActivityItemSkeleton key={i} />
        ))}
      </Box>
    );
  }

  if (filteredActivities.length === 0) {
    return (
      <Box sx={{ textAlign: 'center', py: 8, color: 'text.secondary' }}>
        <Typography variant="h6" gutterBottom>
          No activity yet
        </Typography>
        <Typography variant="body2">
          Start a conversation or add an agent to get things going!
        </Typography>
      </Box>
    );
  }

  return (
    <Box>
      {filteredActivities.map((activity) => (
        <ActivityItem
          key={activity.id}
          activity={activity}
          onLike={onLike}
          onReply={onReply}
          onApprove={onApprove}
          onReject={onReject}
          onMarkRead={onMarkRead}
          onActorClick={onActorClick}
        />
      ))}

      {hasMore && (
        <Box sx={{ textAlign: 'center', py: 2 }}>
          <Button onClick={onLoadMore} disabled={loading}>
            {loading ? 'Loading...' : 'Load more'}
          </Button>
        </Box>
      )}
    </Box>
  );
};

// Loading skeleton
const ActivityItemSkeleton: React.FC = () => (
  <Paper
    elevation={0}
    sx={{ p: 2, mb: 1.5, borderRadius: 3, border: '1px solid', borderColor: 'divider' }}
  >
    <Box sx={{ display: 'flex', gap: 1.5 }}>
      <Skeleton variant="circular" width={44} height={44} />
      <Box sx={{ flex: 1 }}>
        <Skeleton width={150} height={20} />
        <Skeleton width="100%" height={20} sx={{ mt: 1 }} />
        <Skeleton width="80%" height={20} />
      </Box>
    </Box>
    <Box sx={{ display: 'flex', gap: 2, mt: 2 }}>
      <Skeleton width={60} height={32} />
      <Skeleton width={80} height={32} />
    </Box>
  </Paper>
);

export default ActivityFeed;
