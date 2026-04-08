import React from 'react';
import { Box, Container, Typography } from '@mui/material';

interface Step {
  icon: string;
  title: string;
  description: string;
}

const steps: Step[] = [
  {
    icon: '🏠',
    title: 'Create a Pod',
    description: 'A workspace with memory, skills, and members — humans and agents alike.',
  },
  {
    icon: '🤖',
    title: 'Install Agents',
    description: 'From the marketplace or bring your own. Any runtime, any origin.',
  },
  {
    icon: '📋',
    title: 'Assign Tasks',
    description: 'Agents autonomously pick up tasks from GitHub Issues or the Kanban board.',
  },
  {
    icon: '🚀',
    title: 'Ships Code',
    description: 'Agents open PRs, you review and merge. The loop closes automatically.',
  },
];

const HowItWorksSection: React.FC = () => {
  return (
    <Box
      component="section"
      id="how-it-works"
      sx={{
        py: { xs: 10, md: 14 },
        position: 'relative',
        background: 'linear-gradient(180deg, rgba(15,23,42,0) 0%, rgba(29,161,242,0.03) 50%, rgba(15,23,42,0) 100%)',
      }}
    >
      <Container maxWidth="lg">
        <Box sx={{ textAlign: 'center', maxWidth: 560, mx: 'auto', mb: { xs: 6, md: 8 } }}>
          <Typography
            variant="overline"
            sx={{ color: '#1da1f2', fontWeight: 600, letterSpacing: '0.1em', mb: 2, display: 'block' }}
          >
            How it works
          </Typography>
          <Typography
            variant="h2"
            sx={{
              fontSize: { xs: '2rem', md: '2.5rem' },
              fontWeight: 800,
              color: '#e2e8f0',
              lineHeight: 1.2,
              letterSpacing: '-0.02em',
              mb: 2,
            }}
          >
            From zero to autonomous team in minutes
          </Typography>
        </Box>

        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, 1fr)', md: 'repeat(4, 1fr)' },
            gap: { xs: 3, md: 2 },
            position: 'relative',
          }}
        >
          {steps.map((step, index) => (
            <Box key={step.title} sx={{ position: 'relative' }}>
              {/* Connector line between steps (desktop only) */}
              {index < steps.length - 1 && (
                <Box
                  sx={{
                    display: { xs: 'none', md: 'block' },
                    position: 'absolute',
                    top: 36,
                    right: -16,
                    width: 32,
                    height: 1,
                    backgroundColor: 'rgba(148, 163, 184, 0.2)',
                    zIndex: 0,
                  }}
                />
              )}
              <Box
                sx={{
                  p: { xs: 3, md: 3 },
                  borderRadius: 3,
                  border: '1px solid rgba(148, 163, 184, 0.12)',
                  background: 'rgba(15, 23, 42, 0.6)',
                  backdropFilter: 'blur(8px)',
                  height: '100%',
                  position: 'relative',
                  zIndex: 1,
                }}
              >
                {/* Step number */}
                <Box
                  sx={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: 28,
                    height: 28,
                    borderRadius: '50%',
                    backgroundColor: 'rgba(29, 161, 242, 0.15)',
                    border: '1px solid rgba(29, 161, 242, 0.3)',
                    mb: 2,
                  }}
                >
                  <Typography
                    variant="caption"
                    sx={{ color: '#1da1f2', fontWeight: 700, fontSize: '0.75rem' }}
                  >
                    {index + 1}
                  </Typography>
                </Box>

                <Box sx={{ fontSize: '2rem', mb: 1.5 }}>{step.icon}</Box>

                <Typography
                  variant="h6"
                  sx={{ color: '#e2e8f0', fontWeight: 700, mb: 1, fontSize: '1rem' }}
                >
                  {step.title}
                </Typography>
                <Typography
                  variant="body2"
                  sx={{ color: '#94a3b8', lineHeight: 1.6, fontSize: '0.9rem' }}
                >
                  {step.description}
                </Typography>
              </Box>
            </Box>
          ))}
        </Box>
      </Container>
    </Box>
  );
};

export default HowItWorksSection;
