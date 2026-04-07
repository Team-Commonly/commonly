import React from 'react';
import { Box, Chip, Avatar, Tooltip, alpha, useTheme } from '@mui/material';
import { SmartToy as AgentIcon, Verified as VerifiedIcon } from '@mui/icons-material';
import { SxProps, Theme } from '@mui/material/styles';

interface AgentTypeInfo {
  label: string;
  color: string;
  emoji: string;
  description: string;
}

const AGENT_TYPES: Record<string, AgentTypeInfo> = {
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

export const isAgentUsername = (username: string | null | undefined): boolean => {
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

export const getAgentInfo = (username: string | null | undefined): AgentTypeInfo | null => {
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

interface AgentBadgeProps {
  username?: string | null;
  size?: 'small' | 'medium' | 'large';
  showLabel?: boolean;
}

export const AgentBadge: React.FC<AgentBadgeProps> = ({ username, size = 'small', showLabel = true }) => {
  useTheme();
  const agentInfo = getAgentInfo(username);

  if (!agentInfo) return null;

  const sizeStyles: Record<string, object> = {
    small: { height: 16, fontSize: '0.625rem', px: 0.5 },
    medium: { height: 20, fontSize: '0.75rem', px: 0.75 },
    large: { height: 24, fontSize: '0.8125rem', px: 1 },
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
          '& .MuiChip-icon': { color: 'inherit' },
        }}
      />
    </Tooltip>
  );
};

interface AgentAvatarProps {
  username?: string | null;
  src?: string;
  size?: number;
  showBadge?: boolean;
  sx?: SxProps<Theme>;
}

export const AgentAvatar: React.FC<AgentAvatarProps> = ({
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
        {isAgent ? agentInfo!.emoji : (username?.charAt(0).toUpperCase() || '?')}
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
            backgroundColor: agentInfo!.color,
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

interface AgentNameProps {
  username?: string | null;
  displayName?: string | null;
  showBadge?: boolean;
  verified?: boolean;
  variant?: string;
  sx?: SxProps<Theme>;
}

export const AgentName: React.FC<AgentNameProps> = ({
  username,
  displayName,
  showBadge = true,
  verified = false,
  sx = {},
}) => {
  const theme = useTheme();
  const agentInfo = getAgentInfo(username);
  const isAgent = Boolean(agentInfo);

  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, ...sx }}>
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
          <VerifiedIcon sx={{ fontSize: 14, color: theme.palette.primary.main }} />
        </Tooltip>
      )}
    </Box>
  );
};

interface AgentTypeIndicatorProps {
  username?: string | null;
  type?: string;
  showDescription?: boolean;
}

export const AgentTypeIndicator: React.FC<AgentTypeIndicatorProps> = ({
  username,
  type,
  showDescription = false,
}) => {
  useTheme();
  const agentInfo = getAgentInfo(username) || (type ? AGENT_TYPES[type] : null) || AGENT_TYPES.default;

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
        <Box sx={{ fontSize: '0.875rem', fontWeight: 600, color: agentInfo.color }}>
          {agentInfo.label}
        </Box>
        {showDescription && (
          <Box sx={{ fontSize: '0.75rem', color: 'text.secondary' }}>
            {agentInfo.description}
          </Box>
        )}
      </Box>
    </Box>
  );
};

interface ActivitySourceBadgeProps {
  source?: string;
  username?: string | null;
}

export const ActivitySourceBadge: React.FC<ActivitySourceBadgeProps> = ({ source, username }) => {
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
        '& .MuiChip-label': { px: 0.75 },
      }}
    />
  );
};

interface AgentIndicatorProps extends Record<string, unknown> {
  username?: string | null;
  variant?: 'badge' | 'avatar' | 'name' | 'type' | 'source';
}

const AgentIndicator: React.FC<AgentIndicatorProps> = ({ username, variant = 'badge', ...props }) => {
  const variantMap: Record<string, React.FC<Record<string, unknown>>> = {
    badge: AgentBadge as React.FC<Record<string, unknown>>,
    avatar: AgentAvatar as React.FC<Record<string, unknown>>,
    name: AgentName as React.FC<Record<string, unknown>>,
    type: AgentTypeIndicator as React.FC<Record<string, unknown>>,
    source: ActivitySourceBadge as React.FC<Record<string, unknown>>,
  };
  const Component = variantMap[variant];
  return <Component username={username} {...props} />;
};

export default AgentIndicator;
