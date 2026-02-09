/**
 * LandingPage Component
 * Main landing page container with all sections
 */

import React, { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Box, Button, TextField, Typography } from '@mui/material';
import { useAuth } from '../../context/AuthContext';
import LandingHeader from './components/LandingHeader';
import HeroSection from './sections/HeroSection';
import UseCasesSection from './sections/UseCasesSection';
import FeaturesSection from './sections/FeaturesSection';
import IntegrationsSection from './sections/IntegrationsSection';
import CTASection from './sections/CTASection';
import './LandingPage.css';

const LandingPage = () => {
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const [contributorEmail, setContributorEmail] = React.useState('');
  const [contributorNote, setContributorNote] = React.useState('');

  // Redirect authenticated users to feed
  useEffect(() => {
    if (!loading && user) {
      navigate('/feed');
    }
  }, [user, loading, navigate]);

  // Show nothing while checking auth to prevent flash
  if (loading) {
    return null;
  }

  // If user is logged in, we'll be redirecting - don't show landing
  if (user) {
    return null;
  }

  const handleContributeSubmit = (e) => {
    e.preventDefault();
    const email = contributorEmail.trim();
    const note = contributorNote.trim();
    const bodyLines = [
      'Hi Commonly team,',
      '',
      'I would like to join and contribute.',
      '',
      email ? `Email: ${email}` : 'Email:',
      note ? `Note: ${note}` : 'Note:',
    ];
    const subject = encodeURIComponent('Join & contribute to Commonly');
    const body = encodeURIComponent(bodyLines.join('\n'));
    window.location.href = `mailto:support@commonly.me?subject=${subject}&body=${body}`;
  };

  return (
    <Box
      className="landing-page"
      sx={{
        minHeight: '100vh',
        backgroundColor: '#0b1220',
        overflow: 'hidden',
      }}
    >
      <LandingHeader />
      <main>
        <HeroSection />
        <UseCasesSection />
        <FeaturesSection />
        <IntegrationsSection />
        <CTASection />

        <Box
          sx={{
            maxWidth: 760,
            mx: 'auto',
            mt: { xs: 6, md: 8 },
            mb: { xs: 2, md: 3 },
            px: 2,
          }}
        >
          <Box
            sx={{
              borderRadius: 3,
              border: '1px solid rgba(148, 163, 184, 0.2)',
              background: 'linear-gradient(145deg, rgba(15, 23, 42, 0.85), rgba(2, 132, 199, 0.14))',
              p: { xs: 2.25, md: 3 },
            }}
          >
            <Typography sx={{ color: '#e2e8f0', fontWeight: 700, mb: 0.75 }}>
              Join & Contribute
            </Typography>
            <Typography sx={{ color: '#94a3b8', fontSize: '0.95rem', mb: 2 }}>
              Want to help build Commonly? Send us your email and a short note.
            </Typography>
            <Box
              component="form"
              onSubmit={handleContributeSubmit}
              sx={{
                display: 'grid',
                gridTemplateColumns: { xs: '1fr', md: '1fr 1.5fr auto' },
                gap: 1,
                alignItems: 'center',
              }}
            >
              <TextField
                type="email"
                size="small"
                required
                placeholder="you@company.com"
                value={contributorEmail}
                onChange={(e) => setContributorEmail(e.target.value)}
                InputProps={{
                  sx: {
                    color: '#f8fafc',
                    backgroundColor: 'rgba(15, 23, 42, 0.75)',
                    '& fieldset': { borderColor: 'rgba(148, 163, 184, 0.3)' },
                  },
                }}
              />
              <TextField
                size="small"
                placeholder="How would you like to contribute?"
                value={contributorNote}
                onChange={(e) => setContributorNote(e.target.value)}
                InputProps={{
                  sx: {
                    color: '#f8fafc',
                    backgroundColor: 'rgba(15, 23, 42, 0.75)',
                    '& fieldset': { borderColor: 'rgba(148, 163, 184, 0.3)' },
                  },
                }}
              />
              <Button
                type="submit"
                variant="contained"
                sx={{
                  minHeight: 40,
                  background: 'linear-gradient(135deg, #1da1f2 0%, #0c8bd9 100%)',
                  fontWeight: 600,
                  px: 2.25,
                  whiteSpace: 'nowrap',
                }}
              >
                Contact Us
              </Button>
            </Box>
          </Box>
        </Box>
      </main>

      {/* Footer */}
      <Box
        component="footer"
        sx={{
          py: 4,
          textAlign: 'center',
          borderTop: '1px solid rgba(148, 163, 184, 0.08)',
        }}
      >
        <Box
          component="span"
          sx={{
            color: '#64748b',
            fontSize: '0.875rem',
          }}
        >
          © {new Date().getFullYear()} Commonly. Built for teams who work with AI.
          <a
            href="mailto:support@commonly.me"
            style={{ color: '#94a3b8', textDecoration: 'none', marginLeft: '1rem' }}
          >
            support@commonly.me
          </a>
          <a href="https://github.com/your-repo/commonly" target="_blank" rel="noopener noreferrer" style={{ color: '#94a3b8', textDecoration: 'none', marginLeft: '1rem' }}>GitHub</a>
        </Box>
      </Box>
    </Box>
  );
};

export default LandingPage;
