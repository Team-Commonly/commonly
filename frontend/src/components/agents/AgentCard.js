/**
 * AgentCard Component
 *
 * Social-style card for displaying an AI agent's profile.
 * Used in agent marketplace, installed agents list, and discovery.
 */

import React from 'react';
import {
  Card,
  CardContent,
  CardActions,
  Box,
  Typography,
  Avatar,
  Chip,
  Button,
  IconButton,
  Tooltip,
  Skeleton,
  alpha,
  useTheme,
} from '@mui/material';
import {
  VerifiedUser as VerifiedIcon,
  MoreVert as MoreIcon,
  TrendingUp as TrendingIcon,
  Memory as MemoryIcon,
  Chat as ChatIcon,
  Extension as ExtensionIcon,
} from '@mui/icons-material';
import { normalizeUploadUrl } from '../../utils/apiBaseUrl';

// Agent type colors
const agentTypeColors = {
  personal: '#8b5cf6',
  utility: '#06b6d4',
  analytics: '#ec4899',
  security: '#ef4444',
  productivity: '#22c55e',
  default: '#0d9488',
};

// Agent type icons
const agentTypeIcons = {
  personal: '🤖',
  utility: '🔧',
  analytics: '📊',
  security: '🔒',
  productivity: '⚡',
  default: '🤖',
};

