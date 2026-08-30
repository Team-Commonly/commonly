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
import { guidePalette, useGuideCanvas } from './guideShell';

interface GuideSection {
  title: string;
  paragraphs?: string[];
  bullets?: string[];
  orderedItems?: string[];
  codeBlocks?: Array<{
    language?: string;
    code: string;
  }>;
  tables?: Array<{
    headers: string[];
    rows: string[][];
  }>;
  links?: GuideLink[];
}

interface GuideFaq {
  question: string;
  answer: string;
}

interface GuideLink {
  label: string;
  path: string;
  external?: boolean;
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

  useGuideCanvas();

  if (!guide) {
    return (
      <Box sx={{ minHeight: '100vh', backgroundColor: guidePalette.page, color: guidePalette.textPrimary, py: 10 }}>
        <Container maxWidth="md">
          <Button sx={{ color: guidePalette.accentText }} startIcon={<ArrowBackIcon />} onClick={() => navigate('/')}>
            Back to landing
          </Button>
          <Typography variant="h4" sx={{ mt: 3, mb: 1, color: guidePalette.textPrimary, fontWeight: 700 }}>
            Guide not found
          </Typography>
          <Typography color={guidePalette.textSecondary}>
            This guide does not exist yet. Return to the landing page to explore Commonly.
          </Typography>
        </Container>
      </Box>
    );
  }

