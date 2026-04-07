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

interface UseCase {
  eyebrow: string;
  title: string;
  summary: string;
  problems: string[];
  outcomes: string[];
  exampleFlow: string[];
}

const USE_CASES: Record<string, UseCase> = {
  'team-chat': {
    eyebrow: 'Team Chat',
    title: 'Run pod conversations with searchable shared context',
    summary:
      'Use pods, feed categories, and activity summaries together so your team builds a self-growing knowledge base from daily collaboration.',
    problems: [
      'Important updates get split between chat, posts, and side channels',
      'Teams lose track of decisions when conversations move quickly',
      'Follow-ups are easy to miss without a shared activity stream',
    ],
    outcomes: [
      'Pod chat and feed workflows in one place',
      'Agent mentions in chat and threads for faster context lookups',
      'Hourly summaries and activity views that accumulate reusable knowledge',
    ],
    exampleFlow: [
      'You post a planning update in pod chat.',
      'A teammate mentions an agent to pull last week\u2019s related summary.',
      'The decision is captured in-thread and appears in your next digest.',
    ],
  },
  'agent-collab': {
    eyebrow: 'Agent Collaboration',
    title: 'Orchestrate secure, customizable multi-agent workflows',
    summary:
      'Use Agent Hub to create templates, deploy agent instances to pods, and connect containerized or self-hosted agents with scoped access.',
    problems: [
      'Teams need more than one assistant with different responsibilities',
      'Runtime setup and configuration often lives outside daily workflows',
      'Security and publish guardrails are hard to enforce across many agent runtimes',
    ],
    outcomes: [
      'Discover, Presets, Installed, and Admin tabs in Agent Hub',
      'Create/edit template-based agents and install them per pod',
      'Runtime tokens + scoped integration permissions for controlled access',
      'Support OpenClaw plus external/self-hosted CLI-style agents via secure agent APIs',
    ],
    exampleFlow: [
      'You install a coding partner agent to one pod and a curator agent to another.',
      'Each agent gets scoped runtime access based on pod needs.',
      'Agents respond in-context without mixing identities or permissions.',
    ],
  },
  'daily-digest': {
    eyebrow: 'Daily Digest',
    title: 'Convert noisy activity into digestible updates',
    summary:
      'Generate AI digests from recent activity, review history, and track digest analytics in one workflow.',
    problems: [
      'Too many updates to review manually',
      'Teams need a quick readout before jumping into detailed threads',
      'It is difficult to maintain continuity across daily check-ins',
    ],
    outcomes: [
      'Latest, History, and Generate digest controls',
      'Structured highlights, notable moments, and key insights',
      'Digest analytics for activity volume and trend visibility',
    ],
    exampleFlow: [
      'Messages and social updates accumulate through the day.',
      'You generate a digest before standup or check-in.',
      'Everyone starts with the same concise context and clear action points.',
    ],
  },
  community: {
    eyebrow: 'Integrations',
    title: 'Operate one social feed across connected apps',
    summary:
      'Connect official providers, aggregate external social activity into Commonly feeds, and coordinate team response from one workspace.',
    problems: [
      'Community signals are spread across multiple provider dashboards',
      'Manual copying between channels and internal discussion is slow',
      'External publishing needs clear policy controls',
    ],
    outcomes: [
      'Official integration cards for Discord, Slack, Telegram, GroupMe, X, and Instagram',
      'Global social feed configuration for X and Instagram ingestion',
      'Policy controls for external publishing behavior and attribution',
    ],
    exampleFlow: [
      'Connected social feeds bring external posts into Commonly.',
      'Your team curates and discusses what matters in one pod.',
      'Publishing follows admin guardrails and attribution policy.',
    ],
  },
  'pod-browser': {
    eyebrow: 'Pod Browser',
    title: 'Find the right room before entering chat',
    summary:
      'Browse pods by category, preview room details, and jump into conversations with Open Chat from a single index view.',
    problems: [
      'Users waste time jumping into the wrong room',
      'Teams need a quick view of joined vs discoverable pods',
      'Unread activity is easy to miss without room-level indicators',
    ],
    outcomes: [
      'Category routes for Chat, Study, Games, and Ensemble pods',
      'All, Joined, and Discover filters for faster room triage',
      'Room cards with membership counts, badges, and direct Open Chat actions',
    ],
    exampleFlow: [
      'A new member opens pod browser and checks Discover.',
      'They preview room type and activity before joining.',
      'Open Chat drops them into the right space with context ready.',
    ],
  },
  'app-marketplace': {
    eyebrow: 'App Marketplace',
    title: 'Install official apps and discover advanced connectors',
    summary:
      'Use the Apps marketplace to connect official integrations, review capability tags, and discover optional advanced connectors.',
    problems: [
      'Teams cannot easily see which providers are officially supported',
      'Setup paths are unclear when integrations live in different admin screens',
      'Advanced connector discovery is fragmented without a shared catalog view',
    ],
    outcomes: [
      'Official Marketplace cards for Discord, Slack, Telegram, GroupMe, X, and Instagram',
      'Connect in Pod calls-to-action with direct docs links',
      'Advanced connector preview block with setup requirements made explicit',
    ],
    exampleFlow: [
      'You open Apps marketplace and select the provider your pod needs.',
      'Connect in Pod links setup directly to pod context.',
      'You add optional advanced connectors for specialized workflows later.',
    ],
  },
};

const UseCasePage: React.FC = () => {
  const { useCaseId } = useParams<{ useCaseId: string }>();
  const navigate = useNavigate();
  const useCase = useCaseId ? USE_CASES[useCaseId] : undefined;

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

        <Box
          sx={{
            p: 3,
            border: '1px solid rgba(148,163,184,0.18)',
            borderRadius: 3,
            background: 'rgba(15,23,42,0.48)',
            mb: 5,
          }}
        >
          <Typography sx={{ mb: 1.5, fontWeight: 700 }}>
            Example flow
          </Typography>
          <Stack spacing={1.1}>
            {useCase.exampleFlow.map((step, index) => (
              <Typography key={step} sx={{ color: '#cbd5e1' }}>
                {index + 1}. {step}
              </Typography>
            ))}
          </Stack>
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
