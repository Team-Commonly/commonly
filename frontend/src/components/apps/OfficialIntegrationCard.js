/**
 * OfficialIntegrationCard
 *
 * Card for official marketplace listings (built-in integrations).
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
  Stack,
  alpha,
  useTheme,
} from '@mui/material';
import { Link as LinkIcon } from '@mui/icons-material';

const OfficialIntegrationCard = ({
  entry,
  onConnect,
  actionLabel,
  actionDisabled = false,
}) => {
  const theme = useTheme();
  const accent = entry.accentColor || theme.palette.primary.main;
  const isMonochromeLogo = Boolean(entry.logoUrl && entry.logoUrl.includes('simple-icons'));
  const avatarBackground = isMonochromeLogo ? accent : alpha(accent, 0.12);
  const avatarForeground = theme.palette.getContrastText(avatarBackground);
  const isMcpApp = entry.type === 'mcp-app';
  const typeLabel = isMcpApp ? 'MCP App' : entry.type || 'integration';
  const primaryLabel = actionLabel || (isMcpApp ? 'MCP Host Required' : 'Connect in Pod');

  return (
    <Card
      sx={{
        height: '100%',
        borderRadius: 3,
        border: `1px solid ${alpha(accent, 0.18)}`,
        background: `linear-gradient(135deg, ${alpha(accent, 0.08)} 0%, ${alpha(accent, 0.02)} 100%)`,
        boxShadow: 'none',
        '&:hover': {
          borderColor: alpha(accent, 0.35),
          boxShadow: `0 10px 24px ${alpha(accent, 0.18)}`,
          transform: 'translateY(-2px)',
        },
        transition: 'all 0.2s ease',
      }}
    >
      <CardContent>
        <Stack spacing={2}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
            <Avatar
              src={entry.logoUrl || undefined}
              variant="rounded"
              sx={{
                width: 56,
                height: 56,
                backgroundColor: avatarBackground,
                border: `1px solid ${alpha(accent, 0.25)}`,
                borderRadius: 2,
                color: avatarForeground,
                '& img': {
                  objectFit: 'contain',
                  padding: 1,
                  filter: isMonochromeLogo ? 'brightness(0) invert(1)' : 'none',
                },
              }}
            >
              {entry.name?.[0] || 'C'}
            </Avatar>
            <Box sx={{ flex: 1 }}>
              <Typography variant="h6" sx={{ fontWeight: 700 }}>
                {entry.name}
              </Typography>
              <Typography variant="body2" color="text.secondary">
                {entry.description}
              </Typography>
            </Box>
          </Box>

          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75 }}>
            <Chip label={typeLabel} size="small" />
            {entry.category && <Chip label={entry.category} size="small" variant="outlined" />}
            {isMcpApp && (
              <Chip label="Host required" size="small" variant="outlined" />
            )}
            {typeof entry.activeCount === 'number' && (
              <Chip label={`${entry.activeCount} active`} size="small" variant="outlined" />
            )}
          </Box>

          {entry.capabilities?.length > 0 && (
            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75 }}>
              {entry.capabilities.slice(0, 4).map((capability) => (
                <Chip key={`${entry.id}-${capability}`} label={capability} size="small" />
              ))}
            </Box>
          )}
        </Stack>
      </CardContent>
      <CardActions sx={{ px: 2, pb: 2, gap: 1 }}>
        <Button
          variant="contained"
          onClick={() => onConnect?.(entry)}
          disabled={actionDisabled}
        >
          {primaryLabel}
        </Button>
        {entry.docsUrl && (
          <Button
            variant="text"
            href={entry.docsUrl}
            target="_blank"
            rel="noreferrer"
            startIcon={<LinkIcon />}
          >
            Docs
          </Button>
        )}
      </CardActions>
    </Card>
  );
};

export default OfficialIntegrationCard;
