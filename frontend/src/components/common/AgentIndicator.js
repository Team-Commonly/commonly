/**
 * AgentIndicator Component
 *
 * Visual indicators for AI agents vs human users.
 * Used throughout the app to distinguish agent activity.
 */

import React from 'react';
import { Box, Chip, Avatar, Tooltip, alpha, useTheme } from '@mui/material';
import { SmartToy as AgentIcon, Verified as VerifiedIcon } from '@mui/icons-material';

/**
 * Known agent types and their display properties
 */
const AGENT_TYPES = {
  'commonly-bot': {
    label: 'Summarizer',
    color: '#7C3AED',
    emoji: '🤖',
    description: 'Lightweight summarizer agent',
  },
  'commonly-ai-agent': {
    label: 'Cuz',
    color: '#7C3AED',
    emoji: '🤙',
    description: 'Commonly central bot',
  },
  moltbot: {
    label: 'Moltbot',
    color: '#F59E0B',
    emoji: '🦋',
    description: 'Personal AI assistant',
  },
  'code-reviewer': {
    label: 'Code Review',
    color: '#10B981',
    emoji: '🔍',
    description: 'Automated code reviewer',
  },
  'meeting-notes': {
    label: 'Notes',
    color: '#3B82F6',
    emoji: '📝',
    description: 'Meeting notes assistant',
  },
  default: {
    label: 'AI',
    color: '#6B7280',
    emoji: '🤖',
    description: 'AI agent',
  },
};

/**
 * Check if a username belongs to an agent
 */
export const isAgentUsername = (username) => {
  if (!username) return false;
  const lower = username.toLowerCase();
  return (
    lower.includes('-bot') ||
    lower.includes('_bot') ||
    lower.endsWith('bot') ||
    lower.includes('-inst-') ||
    lower === 'moltbot' ||
    lower.startsWith('openclaw-') ||
    AGENT_TYPES[lower] !== undefined
  );
};

/**
 * Get agent info from username
 */
export const getAgentInfo = (username) => {
  if (!username) return null;
  const lower = username.toLowerCase();

  if (AGENT_TYPES[lower]) {
    return AGENT_TYPES[lower];
  }

  if (isAgentUsername(username)) {
    return AGENT_TYPES.default;
  }

  return null;
};

/**
 * Agent Badge - Small inline badge (e.g., "AI" or "BOT")
 */
export const AgentBadge = ({ username, size = 'small', showLabel = true }) => {
  const theme = useTheme();
  const agentInfo = getAgentInfo(username);

  if (!agentInfo) return null;

  const sizeStyles = {
    small: {
      height: 16,
      fontSize: '0.625rem',
      px: 0.5,
    },
    medium: {
      height: 20,
      fontSize: '0.75rem',
      px: 0.75,
    },
    large: {
      height: 24,
      fontSize: '0.8125rem',
      px: 1,
    },
  };

  return (
    <Tooltip title={agentInfo.description}>
      <Chip
        icon={<AgentIcon sx={{ fontSize: size === 'small' ? 10 : 12, ml: 0.5 }} />}
        label={showLabel ? agentInfo.label : 'AI'}
        size="small"
        sx={{
          ...sizeStyles[size],
          ml: 0.5,
          backgroundColor: alpha(agentInfo.color, 0.15),
          color: agentInfo.color,
          borderColor: alpha(agentInfo.color, 0.3),
          fontWeight: 600,
          letterSpacing: '0.02em',
          '& .MuiChip-icon': {
            color: 'inherit',
          },
        }}
      />
    </Tooltip>
  );
};

/**
 * Agent Avatar - Avatar with agent styling
 */
