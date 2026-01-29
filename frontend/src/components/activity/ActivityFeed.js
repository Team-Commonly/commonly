/**
 * ActivityFeed Component
 *
 * Unified activity feed showing both human and AI agent interactions.
 * The core social experience of Commonly.
 */

import React, { useState, useEffect, useRef } from 'react';
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
  Divider,
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

// Participant type styling
const participantStyles = {
  human: {
    avatarShape: 'circular',
    badgeIcon: null,
    glowColor: null,
  },
  agent: {
    avatarShape: 'rounded',
    badgeIcon: AgentIcon,
    glowColor: (theme) => theme.palette.primary.main,
  },
  system: {
    avatarShape: 'rounded',
    badgeIcon: null,
    glowColor: null,
  },
};

// Activity type icons and colors
const activityTypes = {
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
};

// Single activity item
const ActivityItem = ({ activity, onLike, onReply, onApprove, onReject }) => {
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
  } = activity;

  const isAgent = actor.type === 'agent';
  const style = participantStyles[actor.type] || participantStyles.human;
  const actionType = activityTypes[action] || activityTypes.message;

  const formatTime = (ts) => {
    const date = new Date(ts);
    const now = new Date();
    const diff = (now - date) / 1000;

    if (diff < 60) return 'now';
    if (diff < 3600) return `${Math.floor(diff / 60)}m`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
    return date.toLocaleDateString();
  };

  const handleLike = () => {
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
        border: `1px solid ${theme.palette.divider}`,
        transition: 'all 0.2s ease',
        '&:hover': {
          borderColor: theme.palette.grey[300],
          backgroundColor: alpha(theme.palette.primary.main, 0.02),
        },
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
              <VerifiedIcon
                sx={{ fontSize: 14, color: theme.palette.primary.main }}
              />
            </Box>
          )}
        </Box>

        {/* Content */}
        <Box sx={{ flex: 1, minWidth: 0 }}>
          {/* Actor info */}
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, mb: 0.5 }}>
            <Typography variant="subtitle2" fontWeight={600}>
              {actor.name}
            </Typography>
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
                sx={{
                  height: 18,
                  fontSize: '0.625rem',
                  ml: 0.5,
                }}
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
              sx={{
                color: 'text.primary',
                lineHeight: 1.6,
                whiteSpace: 'pre-wrap',
              }}
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
          {isAgent && agentMetadata?.sources?.length > 0 && (
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
          sx={{
            color: isLiked ? 'primary.main' : 'text.secondary',
            fontWeight: 500,
          }}
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

// Main ActivityFeed component
const ActivityFeed = ({
  activities = [],
  loading = false,
  onLike,
  onReply,
  onApprove,
  onReject,
  onLoadMore,
  hasMore = false,
  filter = 'all', // 'all', 'humans', 'agents', 'skills'
}) => {
  const theme = useTheme();

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
      <Box
        sx={{
          textAlign: 'center',
          py: 8,
          color: 'text.secondary',
        }}
      >
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
const ActivityItemSkeleton = () => (
  <Paper elevation={0} sx={{ p: 2, mb: 1.5, borderRadius: 3, border: '1px solid', borderColor: 'divider' }}>
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
