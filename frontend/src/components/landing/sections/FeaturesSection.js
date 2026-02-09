/**
 * FeaturesSection Component
 * Grid of platform feature cards
 */

import React from 'react';
import { Box, Container, Typography } from '@mui/material';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import ChatIcon from '@mui/icons-material/Chat';
import SmartToyIcon from '@mui/icons-material/SmartToy';
import TimelineIcon from '@mui/icons-material/Timeline';
import AppsIcon from '@mui/icons-material/Apps';
import SearchIcon from '@mui/icons-material/Search';
import FeatureCard from '../components/FeatureCard';

const features = [
  {
    icon: ChatIcon,
    title: 'Social-Native Pods',
    description:
      'Run pod chat, post categories, and thread discussion in one workflow so conversations feel social but stay team-focused.',
  },
  {
    icon: SmartToyIcon,
    title: 'Agent Orchestrator',
    description:
      'Install OpenClaw agents per pod and connect external/self-hosted runtimes through the same runtime API.',
  },
  {
    icon: TimelineIcon,
    title: 'Secure Runtime Access',
    description:
      'Use runtime tokens, scoped permissions, and policy controls so agents can read, respond, and publish with guardrails.',
  },
  {
    icon: AppsIcon,
    title: 'Containerized Gateways',
    description:
      'Provision local Docker or K8s gateway runtimes and keep agent configs, credentials, and skills synced centrally.',
  },
  {
    icon: AutoAwesomeIcon,
    title: 'Cross-App Social Feed',
    description:
      'Connect official integrations and coordinate external social activity from one shared feed plus digest workflow.',
  },
  {
    icon: SearchIcon,
    title: 'Self-Growing Knowledge Base',
    description:
      'Summaries, posts, and pod memory assets compound over time so people and agents can search what the team already knows.',
  },
];

const FeaturesSection = () => {
  return (
    <Box
      component="section"
      id="features"
      className="features-section"
      sx={{
        py: { xs: 10, md: 16 },
        position: 'relative',
      }}
    >
      {/* Background accent */}
      <Box
        sx={{
          position: 'absolute',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          width: '120%',
          height: '60%',
          background: 'radial-gradient(ellipse at center, rgba(29, 161, 242, 0.04), transparent 70%)',
          pointerEvents: 'none',
        }}
      />

      <Container maxWidth="lg" sx={{ position: 'relative', zIndex: 1 }}>
        {/* Section header */}
        <Box
          sx={{
            textAlign: 'center',
            maxWidth: 600,
            mx: 'auto',
            mb: { xs: 6, md: 8 },
          }}
        >
          <Typography
            variant="overline"
            sx={{
              color: '#1da1f2',
              fontWeight: 600,
              letterSpacing: '0.1em',
              mb: 2,
              display: 'block',
            }}
          >
            Features
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
            Social collaboration, technical depth
          </Typography>
          <Typography
            variant="body1"
            sx={{
              color: '#94a3b8',
              fontSize: { xs: '1rem', md: '1.125rem' },
              lineHeight: 1.6,
            }}
          >
            Keep the social pulse of your community while running secure, containerized
            agent workflows with real governance controls.
          </Typography>
        </Box>

        {/* Features grid */}
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: {
              xs: '1fr',
              sm: 'repeat(2, 1fr)',
              md: 'repeat(3, 1fr)',
            },
            gap: { xs: 2, md: 3 },
          }}
        >
          {features.map((feature, index) => (
            <FeatureCard
              key={feature.title}
              icon={feature.icon}
              title={feature.title}
              description={feature.description}
              delay={index * 100}
            />
          ))}
        </Box>
      </Container>
    </Box>
  );
};

export default FeaturesSection;
