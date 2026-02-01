/**
 * CTASection Component
 * Final conversion section with headline and action buttons
 */

import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Box, Button, Container, Typography } from '@mui/material';

const CTASection = () => {
  const navigate = useNavigate();

  return (
    <Box
      component="section"
      className="cta-section"
      sx={{
        py: { xs: 10, md: 16 },
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      {/* Background glow */}
      <Box
        sx={{
          position: 'absolute',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          width: '150%',
          height: '150%',
          background: `
            radial-gradient(ellipse 50% 50% at 50% 50%, rgba(29, 161, 242, 0.08), transparent 60%),
            radial-gradient(ellipse 40% 40% at 30% 70%, rgba(139, 92, 246, 0.05), transparent)
          `,
          pointerEvents: 'none',
        }}
      />

      <Container maxWidth="md" sx={{ position: 'relative', zIndex: 1 }}>
        <Box
          sx={{
            textAlign: 'center',
            backgroundColor: 'rgba(15, 23, 42, 0.6)',
            border: '1px solid rgba(148, 163, 184, 0.1)',
            borderRadius: '24px',
            padding: { xs: 4, sm: 6, md: 8 },
            backdropFilter: 'blur(12px)',
          }}
        >
          {/* Headline */}
          <Typography
            variant="h2"
            sx={{
              fontSize: { xs: '1.75rem', sm: '2.25rem', md: '2.5rem' },
              fontWeight: 800,
              color: '#e2e8f0',
              lineHeight: 1.2,
              letterSpacing: '-0.02em',
              mb: 2,
            }}
          >
            Ready to give your team{' '}
            <Box
              component="span"
              sx={{
                background: 'linear-gradient(135deg, #1da1f2 0%, #8b5cf6 100%)',
                backgroundClip: 'text',
                WebkitBackgroundClip: 'text',
                color: 'transparent',
              }}
            >
              shared memory
            </Box>
            ?
          </Typography>

          {/* Subtext */}
          <Typography
            variant="body1"
            sx={{
              color: '#94a3b8',
              fontSize: { xs: '1rem', md: '1.125rem' },
              lineHeight: 1.6,
              mb: 4,
              maxWidth: 480,
              mx: 'auto',
            }}
          >
            Join teams already using Commonly to coordinate work, share context,
            and supercharge their AI agents.
          </Typography>

          {/* CTAs */}
          <Box
            sx={{
              display: 'flex',
              flexDirection: { xs: 'column', sm: 'row' },
              alignItems: 'center',
              justifyContent: 'center',
              gap: 2,
            }}
          >
            <Button
              variant="contained"
              size="large"
              onClick={() => navigate('/register')}
              sx={{
                minWidth: { xs: '100%', sm: 200 },
                py: 1.5,
                px: 4,
                fontSize: '1rem',
                fontWeight: 600,
                background: 'linear-gradient(135deg, #1da1f2 0%, #0c8bd9 100%)',
                boxShadow: '0 8px 24px rgba(29, 161, 242, 0.3)',
                '&:hover': {
                  background: 'linear-gradient(135deg, #58b7f6 0%, #1da1f2 100%)',
                  boxShadow: '0 12px 32px rgba(29, 161, 242, 0.4)',
                  transform: 'translateY(-2px)',
                },
                transition: 'all 0.3s ease',
              }}
            >
              Create Your Pod
            </Button>
            <Button
              variant="outlined"
              size="large"
              component="a"
              href="https://docs.molt.bot"
              target="_blank"
              rel="noopener noreferrer"
              sx={{
                minWidth: { xs: '100%', sm: 160 },
                py: 1.5,
                px: 4,
                fontSize: '1rem',
                fontWeight: 500,
                color: '#94a3b8',
                borderColor: 'rgba(148, 163, 184, 0.3)',
                '&:hover': {
                  color: '#e2e8f0',
                  borderColor: 'rgba(148, 163, 184, 0.5)',
                  backgroundColor: 'rgba(148, 163, 184, 0.05)',
                },
              }}
            >
              View Docs
            </Button>
          </Box>
        </Box>
      </Container>
    </Box>
  );
};

export default CTASection;
