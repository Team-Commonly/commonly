import React from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Box,
  Button,
  Container,
  Divider,
  Stack,
  Typography,
} from '@mui/material';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import ArrowForwardIcon from '@mui/icons-material/ArrowForward';
import commonlyLogo from '../../assets/commonly-logo.png';

const USE_CASES = {
  'team-chat': {
    eyebrow: 'Team Chat',
    title: 'Move from scattered chat to shared pod memory',
    summary:
      'Run daily team communication in pods where decisions, context, and action items stay searchable and reusable.',
    problems: [
      'Context gets lost across channels and threads',
      'New teammates cannot reconstruct why decisions were made',
      'Important follow-ups disappear in high-volume chat',
    ],
    outcomes: [
      'Persistent, searchable pod timelines',
      'Agent mentions that pull relevant prior context',
      'Clear handoff between chat, posts, and activity feed',
    ],
  },
  'agent-collab': {
    eyebrow: 'Agent Collaboration',
    title: 'Deploy pod-native agents with explicit boundaries',
    summary:
      'Install multiple agents per pod with scoped permissions so each agent helps in the right place without leaking context.',
    problems: [
      'Single-assistant tools cannot model team boundaries',
      'Agent behavior is inconsistent across environments',
      'No central place to manage skills, runtime, and tool policy',
    ],
    outcomes: [
      'Agents Hub install and runtime controls',
      'Per-pod configuration, persona, and scope policies',
      'Structured event flow for mentions, summaries, and curation',
    ],
  },
  'daily-digest': {
    eyebrow: 'Daily Digest',
    title: 'Turn high-volume activity into actionable daily narrative',
    summary:
      'Use agent-driven summarization to convert chat, feed, and integration activity into focused daily digests.',
    problems: [
      'Too many updates to review manually',
      'Cross-tool status is fragmented across products',
      'Leaders lack a compact view of momentum and blockers',
    ],
    outcomes: [
      'Pod summaries persisted as reusable context assets',
      'Daily digest continuity across feed and message workflows',
      'Admin controls for refresh and runtime orchestration',
    ],
  },
  community: {
    eyebrow: 'Community Hub',
    title: 'Operate social and community workflows from one platform',
    summary:
      'Ingest external community signals, curate highlights, and trigger pod discussions from a unified social context pipeline.',
    problems: [
      'Signals are split across Discord, Slack, X, Instagram, and forums',
      'Teams cannot track trends and responses in one place',
      'Reposting and curation need governance controls',
    ],
    outcomes: [
      'Global social integrations with policy-aware publishing',
      'Curation loops that create feed activity and pod discussion',
      'Auditable agent actions for social operations',
    ],
  },
};

const UseCasePage = () => {
  const { useCaseId } = useParams();
  const navigate = useNavigate();
  const useCase = USE_CASES[useCaseId];

  if (!useCase) {
    return (
      <Box sx={{ minHeight: '100vh', backgroundColor: '#0b1220', color: '#e2e8f0', py: 10 }}>
        <Container maxWidth="md">
          <Button startIcon={<ArrowBackIcon />} onClick={() => navigate('/')}>
            Back to landing
          </Button>
          <Typography variant="h4" sx={{ mt: 3, mb: 1, fontWeight: 700 }}>
            Use case not found
          </Typography>
          <Typography color="#94a3b8">
            This page does not exist yet. Return to landing and choose another use case.
          </Typography>
        </Container>
      </Box>
    );
  }

  return (
    <Box sx={{ minHeight: '100vh', backgroundColor: '#0b1220', color: '#e2e8f0' }}>
      <Container maxWidth="lg" sx={{ pt: 5, pb: 10 }}>
        <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 6 }}>
          <Button startIcon={<ArrowBackIcon />} onClick={() => navigate('/')}>
            Back to landing
          </Button>
          <Stack direction="row" alignItems="center" spacing={1}>
            <img src={commonlyLogo} alt="Commonly Logo" width={26} height={26} />
            <Typography sx={{ fontWeight: 700, letterSpacing: '-0.02em' }}>Commonly</Typography>
          </Stack>
        </Stack>

        <Typography sx={{ color: '#7dd3fc', fontWeight: 700, letterSpacing: '0.08em', mb: 1 }}>
          {useCase.eyebrow.toUpperCase()}
        </Typography>
        <Typography
          variant="h2"
          sx={{ fontWeight: 800, lineHeight: 1.15, letterSpacing: '-0.03em', mb: 2, maxWidth: 920 }}
        >
          {useCase.title}
        </Typography>
        <Typography sx={{ color: '#94a3b8', fontSize: '1.125rem', lineHeight: 1.7, maxWidth: 820, mb: 5 }}>
          {useCase.summary}
        </Typography>

        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' },
            gap: 3,
            mb: 5,
          }}
        >
          <Box sx={{ p: 3, border: '1px solid rgba(148,163,184,0.16)', borderRadius: 3, background: 'rgba(15,23,42,0.55)' }}>
            <Typography sx={{ mb: 2, fontWeight: 700 }}>Commonly solves</Typography>
            <Stack spacing={1.25}>
              {useCase.problems.map((item) => (
                <Typography key={item} sx={{ color: '#cbd5e1' }}>
                  • {item}
                </Typography>
              ))}
            </Stack>
          </Box>
          <Box sx={{ p: 3, border: '1px solid rgba(125,211,252,0.28)', borderRadius: 3, background: 'rgba(14,116,144,0.16)' }}>
            <Typography sx={{ mb: 2, fontWeight: 700 }}>Expected outcomes</Typography>
            <Stack spacing={1.25}>
              {useCase.outcomes.map((item) => (
                <Typography key={item} sx={{ color: '#e0f2fe' }}>
                  • {item}
                </Typography>
              ))}
            </Stack>
          </Box>
        </Box>

        <Divider sx={{ borderColor: 'rgba(148,163,184,0.18)', mb: 4 }} />

        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
          <Button variant="contained" endIcon={<ArrowForwardIcon />} onClick={() => navigate('/register')}>
            Start with this use case
          </Button>
          <Button variant="outlined" onClick={() => navigate('/agents')}>
            Explore Agent Hub
          </Button>
        </Stack>
      </Container>
    </Box>
  );
};

export default UseCasePage;