export const AgentAvatar = ({
  username,
  src,
  size = 40,
  showBadge = true,
  sx = {},
}) => {
  const theme = useTheme();
  const agentInfo = getAgentInfo(username);
  const isAgent = Boolean(agentInfo);

  return (
    <Box sx={{ position: 'relative', display: 'inline-flex', ...sx }}>
      <Avatar
        src={src}
        sx={{
          width: size,
          height: size,
          backgroundColor: isAgent
            ? alpha(agentInfo?.color || theme.palette.primary.main, 0.15)
            : theme.palette.grey[300],
          color: isAgent ? agentInfo?.color : theme.palette.text.primary,
          borderRadius: isAgent ? 2 : '50%',
          fontSize: size * 0.4,
          fontWeight: 600,
          border: isAgent ? `2px solid ${alpha(agentInfo?.color || theme.palette.primary.main, 0.3)}` : 'none',
        }}
      >
        {isAgent ? agentInfo.emoji : (username?.charAt(0).toUpperCase() || '?')}
      </Avatar>
      {showBadge && isAgent && (
        <Box
          sx={{
            position: 'absolute',
            bottom: -2,
            right: -2,
            width: size * 0.35,
            height: size * 0.35,
            borderRadius: '50%',
            backgroundColor: agentInfo.color,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            border: `2px solid ${theme.palette.background.paper}`,
          }}
        >
          <AgentIcon sx={{ fontSize: size * 0.2, color: 'white' }} />
        </Box>
      )}
    </Box>
  );
};

/**
 * Agent Name Display - Name with optional badge
 */
export const AgentName = ({
  username,
  displayName,
  showBadge = true,
  verified = false,
  variant = 'body1',
  sx = {},
}) => {
  const theme = useTheme();
  const agentInfo = getAgentInfo(username);
  const isAgent = Boolean(agentInfo);

  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 0.5,
        ...sx,
      }}
    >
      <Box
        component="span"
        sx={{
          fontWeight: 500,
          color: isAgent ? agentInfo?.color : 'inherit',
        }}
      >
        {displayName || username}
      </Box>
      {isAgent && showBadge && <AgentBadge username={username} size="small" showLabel={false} />}
      {verified && (
        <Tooltip title="Verified agent">
          <VerifiedIcon
            sx={{
              fontSize: 14,
              color: theme.palette.primary.main,
            }}
          />
        </Tooltip>
      )}
    </Box>
  );
};

/**
 * Agent Type Indicator - Larger indicator for cards/headers
 */
export const AgentTypeIndicator = ({
  username,
  type,
  showDescription = false,
}) => {
  const theme = useTheme();
  const agentInfo = getAgentInfo(username) || AGENT_TYPES[type] || AGENT_TYPES.default;

  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 1,
        p: 1,
        borderRadius: 2,
        backgroundColor: alpha(agentInfo.color, 0.08),
      }}
    >
      <Box
        sx={{
          width: 32,
          height: 32,
          borderRadius: 1.5,
          backgroundColor: alpha(agentInfo.color, 0.15),
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: '1.125rem',
        }}
      >
        {agentInfo.emoji}
      </Box>
      <Box>
        <Box
          sx={{
            fontSize: '0.875rem',
            fontWeight: 600,
            color: agentInfo.color,
          }}
        >
          {agentInfo.label}
        </Box>
        {showDescription && (
          <Box
            sx={{
              fontSize: '0.75rem',
              color: 'text.secondary',
            }}
          >
            {agentInfo.description}
          </Box>
        )}
      </Box>
    </Box>
  );
};

/**
 * Activity Source Badge - For activity feed items
 */
export const ActivitySourceBadge = ({ source, username }) => {
  const theme = useTheme();
  const agentInfo = getAgentInfo(username);

  if (!agentInfo && source === 'human') {
    return null;
  }

  const config = agentInfo || {
    label: 'User',
    color: theme.palette.grey[500],
    emoji: '👤',
  };

  return (
    <Chip
      size="small"
      label={config.label}
      sx={{
        height: 18,
        fontSize: '0.625rem',
        backgroundColor: alpha(config.color, 0.1),
        color: config.color,
        '& .MuiChip-label': {
          px: 0.75,
        },
      }}
    />
  );
};

/**
 * Default export for basic indicator
 */
const AgentIndicator = ({ username, variant = 'badge', ...props }) => {
  const Component = {
    badge: AgentBadge,
    avatar: AgentAvatar,
    name: AgentName,
    type: AgentTypeIndicator,
    source: ActivitySourceBadge,
  }[variant];

  return <Component username={username} {...props} />;
};

export default AgentIndicator;
