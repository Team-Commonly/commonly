import React from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Box,
  Button,
  Container,
  Stack,
  Typography,
} from '@mui/material';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import ArrowForwardIcon from '@mui/icons-material/ArrowForward';
import commonlyLogo from '../../assets/commonly-logo.png';
import guides from '../../content/guides.json';

interface Guide {
  eyebrow: string;
  title: string;
  summary: string;
}

const GUIDES = guides as Record<string, Guide>;

const GuidesIndexPage: React.FC = () => {
  const navigate = useNavigate();

  return (
    <Box sx={{ minHeight: '100vh', backgroundColor: '#0b1220', color: '#e2e8f0' }}>
      <Container maxWidth="md" sx={{ pt: 5, pb: 10 }}>
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
          GUIDES
        </Typography>
        <Typography component="h1" variant="h2" sx={{ fontWeight: 800, lineHeight: 1.15, letterSpacing: '-0.03em', mb: 2 }}>
          Guides for teams working with AI agents
        </Typography>
        <Typography sx={{ color: '#94a3b8', fontSize: '1.125rem', lineHeight: 1.7, mb: 6 }}>
          Practical explanations of the shared context, ownership, and handoffs that help people and AI agents work together on real projects.
        </Typography>

        <Stack spacing={3}>
          {Object.entries(GUIDES).map(([id, guide]) => (
            <Box key={id} component="article" sx={{ p: { xs: 3, sm: 4 }, border: '1px solid rgba(148,163,184,0.18)', borderRadius: 3 }}>
              <Typography sx={{ color: '#7dd3fc', fontWeight: 700, letterSpacing: '0.08em', mb: 1 }}>
                {guide.eyebrow.toUpperCase()}
              </Typography>
              <Typography component="h2" variant="h4" sx={{ fontWeight: 750, lineHeight: 1.2, mb: 1.5 }}>
                {guide.title}
              </Typography>
              <Typography sx={{ color: '#cbd5e1', lineHeight: 1.75, mb: 2.5 }}>
                {guide.summary}
              </Typography>
              <Button endIcon={<ArrowForwardIcon />} onClick={() => navigate(`/guides/${id}/`)}>
                Read the guide
              </Button>
            </Box>
          ))}
        </Stack>
      </Container>
    </Box>
  );
};

export default GuidesIndexPage;
