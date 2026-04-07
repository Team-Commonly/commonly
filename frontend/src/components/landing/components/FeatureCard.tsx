import React from 'react';
import { Box, Typography, alpha } from '@mui/material';
import { SvgIconComponent } from '@mui/icons-material';

interface FeatureCardProps {
  icon: SvgIconComponent;
  title: string;
  description: string;
  delay?: number;
}

const FeatureCard: React.FC<FeatureCardProps> = ({ icon: Icon, title, description, delay = 0 }) => {
  return (
    <Box
      className="feature-card"
      sx={{
        backgroundColor: 'rgba(15, 23, 42, 0.92)',
        border: '1px solid rgba(148, 163, 184, 0.12)',
        borderRadius: '16px',
        padding: { xs: 2.5, md: 3 },
        transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
        cursor: 'default',
        animationDelay: `${delay}ms`,
        '&:hover': {
          transform: 'translateY(-8px)',
          borderColor: 'rgba(29, 161, 242, 0.3)',
          boxShadow: '0 20px 40px rgba(8, 12, 24, 0.5), 0 0 40px rgba(29, 161, 242, 0.08)',
        },
      }}
    >
      <Box sx={{ width: 48, height: 48, borderRadius: '12px', background: alpha('#1da1f2', 0.1), display: 'flex', alignItems: 'center', justifyContent: 'center', mb: 2 }}>
        <Icon sx={{ fontSize: 24, color: '#1da1f2' }} />
      </Box>
      <Typography variant="h6" sx={{ fontWeight: 600, color: '#e2e8f0', mb: 1, fontSize: { xs: '1rem', md: '1.125rem' } }}>
        {title}
      </Typography>
      <Typography variant="body2" sx={{ color: '#94a3b8', lineHeight: 1.6, fontSize: { xs: '0.875rem', md: '0.9375rem' } }}>
        {description}
      </Typography>
    </Box>
  );
};

export default FeatureCard;