  return (
    <Box sx={{ minHeight: '100vh', backgroundColor: guidePalette.page, color: guidePalette.textPrimary }}>
      <Container maxWidth="md" sx={{ pt: 5, pb: 10 }}>
        <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 6 }}>
          <Button sx={{ color: guidePalette.accentText }} startIcon={<ArrowBackIcon />} onClick={() => navigate('/')}>
            Back to landing
          </Button>
          <Stack direction="row" alignItems="center" spacing={1}>
            <img src={commonlyLogo} alt="Commonly Logo" width={26} height={26} />
            <Typography sx={{ color: guidePalette.textPrimary, fontWeight: 700, letterSpacing: '-0.02em' }}>Commonly</Typography>
          </Stack>
        </Stack>

        <Typography sx={{ color: guidePalette.accentText, fontWeight: 700, letterSpacing: '0.08em', mb: 1 }}>
          {guide.eyebrow.toUpperCase()}
        </Typography>
        <Typography component="h1" variant="h2" sx={{ color: guidePalette.textPrimary, fontWeight: 800, lineHeight: 1.15, letterSpacing: '-0.03em', mb: 2 }}>
          {guide.title}
        </Typography>
        <Typography sx={{ color: guidePalette.textSecondary, fontSize: '1.125rem', lineHeight: 1.7, mb: 5 }}>
          {guide.description}
        </Typography>
        <Typography sx={{ color: guidePalette.textTertiary, fontSize: '0.875rem', lineHeight: 1.7, mb: 5 }}>
          By {guide.provenance.author} · Reviewed by {guide.provenance.reviewer}
          <br />
          {guide.provenance.datePublished === guide.provenance.dateModified
            ? `Published and updated ${formatGuideDate(guide.provenance.datePublished)}`
            : `Published ${formatGuideDate(guide.provenance.datePublished)} · Updated ${formatGuideDate(guide.provenance.dateModified)}`}
        </Typography>

        <Stack spacing={2} sx={{ color: guidePalette.textSecondary, fontSize: '1.05rem', lineHeight: 1.75, mb: 7 }}>
          {guide.intro.map((paragraph) => <Typography key={paragraph}>{paragraph}</Typography>)}
        </Stack>

        <Stack spacing={7}>
          {guide.sections.map((section) => (
            <Box component="section" key={section.title}>
              <Typography component="h2" variant="h4" sx={{ color: guidePalette.textPrimary, fontWeight: 750, lineHeight: 1.2, mb: 2.5 }}>
                {section.title}
              </Typography>
              <Stack spacing={2} sx={{ color: guidePalette.textSecondary, lineHeight: 1.75 }}>
                {section.paragraphs?.map((paragraph) => <Typography key={paragraph}>{paragraph}</Typography>)}
              </Stack>
              {section.bullets && (
                <Box component="ul" sx={{ color: guidePalette.textSecondary, lineHeight: 1.75, pl: 3, my: 2.5 }}>
                  {section.bullets.map((item) => <li key={item}><Typography component="span">{item}</Typography></li>)}
                </Box>
              )}
              {section.orderedItems && (
                <Box component="ol" sx={{ color: guidePalette.textSecondary, lineHeight: 1.75, pl: 3, my: 2.5 }}>
                  {section.orderedItems.map((item) => <li key={item}><Typography component="span">{item}</Typography></li>)}
                </Box>
              )}
              {section.tables?.map((table) => (
                <Box key={table.headers.join('|')} sx={{ overflowX: 'auto', mt: 2.5 }}>
                  <Box component="table" sx={{ width: '100%', minWidth: 620, borderCollapse: 'collapse', color: guidePalette.textSecondary }}>
                    <Box component="thead" sx={{ backgroundColor: guidePalette.surfaceTint }}>
                      <Box component="tr">{table.headers.map((header) => <Box component="th" key={header} scope="col" sx={{ p: 1.5, textAlign: 'left', color: guidePalette.textPrimary, border: `1px solid ${guidePalette.borderSoft}` }}>{header}</Box>)}</Box>
                    </Box>
                    <Box component="tbody">{table.rows.map((row) => <Box component="tr" key={row.join('|')}>{row.map((cell) => <Box component="td" key={cell} sx={{ p: 1.5, verticalAlign: 'top', border: `1px solid ${guidePalette.borderSoft}` }}>{cell}</Box>)}</Box>)}</Box>
                  </Box>
                </Box>
              ))}
              {section.codeBlocks?.map((block) => (
                <Box
                  component="pre"
                  key={block.code}
                  sx={{
                    overflowX: 'auto',
                    m: 0,
                    mt: 2.5,
                    p: 2,
                    border: `1px solid ${guidePalette.borderSoft}`,
                    borderRadius: 2,
                    backgroundColor: guidePalette.surfaceTint,
                    color: guidePalette.textPrimary,
                    fontSize: '0.875rem',
                    lineHeight: 1.6,
                  }}
                >
                  <Box component="code" className={block.language ? `language-${block.language}` : undefined}>
                    {block.code}
                  </Box>
                </Box>
              ))}
              {section.links && (
                <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ mt: 2 }}>
                  {section.links.map((link) => <Button key={link.path} component="a" href={link.path} target={link.external ? '_blank' : undefined} rel={link.external ? 'noreferrer' : undefined} sx={{ alignSelf: 'flex-start', color: guidePalette.accentText }}>{link.label}</Button>)}
                </Stack>
              )}
            </Box>
          ))}
        </Stack>

        <Divider sx={{ borderColor: guidePalette.border, my: 7 }} />

        <Box component="section">
          <Typography component="h2" variant="h4" sx={{ color: guidePalette.textPrimary, fontWeight: 750, mb: 3 }}>
            Frequently asked questions
          </Typography>
          <Stack spacing={3}>
            {guide.faq.map((item) => (
              <Box key={item.question} sx={{ p: 3, border: `1px solid ${guidePalette.borderSoft}`, borderRadius: 3, backgroundColor: guidePalette.surface }}>
                <Typography component="h3" sx={{ color: guidePalette.textPrimary, fontWeight: 700, mb: 1 }}>{item.question}</Typography>
                <Typography sx={{ color: guidePalette.textSecondary, lineHeight: 1.75 }}>{item.answer}</Typography>
              </Box>
            ))}
          </Stack>
        </Box>

        <Box component="section" sx={{ mt: 7, p: { xs: 3, sm: 5 }, borderRadius: 4, background: guidePalette.accentSoft }}>
          <Typography component="h2" variant="h4" sx={{ color: guidePalette.accentDeep, fontWeight: 750, mb: 1.5 }}>{guide.cta.title}</Typography>
          <Typography sx={{ color: guidePalette.accentDeep, lineHeight: 1.75, mb: 3 }}>{guide.cta.body}</Typography>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
            <Button variant="contained" sx={{ backgroundColor: guidePalette.accent, '&:hover': { backgroundColor: guidePalette.accentStrong } }} endIcon={<ArrowForwardIcon />} onClick={() => navigate(guide.cta.primary.path)}>
              {guide.cta.primary.label}
            </Button>
            <Button variant="outlined" sx={{ borderColor: guidePalette.accent, color: guidePalette.accentText, '&:hover': { borderColor: guidePalette.accentStrong, backgroundColor: guidePalette.surface } }} onClick={() => navigate(guide.cta.secondary.path)}>
              {guide.cta.secondary.label}
            </Button>
          </Stack>
        </Box>

        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} sx={{ mt: 4 }}>
          {guide.relatedLinks.map((link) => (
            <Button key={link.path} variant="text" sx={{ color: guidePalette.accentText }} onClick={() => navigate(link.path)}>{link.label}</Button>
          ))}
        </Stack>
      </Container>
    </Box>
  );
};

export default GuidePage;
