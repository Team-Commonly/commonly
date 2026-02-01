/**
 * LandingPage Component
 * Main landing page container with all sections
 */

import React, { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Box } from '@mui/material';
import { useAuth } from '../../context/AuthContext';
import LandingHeader from './components/LandingHeader';
import HeroSection from './sections/HeroSection';
import FeaturesSection from './sections/FeaturesSection';
import IntegrationsSection from './sections/IntegrationsSection';
import CTASection from './sections/CTASection';
import './LandingPage.css';

const LandingPage = () => {
  const { user, loading } = useAuth();
  const navigate = useNavigate();

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
        <FeaturesSection />
        <IntegrationsSection />
        <CTASection />
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
        </Box>
      </Box>
    </Box>
  );
};

export default LandingPage;
