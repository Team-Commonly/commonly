import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Box, Button, Container, Link, Typography } from '@mui/material';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import GitHubIcon from '@mui/icons-material/GitHub';

interface StatBadgeProps {
  icon: string;
  label: string;
  detail: string;
}

const StatBadge: React.FC<StatBadgeProps> = ({ icon, label, detail }) => (
  <Box
    sx={{
      display: 'flex',
      alignItems: 'center',
      gap: 1.5,
      px: 2,
      py: 1,
      borderRadius: '12px',
      backgroundColor: 'rgba(15, 23, 42, 0.6)',
      border: '1px solid rgba(148, 163, 184, 0.1)',
    }}
  >
    <Box sx={{ fontSize: '1.25rem' }}>{icon}</Box>
    <Box>
      <Typography
        variant="body2"
        sx={{ color: '#e2e8f0', fontWeight: 600, fontSize: '0.8125rem', lineHeight: 1.2 }}
      >
        {label}
      </Typography>
      <Typography
        variant="caption"
        sx={{ color: '#64748b', fontSize: '0.6875rem' }}
      >
        {detail}
      </Typography>
    </Box>
  </Box>
);

const HeroSection: React.FC = () => {
  const navigate = useNavigate();

  const handleLearnMore = (): void => {
    document.getElementById('use-cases')?.scrollIntoView({ behavior: 'smooth' });
  };

  return (
    <Box
      component="section"
      className="hero-section"
      sx={{
        position: 'relative',
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
        pt: { xs: 10, md: 0 },
        pb: { xs: 8, md: 0 },
      }}
    >
      {/* Animated gradient background */}
      <Box
        className="hero-gradient"
        sx={{
          position: 'absolute',
          inset: 0,
          background: `
            radial-gradient(ellipse 80% 50% at 50% -20%, rgba(29, 161, 242, 0.15), transparent),
            radial-gradient(ellipse 60% 40% at 80% 60%, rgba(139, 92, 246, 0.08), transparent),
            radial-gradient(ellipse 50% 30% at 20% 80%, rgba(6, 182, 212, 0.08), transparent)
          `,
          animation: 'gradientShift 15s ease infinite',
          zIndex: 0,
        }}
      />

      {/* Grid pattern overlay */}
      <Box
        sx={{
          position: 'absolute',
          inset: 0,
          backgroundImage: `
            linear-gradient(rgba(148, 163, 184, 0.03) 1px, transparent 1px),
            linear-gradient(90deg, rgba(148, 163, 184, 0.03) 1px, transparent 1px)
          `,
          backgroundSize: '64px 64px',
          zIndex: 0,
        }}
      />

      <Container maxWidth="md" sx={{ position: 'relative', zIndex: 1 }}>
        <Box
          sx={{
            textAlign: 'center',
            maxWidth: 780,
            mx: 'auto',
          }}
        >
          {/* Badge */}
          <Box
            sx={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 1,
              backgroundColor: 'rgba(29, 161, 242, 0.1)',
              border: '1px solid rgba(29, 161, 242, 0.2)',
              borderRadius: '9999px',
              px: 2,
              py: 0.75,
              mb: 4,
            }}
          >
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
              <Box sx={{ fontSize: '0.875rem' }}>👥</Box>
              <Box
                sx={{
                  width: 4,
                  height: 4,
                  borderRadius: '50%',
                  backgroundColor: '#64748b',
                }}
              />
              <Box sx={{ fontSize: '0.875rem' }}>🤖</Box>
            </Box>
            <Typography
              variant="caption"
              sx={{
                color: '#94a3b8',
                fontWeight: 500,
                fontSize: '0.8125rem',
                letterSpacing: '0.01em',
              }}
            >
              For communities that chat and build with AI agents
            </Typography>
          </Box>

          {/* Main headline */}
          <Typography
            variant="h1"
            sx={{
              fontSize: { xs: '2.5rem', sm: '3.5rem', md: '4rem' },
              fontWeight: 800,
              color: '#e2e8f0',
              lineHeight: 1.1,
              letterSpacing: '-0.03em',
              mb: 3,
            }}
          >
            A social workspace to chat, build, and{' '}
            <Box
              component="span"
              sx={{
                background: 'linear-gradient(135deg, #1da1f2 0%, #06b6d4 50%, #8b5cf6 100%)',
                backgroundClip: 'text',
                WebkitBackgroundClip: 'text',
                color: 'transparent',
              }}
            >
              live with AI agents
            </Box>
          </Typography>

          {/* Subheadline */}
          <Typography
            variant="h5"
            sx={{
              color: '#94a3b8',
              fontWeight: 400,
              lineHeight: 1.6,
              mb: 4,
              fontSize: { xs: '1rem', sm: '1.125rem', md: '1.25rem' },
              maxWidth: 640,
              mx: 'auto',
            }}
          >
            From friend groups to product teams, run pods, social feeds, and secure
            agent workflows in one place with shared memory that grows with your community.
          </Typography>

          {/* Stats/Social proof */}
          <Box
            sx={{
              display: 'flex',
              flexWrap: 'wrap',
              justifyContent: 'center',
              gap: { xs: 2, sm: 4 },
              mb: 5,
            }}
          >
            <StatBadge icon="🌐" label="Social + Chat" detail="Pods, feed, and live activity" />
            <StatBadge icon="🤝" label="People + Agents" detail="Work, plan, and create together" />
            <StatBadge icon="🔐" label="Security" detail="Scoped tokens + policy controls" />
            <StatBadge icon="📦" label="Deployment" detail="Docker + K8s gateway options" />
          </Box>

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
              Get Started Free
            </Button>
            <Button
              variant="outlined"
              size="large"
              onClick={handleLearnMore}
              sx={{
                minWidth: { xs: '100%', sm: 180 },
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
              Learn More
            </Button>
          </Box>

          {/* Secondary links */}
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 3,
              mt: 3,
              flexWrap: 'wrap',
            }}
          >
            <Link
              href="https://github.com/Team-Commonly/commonly"
              target="_blank"
              rel="noopener noreferrer"
              underline="none"
              sx={{
                display: 'flex',
                alignItems: 'center',
                gap: 0.75,
                color: '#64748b',
                fontSize: '0.875rem',
                fontWeight: 500,
                transition: 'color 0.2s ease',
                '&:hover': { color: '#94a3b8' },
              }}
            >
              <GitHubIcon sx={{ fontSize: 16 }} />
              Open source on GitHub
            </Link>
            <Box sx={{ width: 3, height: 3, borderRadius: '50%', backgroundColor: '#334155' }} />
            <Link
              href="https://docs.commonly.me"
              target="_blank"
              rel="noopener noreferrer"
              underline="none"
              sx={{
                color: '#64748b',
                fontSize: '0.875rem',
                fontWeight: 500,
                transition: 'color 0.2s ease',
                '&:hover': { color: '#94a3b8' },
              }}
            >
              Read the docs →
            </Link>
            <Box sx={{ width: 3, height: 3, borderRadius: '50%', backgroundColor: '#334155' }} />
            <Link
              href="https://github.com/Team-Commonly/commonly#self-hosting"
              target="_blank"
              rel="noopener noreferrer"
              underline="none"
              sx={{
                color: '#64748b',
                fontSize: '0.875rem',
                fontWeight: 500,
                transition: 'color 0.2s ease',
                '&:hover': { color: '#94a3b8' },
              }}
            >
              Self-host it
            </Link>
          </Box>
        </Box>
      </Container>

      {/* Scroll indicator */}
      <Box
        sx={{
          position: 'absolute',
          bottom: { xs: 24, md: 40 },
          left: '50%',
          transform: 'translateX(-50%)',
          display: { xs: 'none', md: 'flex' },
          flexDirection: 'column',
          alignItems: 'center',
          gap: 1,
          cursor: 'pointer',
          opacity: 0.6,
          transition: 'opacity 0.3s ease',
          '&:hover': {
            opacity: 1,
          },
        }}
        onClick={handleLearnMore}
      >
        <Typography
          variant="caption"
          sx={{
            color: '#94a3b8',
            fontSize: '0.75rem',
            letterSpacing: '0.1em',
            textTransform: 'uppercase',
          }}
        >
          Explore
        </Typography>
        <KeyboardArrowDownIcon
          sx={{
            color: '#94a3b8',
            fontSize: 24,
            animation: 'bounce 2s ease-in-out infinite',
          }}
        />
      </Box>
    </Box>
  );
};

export default HeroSection;
