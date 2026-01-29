/**
 * AppCard Component
 *
 * Marketplace card for Commonly Apps (webhooks, integrations, agent apps).
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
  Rating,
  Skeleton,
  alpha,
  useTheme,
} from '@mui/material';
import {
  SmartToy as AgentIcon,
  Extension as IntegrationIcon,
  Link as WebhookIcon,
  Apps as AppsIcon,
  VerifiedUser as VerifiedIcon,
} from '@mui/icons-material';

const typeIcons = {
  agent: AgentIcon,
  integration: IntegrationIcon,
  webhook: WebhookIcon,
  default: AppsIcon,
};

const typeColors = {
  agent: '#0d9488',
  integration: '#5865F2',
  webhook: '#f59e0b',
  default: '#1d9bf0',
};

const AppCard = ({
  app,
  installed = false,
  onInstall,
  onRemove,
  loading = false,
  showScopes = false,
}) => {
  const theme = useTheme();

  if (loading) {
    return (
      <Card>
        <CardContent>
          <Box sx={{ display: 'flex', gap: 2, mb: 2 }}>
            <Skeleton variant="circular" width={56} height={56} />
            <Box sx={{ flex: 1 }}>
              <Skeleton height={22} width="70%" />
              <Skeleton height={18} width="50%" />
            </Box>
          </Box>
          <Skeleton height={16} width="90%" />
          <Skeleton height={16} width="75%" />
        </CardContent>
      </Card>
    );
  }

  const id = app.id || app._id || app.name;
  const displayName = app.displayName || app.name || 'Unknown App';
  const appName = app.name || '';
  const description = app.description || '';
  const type = app.type || 'default';
  const verified = app.verified || false;
  const rating = app.rating || 0;
  const ratingCount = app.ratingCount || 0;
  const installs = app.installs || 0;
  const category = app.category || 'other';
  const scopes = app.scopes || [];
  const logo = app.logo || app.avatar || null;

  const Icon = typeIcons[type] || typeIcons.default;
  const accent = typeColors[type] || typeColors.default;

  return (
    <Card
      sx={{
        borderRadius: 3,
        border: `1px solid ${alpha(accent, 0.18)}`,
        boxShadow: 'none',
        transition: 'transform 0.2s ease, box-shadow 0.2s ease',
        '&:hover': {
          transform: 'translateY(-2px)',
          boxShadow: `0 6px 18px ${alpha(accent, 0.15)}`,
        },
      }}
    >
      <CardContent>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 2 }}>
          <Avatar
            src={logo || undefined}
            sx={{
              width: 56,
              height: 56,
              backgroundColor: alpha(accent, 0.12),
              color: accent,
              fontSize: '1.5rem',
              fontWeight: 700,
            }}
          >
            {!logo && <Icon />}
          </Avatar>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <Typography variant="h6" fontWeight={700} noWrap>
                {displayName}
              </Typography>
              {verified && (
                <VerifiedIcon sx={{ fontSize: 18, color: theme.palette.primary.main }} />
              )}
            </Box>
            <Typography variant="body2" color="text.secondary" noWrap>
              @{appName}
            </Typography>
          </Box>
          {installed && (
            <Chip
              label="Installed"
              size="small"
              sx={{
                backgroundColor: alpha(theme.palette.success.main, 0.12),
                color: theme.palette.success.main,
                fontWeight: 600,
              }}
            />
          )}
        </Box>

        <Typography variant="body2" color="text.secondary" sx={{ mb: 2, minHeight: 40 }}>
          {description || 'No description provided.'}
        </Typography>

        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75, mb: 2 }}>
          <Chip label={type} size="small" sx={{ fontWeight: 600 }} />
          <Chip label={category} size="small" variant="outlined" />
        </Box>

        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
            <Rating value={rating} precision={0.1} size="small" readOnly />
            <Typography variant="caption" color="text.secondary">
              {ratingCount ? `(${ratingCount})` : 'No ratings'}
            </Typography>
          </Box>
          <Typography variant="caption" color="text.secondary">
            {installs} installs
          </Typography>
        </Box>

        {showScopes && scopes.length > 0 && (
          <Box sx={{ mt: 2, display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
            {scopes.slice(0, 4).map((scope) => (
              <Chip key={scope} label={scope} size="small" variant="outlined" />
            ))}
          </Box>
        )}
      </CardContent>
      <CardActions sx={{ px: 2, pb: 2 }}>
        {installed ? (
          <Button
            size="small"
            variant="outlined"
            color="error"
            onClick={() => onRemove?.(app)}
          >
            Remove
          </Button>
        ) : (
          <Button
            size="small"
            variant="contained"
            onClick={() => onInstall?.(app)}
          >
            Install
          </Button>
        )}
      </CardActions>
    </Card>
  );
};

export default AppCard;
