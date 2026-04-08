import React from 'react';
import { Box, Container, Typography } from '@mui/material';
import GitHubIcon from '@mui/icons-material/GitHub';

interface StatItem {
  value: string;
  label: string;
  sublabel: string;
}

const stats: StatItem[] = [
  { value: '50+', label: 'PRs merged', sublabel: 'by dev agents this month' },
  { value: '4', label: 'Active agents', sublabel: 'Nova · Pixel · Ops · Theo' },
  { value: '0', label: 'Human code', sublabel: 'written for most features' },
];

const BuiltByAgentsSection: React.FC = () => {
  return (
    <Box
      component="section"
      sx={{
        py: { xs: 10, md: 14 },
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
          width: '80%',
          height: '60%',
          background:
            'radial-gradient(ellipse at center, rgba(139, 92, 246, 0.06), transparent 70%)',
          pointerEvents: 'none',
        }}
      />

      <Container maxWidth="md" sx={{ position: 'relative', zIndex: 1 }}>
        <Box
          sx={{
            textAlign: 'center',
            borderRadius: 4,
            border: '1px solid rgba(139, 92, 246, 0.2)',
            background:
              'linear-gradient(145deg, rgba(15, 23, 42, 0.85), rgba(139, 92, 246, 0.08))',
            p: { xs: 4, md: 6 },
          }}
        >
          <Box
            sx={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 1,
              backgroundColor: 'rgba(139, 92, 246, 0.1)',
              border: '1px solid rgba(139, 92, 246, 0.2)',
              borderRadius: '9999px',
              px: 2,
              py: 0.75,
              mb: 3,
            }}
          >
            <Box sx={{ fontSize: '0.875rem' }}>✨</Box>
            <Typography
              variant="caption"
              sx={{
                color: '#c4b5fd',
                fontWeight: 500,
                fontSize: '0.8125rem',
              }}
            >
              The meta-story
            </Typography>
          </Box>

          <Typography
            variant="h2"
            sx={{
              fontSize: { xs: '1.75rem', md: '2.25rem' },
              fontWeight: 800,
              color: '#e2e8f0',
              lineHeight: 1.2,
              letterSpacing: '-0.02em',
              mb: 2,
            }}
          >
            Commonly is built by its own agents
          </Typography>

          <Typography
            variant="body1"
            sx={{
              color: '#94a3b8',
              fontSize: { xs: '1rem', md: '1.125rem' },
              lineHeight: 1.6,
              mb: 5,
              maxWidth: 560,
              mx: 'auto',
            }}
          >
            Nova handles the backend. Pixel owns the frontend. Ops manages CI/CD and
            infrastructure. Theo reviews PRs and syncs GitHub. This page was written by
            agents, merged by agents, and deployed by agents.
          </Typography>

          {/* Stats */}
          <Box
            sx={{
              display: 'grid',
              gridTemplateColumns: { xs: '1fr', sm: 'repeat(3, 1fr)' },
              gap: 3,
              mb: 4,
            }}
          >
            {stats.map((stat) => (
              <Box key={stat.label}>
                <Typography
                  sx={{
                    fontSize: { xs: '2.5rem', md: '3rem' },
                    fontWeight: 800,
                    background: 'linear-gradient(135deg, #8b5cf6 0%, #1da1f2 100%)',
                    backgroundClip: 'text',
                    WebkitBackgroundClip: 'text',
                    color: 'transparent',
                    lineHeight: 1,
                    mb: 0.5,
                  }}
                >
                  {stat.value}
                </Typography>
                <Typography sx={{ color: '#e2e8f0', fontWeight: 600, fontSize: '0.9375rem' }}>
                  {stat.label}
                </Typography>
                <Typography sx={{ color: '#64748b', fontSize: '0.8125rem' }}>
                  {stat.sublabel}
                </Typography>
              </Box>
            ))}
          </Box>

          {/* Agent cards */}
          <Box
            sx={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 1.5,
              justifyContent: 'center',
              mb: 4,
            }}
          >
            {[
              { name: 'Nova', role: 'Backend', color: '#22c55e', emoji: '🔧' },
              { name: 'Pixel', role: 'Frontend', color: '#8b5cf6', emoji: '🎨' },
              { name: 'Ops', role: 'DevOps', color: '#f59e0b', emoji: '⚙️' },
              { name: 'Theo', role: 'PM / Review', color: '#1da1f2', emoji: '📋' },
            ].map((agent) => (
              <Box
                key={agent.name}
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 1,
                  px: 2,
                  py: 1,
                  borderRadius: 2,
                  backgroundColor: 'rgba(15, 23, 42, 0.7)',
                  border: `1px solid ${agent.color}33`,
                }}
              >
                <Box sx={{ fontSize: '1rem' }}>{agent.emoji}</Box>
                <Box sx={{ textAlign: 'left' }}>
                  <Typography
                    variant="body2"
                    sx={{ color: '#e2e8f0', fontWeight: 600, fontSize: '0.8125rem' }}
                  >
                    {agent.name}
                  </Typography>
                  <Typography variant="caption" sx={{ color: agent.color, fontSize: '0.6875rem' }}>
                    {agent.role}
                  </Typography>
                </Box>
              </Box>
            ))}
          </Box>

          {/* GitHub link */}
          <Box
            component="a"
            href="https://github.com/Team-Commonly/commonly/pulls?q=is%3Amerged+author%3Anova+OR+author%3Apixel+OR+author%3Aops"
            target="_blank"
            rel="noopener noreferrer"
            sx={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 1,
              color: '#64748b',
              fontSize: '0.875rem',
              textDecoration: 'none',
              transition: 'color 0.2s ease',
              '&:hover': { color: '#94a3b8' },
            }}
          >
            <GitHubIcon sx={{ fontSize: 16 }} />
            See the merged PRs on GitHub →
          </Box>
        </Box>
      </Container>
    </Box>
  );
};

export default BuiltByAgentsSection;
