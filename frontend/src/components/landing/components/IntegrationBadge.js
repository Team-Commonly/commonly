/**
 * IntegrationBadge Component
 * Platform badge with glow effect for integrations section
 */

import React from 'react';
import { Box, Typography, alpha } from '@mui/material';

const IntegrationBadge = ({ name, color, icon: Icon }) => {
  return (
    <Box
      className="integration-badge"
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 1.5,
        backgroundColor: 'rgba(15, 23, 42, 0.8)',
        border: '1px solid rgba(148, 163, 184, 0.15)',
        borderRadius: '12px',
        padding: '12px 20px',
        transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
        cursor: 'default',
        '&:hover': {
          borderColor: alpha(color, 0.5),
          boxShadow: `0 0 24px ${alpha(color, 0.25)}, 0 8px 24px rgba(8, 12, 24, 0.3)`,
          transform: 'translateY(-2px)',
          '& .integration-icon': {
            color: color,
            transform: 'scale(1.1)',
          },
          '& .integration-name': {
            color: '#e2e8f0',
          },
        },
      }}
    >
      <Icon
        className="integration-icon"
        sx={{
          fontSize: 24,
          color: '#94a3b8',
          transition: 'all 0.3s ease',
        }}
      />
      <Typography
        className="integration-name"
        variant="body2"
        sx={{
          fontWeight: 500,
          color: '#94a3b8',
          transition: 'color 0.3s ease',
        }}
      >
        {name}
      </Typography>
    </Box>
  );
};

export default IntegrationBadge;