const AgentCard = ({
  agent,
  variant = 'default', // 'default', 'compact', 'featured'
  installed = false,
  onInstall,
  onConfigure,
  onRemove,
  onMessage,
  onEdit,
  onViewProfile,
  canRemove = false,
  canConfigure = true,
  installedActionLabel = 'Configure',
  canEdit = false,
  loading = false,
}) => {
  const theme = useTheme();

  if (loading) {
    return <AgentCardSkeleton variant={variant} />;
  }

  // Handle both mock data and real API data formats
  const id = agent.id || agent._id || agent.name;
  const displayName = agent.displayName || agent.name || 'Unknown Agent';
  const agentName = agent.agentName || agent.name || '';
  const instanceId = agent.instanceId || agent.installation?.instanceId || agent.profile?.instanceId || '';
  const description = agent.description || '';
  const type = agent.type || (agent.categories && agent.categories[0]) || 'default';
  const verified = agent.verified || false;
  const installs = agent.installs || agent.stats?.installs || 0;
  const capabilities = agent.capabilities || agent.manifest?.capabilities?.map(c => c.name) || [];
  const stats = agent.stats || {};
  const iconUrl = agent.iconUrl || agent.profile?.iconUrl || agent.profile?.avatarUrl || null;
  const iconSrc = iconUrl ? normalizeUploadUrl(iconUrl) : undefined;

  const typeColor = agentTypeColors[type] || agentTypeColors.default;
  const typeIcon = agentTypeIcons[type] || agentTypeIcons.default;
  const cardBaseSx = {
    backgroundColor: 'rgba(15, 23, 42, 0.92)',
    border: '1px solid rgba(148, 163, 184, 0.18)',
    boxShadow: '0 10px 24px rgba(8, 12, 24, 0.4)',
    color: '#e2e8f0',
  };

  // Compact variant for sidebars and lists
  if (variant === 'compact') {
    return (
      <Card
        sx={{
          display: 'flex',
          alignItems: 'center',
          p: 1.5,
          cursor: 'pointer',
          ...cardBaseSx,
          '&:hover': {
            backgroundColor: 'rgba(30, 41, 59, 0.7)',
          },
        }}
        onClick={() => onViewProfile?.(agent)}
      >
        <Avatar
          sx={{
            width: 40,
            height: 40,
            backgroundColor: alpha(typeColor, 0.15),
            color: typeColor,
            fontSize: '1.25rem',
            mr: 1.5,
          }}
          src={iconSrc}
        >
          {typeIcon}
        </Avatar>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
            <Typography
              variant="body2"
              fontWeight={600}
              noWrap
              sx={{ maxWidth: 120 }}
            >
              {displayName}
            </Typography>
            {verified && (
              <VerifiedIcon
                sx={{ fontSize: 14, color: theme.palette.primary.main }}
              />
            )}
          </Box>
          <Typography variant="caption" color="text.secondary" noWrap>
            @{agentName}{instanceId ? ` • id:${instanceId}` : ''}
          </Typography>
        </Box>
        {installed && (
          <Chip
            label="Active"
            size="small"
            sx={{
              height: 20,
              fontSize: '0.6875rem',
              backgroundColor: alpha(theme.palette.success.main, 0.1),
              color: theme.palette.success.main,
            }}
          />
        )}
      </Card>
    );
  }

  // Featured variant for marketplace highlights
  if (variant === 'featured') {
    return (
      <Card
        sx={{
          position: 'relative',
          overflow: 'visible',
          background: `linear-gradient(135deg, rgba(15, 23, 42, 0.96) 0%, ${alpha(typeColor, 0.18)} 100%)`,
          border: `1px solid ${alpha(typeColor, 0.35)}`,
          boxShadow: '0 14px 32px rgba(8, 12, 24, 0.45)',
          '&:hover': {
            borderColor: alpha(typeColor, 0.4),
            boxShadow: `0 0 30px ${alpha(typeColor, 0.15)}`,
            transform: 'translateY(-4px)',
          },
          transition: 'all 0.3s ease',
        }}
      >
        {/* Trending badge */}
        <Box
          sx={{
            position: 'absolute',
            top: -10,
            right: 16,
            display: 'flex',
            alignItems: 'center',
            gap: 0.5,
            backgroundColor: theme.palette.secondary.main,
            color: '#0f172a',
            px: 1.5,
            py: 0.5,
            borderRadius: 2,
            fontSize: '0.75rem',
            fontWeight: 600,
            boxShadow: theme.shadows[2],
          }}
        >
          <TrendingIcon sx={{ fontSize: 14 }} />
          Trending
        </Box>

        <CardContent sx={{ pt: 3 }}>
          <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 2 }}>
            <Avatar
              sx={{
                width: 64,
                height: 64,
                backgroundColor: alpha(typeColor, 0.15),
                color: typeColor,
                fontSize: '2rem',
                boxShadow: `0 0 20px ${alpha(typeColor, 0.2)}`,
              }}
              src={iconSrc}
            >
              {typeIcon}
            </Avatar>
            <Box sx={{ flex: 1 }}>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}>
                <Typography variant="h6" fontWeight={700}>
                  {displayName}
                </Typography>
                {verified && (
                  <Tooltip title="Verified Agent">
                    <VerifiedIcon
                      sx={{ fontSize: 18, color: theme.palette.primary.main }}
                    />
                  </Tooltip>
                )}
              </Box>
          <Typography variant="body2" color="text.secondary">
            @{agentName}{instanceId ? ` • id:${instanceId}` : ''}
          </Typography>
            </Box>
          </Box>

          <Typography
            variant="body2"
            color="text.secondary"
            sx={{ mt: 2, mb: 2, lineHeight: 1.6 }}
          >
            {description}
          </Typography>

          {/* Capabilities */}
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75, mb: 2 }}>
            {capabilities.slice(0, 4).map((cap) => (
              <Chip
                key={cap}
                label={cap}
                size="small"
                sx={{
                  backgroundColor: alpha(typeColor, 0.1),
                  color: typeColor,
                  fontWeight: 500,
                  fontSize: '0.75rem',
                  borderColor: alpha(typeColor, 0.3),
                }}
              />
            ))}
          </Box>

          {/* Installs row */}
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              pt: 2,
              borderTop: `1px solid ${theme.palette.divider}`,
            }}
          >
            <Typography variant="body2" color="text.secondary">
              {installs.toLocaleString()} installs
            </Typography>
          </Box>
        </CardContent>

        <CardActions sx={{ px: 2, pb: 2.5, pt: 1, alignItems: 'center' }}>
          {installed ? (
            <>
              <Button
                variant="outlined"
                size="small"
                startIcon={<ChatIcon />}
                onClick={() => onMessage?.(agent)}
                sx={{ minHeight: 36 }}
              >
                Message
              </Button>
              <Button
                variant="outlined"
                size="small"
                disabled={!canConfigure}
                onClick={() => onConfigure?.(agent)}
                sx={{ flex: 1, minHeight: 36 }}
              >
                {installedActionLabel}
              </Button>
              {canRemove && (
                <Button
                  variant="text"
                  size="small"
                  color="error"
                  onClick={() => onRemove?.(agent)}
                  sx={{ minHeight: 36 }}
                >
                  Remove
                </Button>
              )}
            </>
          ) : (
            <Button
              variant="contained"
              fullWidth
              onClick={() => onInstall?.(agent)}
              sx={{
                background: `linear-gradient(135deg, ${typeColor} 0%, ${alpha(typeColor, 0.8)} 100%)`,
                '&:hover': {
                  background: `linear-gradient(135deg, ${alpha(typeColor, 0.9)} 0%, ${typeColor} 100%)`,
                },
                minHeight: 38,
              }}
            >
              Install Agent
            </Button>
          )}
        </CardActions>
      </Card>
    );
  }

  // Default variant
  return (
    <Card
      sx={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        ...cardBaseSx,
        '&:hover': {
          transform: 'translateY(-2px)',
          boxShadow: '0 16px 32px rgba(8, 12, 24, 0.55)',
        },
        transition: 'all 0.2s ease',
      }}
    >
      <CardContent sx={{ flex: 1 }}>
        <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1.5, mb: 2 }}>
          <Avatar
            sx={{
              width: 48,
              height: 48,
              backgroundColor: alpha(typeColor, 0.15),
              color: typeColor,
              fontSize: '1.5rem',
            }}
            src={iconSrc}
          >
            {typeIcon}
          </Avatar>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
              <Typography variant="subtitle1" fontWeight={600} noWrap>
                {displayName}
              </Typography>
              {verified && (
                <VerifiedIcon
                  sx={{ fontSize: 16, color: theme.palette.primary.main }}
                />
              )}
            </Box>
            <Typography variant="caption" color="text.secondary">
              @{agentName}{instanceId ? ` • id:${instanceId}` : ''}
            </Typography>
          </Box>
          <IconButton size="small">
            <MoreIcon fontSize="small" />
          </IconButton>
        </Box>

        <Typography
          variant="body2"
          color="text.secondary"
          sx={{
            mb: 2,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
          }}
        >
          {description}
        </Typography>

        {/* Mini stats */}
        <Box sx={{ display: 'flex', gap: 2, mb: 2 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
            <MemoryIcon sx={{ fontSize: 14, color: 'text.secondary' }} />
            <Typography variant="caption" color="text.secondary">
              {stats.podsJoined || 0} pods
            </Typography>
          </Box>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
            <ChatIcon sx={{ fontSize: 14, color: 'text.secondary' }} />
            <Typography variant="caption" color="text.secondary">
              {(stats.messagesProcessed || 0).toLocaleString()} msgs
            </Typography>
          </Box>
        </Box>

        {/* Capabilities chips */}
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
          {capabilities.slice(0, 3).map((cap) => (
            <Chip
              key={cap}
              label={cap}
              size="small"
              variant="outlined"
              sx={{
                fontSize: '0.6875rem',
                borderColor: 'rgba(148, 163, 184, 0.35)',
                color: '#cbd5f5',
              }}
            />
          ))}
          {capabilities.length > 3 && (
            <Chip
              label={`+${capabilities.length - 3}`}
              size="small"
              variant="outlined"
              sx={{
                fontSize: '0.6875rem',
                borderColor: 'rgba(148, 163, 184, 0.35)',
                color: '#cbd5f5',
              }}
            />
          )}
        </Box>
      </CardContent>

      <CardActions
        sx={{
          px: 2,
          pb: 2.5,
          pt: 1,
          borderTop: '1px solid rgba(148, 163, 184, 0.18)',
          alignItems: 'center',
          justifyContent: 'flex-end',
          gap: 1,
        }}
      >
        {installed ? (
          <>
            <Button
              size="small"
              startIcon={<ChatIcon />}
              onClick={() => onMessage?.(agent)}
              sx={{ minHeight: 34 }}
            >
              Message
            </Button>
            <Button
              size="small"
              disabled={!canConfigure}
              onClick={() => onConfigure?.(agent)}
              sx={{ minHeight: 34 }}
            >
              {installedActionLabel}
            </Button>
            {canRemove && (
              <Button size="small" color="error" onClick={() => onRemove?.(agent)} sx={{ minHeight: 34 }}>
                Remove
              </Button>
            )}
          </>
        ) : (
          <>
            {canEdit && (
              <Button size="small" onClick={() => onEdit?.(agent)} sx={{ minHeight: 34 }}>
                Edit
              </Button>
            )}
            <Button
              size="small"
              variant="contained"
              onClick={() => onInstall?.(agent)}
              sx={{ minHeight: 34 }}
            >
              Install
            </Button>
          </>
        )}
      </CardActions>
    </Card>
  );
};

