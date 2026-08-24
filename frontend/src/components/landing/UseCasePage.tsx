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
import useCases from '../../content/use-cases.json';

interface UseCase {
  eyebrow: string;
  title: string;
  summary: string;
  problems: string[];
  outcomes: string[];
  exampleFlow: string[];
  relatedGuides?: Array<{ title: string; path: string }>;
}

const USE_CASES = useCases as Record<string, UseCase>;

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

        {useCase.relatedGuides && useCase.relatedGuides.length > 0 && (
          <Box sx={{ p: 3, border: '1px solid rgba(125,211,252,0.28)', borderRadius: 3, background: 'rgba(14,116,144,0.16)', mb: 5 }}>
            <Typography sx={{ mb: 1.5, fontWeight: 700 }}>Related guides</Typography>
            <Stack spacing={1} alignItems="flex-start">
              {useCase.relatedGuides.map((guide) => (
                <Button key={guide.path} variant="text" onClick={() => navigate(guide.path)}>{guide.title}</Button>
              ))}
            </Stack>
          </Box>
        )}

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
