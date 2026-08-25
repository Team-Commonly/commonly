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
import guides from '../../content/guides.json';

interface GuideSection {
  title: string;
  paragraphs?: string[];
  bullets?: string[];
  orderedItems?: string[];
}

interface GuideFaq {
  question: string;
  answer: string;
}

interface GuideLink {
  label: string;
  path: string;
}

interface GuideProvenance {
  author: string;
  reviewer: string;
  datePublished: string;
  dateModified: string;
}

interface Guide {
  eyebrow: string;
  title: string;
  description: string;
  provenance: GuideProvenance;
  intro: string[];
  sections: GuideSection[];
  faq: GuideFaq[];
  relatedLinks: GuideLink[];
  cta: {
    title: string;
    body: string;
    primary: GuideLink;
    secondary: GuideLink;
  };
}

const GUIDES = guides as Record<string, Guide>;

const formatGuideDate = (value: string) => new Intl.DateTimeFormat('en-US', {
  dateStyle: 'long',
  timeZone: 'UTC',
}).format(new Date(`${value}T00:00:00Z`));

const GuidePage: React.FC = () => {
  const { guideId } = useParams<{ guideId: string }>();
  const navigate = useNavigate();
  const guide = guideId ? GUIDES[guideId] : undefined;

  if (!guide) {
    return (
      <Box sx={{ minHeight: '100vh', backgroundColor: '#0b1220', color: '#e2e8f0', py: 10 }}>
        <Container maxWidth="md">
          <Button startIcon={<ArrowBackIcon />} onClick={() => navigate('/')}>
            Back to landing
          </Button>
          <Typography variant="h4" sx={{ mt: 3, mb: 1, fontWeight: 700 }}>
            Guide not found
          </Typography>
          <Typography color="#94a3b8">
            This guide does not exist yet. Return to the landing page to explore Commonly.
          </Typography>
        </Container>
      </Box>
    );
  }

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
          {guide.eyebrow.toUpperCase()}
        </Typography>
        <Typography component="h1" variant="h2" sx={{ fontWeight: 800, lineHeight: 1.15, letterSpacing: '-0.03em', mb: 2 }}>
          {guide.title}
        </Typography>
        <Typography sx={{ color: '#94a3b8', fontSize: '1.125rem', lineHeight: 1.7, mb: 5 }}>
          {guide.description}
        </Typography>
        <Typography sx={{ color: '#94a3b8', fontSize: '0.875rem', lineHeight: 1.7, mb: 5 }}>
          By {guide.provenance.author} · Reviewed by {guide.provenance.reviewer}
          <br />
          {guide.provenance.datePublished === guide.provenance.dateModified
            ? `Published and updated ${formatGuideDate(guide.provenance.datePublished)}`
            : `Published ${formatGuideDate(guide.provenance.datePublished)} · Updated ${formatGuideDate(guide.provenance.dateModified)}`}
        </Typography>

        <Stack spacing={2} sx={{ color: '#cbd5e1', fontSize: '1.05rem', lineHeight: 1.75, mb: 7 }}>
          {guide.intro.map((paragraph) => <Typography key={paragraph}>{paragraph}</Typography>)}
        </Stack>

        <Stack spacing={7}>
          {guide.sections.map((section) => (
            <Box component="section" key={section.title}>
              <Typography component="h2" variant="h4" sx={{ fontWeight: 750, lineHeight: 1.2, mb: 2.5 }}>
                {section.title}
              </Typography>
              <Stack spacing={2} sx={{ color: '#cbd5e1', lineHeight: 1.75 }}>
                {section.paragraphs?.map((paragraph) => <Typography key={paragraph}>{paragraph}</Typography>)}
              </Stack>
              {section.bullets && (
                <Box component="ul" sx={{ color: '#cbd5e1', lineHeight: 1.75, pl: 3, my: 2.5 }}>
                  {section.bullets.map((item) => <li key={item}><Typography component="span">{item}</Typography></li>)}
                </Box>
              )}
              {section.orderedItems && (
                <Box component="ol" sx={{ color: '#cbd5e1', lineHeight: 1.75, pl: 3, my: 2.5 }}>
                  {section.orderedItems.map((item) => <li key={item}><Typography component="span">{item}</Typography></li>)}
                </Box>
              )}
            </Box>
          ))}
        </Stack>

        <Divider sx={{ borderColor: 'rgba(148,163,184,0.18)', my: 7 }} />

        <Box component="section">
          <Typography component="h2" variant="h4" sx={{ fontWeight: 750, mb: 3 }}>
            Frequently asked questions
          </Typography>
          <Stack spacing={3}>
            {guide.faq.map((item) => (
              <Box key={item.question} sx={{ p: 3, border: '1px solid rgba(148,163,184,0.18)', borderRadius: 3 }}>
                <Typography component="h3" sx={{ fontWeight: 700, mb: 1 }}>{item.question}</Typography>
                <Typography sx={{ color: '#cbd5e1', lineHeight: 1.75 }}>{item.answer}</Typography>
              </Box>
            ))}
          </Stack>
        </Box>

        <Box component="section" sx={{ mt: 7, p: { xs: 3, sm: 5 }, borderRadius: 4, background: 'rgba(14,116,144,0.22)' }}>
          <Typography component="h2" variant="h4" sx={{ fontWeight: 750, mb: 1.5 }}>{guide.cta.title}</Typography>
          <Typography sx={{ color: '#e0f2fe', lineHeight: 1.75, mb: 3 }}>{guide.cta.body}</Typography>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
            <Button variant="contained" endIcon={<ArrowForwardIcon />} onClick={() => navigate(guide.cta.primary.path)}>
              {guide.cta.primary.label}
            </Button>
            <Button variant="outlined" onClick={() => navigate(guide.cta.secondary.path)}>
              {guide.cta.secondary.label}
            </Button>
          </Stack>
        </Box>

        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} sx={{ mt: 4 }}>
          {guide.relatedLinks.map((link) => (
            <Button key={link.path} variant="text" onClick={() => navigate(link.path)}>{link.label}</Button>
          ))}
        </Stack>
      </Container>
    </Box>
  );
};

export default GuidePage;