// Loading skeleton
const AgentCardSkeleton = ({ variant }) => {
  if (variant === 'compact') {
    return (
      <Card
        sx={{
          display: 'flex',
          alignItems: 'center',
          p: 1.5,
          backgroundColor: 'rgba(15, 23, 42, 0.92)',
          border: '1px solid rgba(148, 163, 184, 0.18)',
        }}
      >
        <Skeleton variant="circular" width={40} height={40} sx={{ mr: 1.5 }} />
        <Box sx={{ flex: 1 }}>
          <Skeleton width={100} height={20} />
          <Skeleton width={60} height={16} />
        </Box>
      </Card>
    );
  }

  return (
    <Card
      sx={{
        height: '100%',
        backgroundColor: 'rgba(15, 23, 42, 0.92)',
        border: '1px solid rgba(148, 163, 184, 0.18)',
      }}
    >
      <CardContent>
        <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1.5, mb: 2 }}>
          <Skeleton variant="circular" width={48} height={48} />
          <Box sx={{ flex: 1 }}>
            <Skeleton width={120} height={24} />
            <Skeleton width={80} height={16} />
          </Box>
        </Box>
        <Skeleton width="100%" height={20} />
        <Skeleton width="80%" height={20} sx={{ mb: 2 }} />
        <Box sx={{ display: 'flex', gap: 1 }}>
          <Skeleton variant="rounded" width={60} height={24} />
          <Skeleton variant="rounded" width={60} height={24} />
          <Skeleton variant="rounded" width={60} height={24} />
        </Box>
      </CardContent>
      <CardActions sx={{ px: 2, pb: 2 }}>
        <Skeleton width={80} height={32} />
        <Box sx={{ flex: 1 }} />
        <Skeleton variant="rounded" width={80} height={32} />
      </CardActions>
    </Card>
  );
};

export default AgentCard;
