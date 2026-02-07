/**
 * LandingHeader Component
 * Sticky navigation header for the landing page
 */

import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Box, Button, Container, Typography } from '@mui/material';
import commonlyLogo from '../../../assets/commonly-logo.png';

const LandingHeader = () => {
  const navigate = useNavigate();
  const scrollTo = (id) => {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' });
  };

  return (
    <Box
      component="header"
      sx={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        zIndex: 1100,
        backgroundColor: 'rgba(11, 18, 32, 0.85)',
        backdropFilter: 'blur(12px)',
        borderBottom: '1px solid rgba(148, 163, 184, 0.1)',
      }}
    >
      <Container maxWidth="lg">
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            height: 64,
          }}
        >
          {/* Logo */}
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 1,
              cursor: 'pointer',
            }}
            onClick={() => navigate('/')}
          >
            <img
              src={commonlyLogo}
              alt="Commonly Logo"
              style={{ width: 32, height: 32 }}
            />
            <Typography
              variant="h6"
              sx={{
                fontWeight: 700,
                color: '#e2e8f0',
                letterSpacing: '-0.02em',
              }}
            >
              Commonly
            </Typography>
          </Box>

          {/* Navigation */}
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
            <Button
              variant="text"
              onClick={() => scrollTo('use-cases')}
              sx={{
                color: '#94a3b8',
                fontWeight: 500,
                display: { xs: 'none', md: 'inline-flex' },
                '&:hover': {
                  color: '#e2e8f0',
                  backgroundColor: 'rgba(148, 163, 184, 0.08)',
                },
              }}
            >
              Use Cases
            </Button>
            <Button
              variant="text"
              onClick={() => scrollTo('features')}
              sx={{
                color: '#94a3b8',
                fontWeight: 500,
                display: { xs: 'none', md: 'inline-flex' },
                '&:hover': {
                  color: '#e2e8f0',
                  backgroundColor: 'rgba(148, 163, 184, 0.08)',
                },
              }}
            >
              Features
            </Button>
            <Button
              variant="text"
              onClick={() => navigate('/login')}
              sx={{
                color: '#94a3b8',
                fontWeight: 500,
                '&:hover': {
                  color: '#e2e8f0',
                  backgroundColor: 'rgba(148, 163, 184, 0.08)',
                },
              }}
            >
              Log in
            </Button>
            <Button
              variant="contained"
              onClick={() => navigate('/register')}
              sx={{
                background: 'linear-gradient(135deg, #1da1f2 0%, #0c8bd9 100%)',
                boxShadow: '0 4px 12px rgba(29, 161, 242, 0.25)',
                '&:hover': {
                  background: 'linear-gradient(135deg, #58b7f6 0%, #1da1f2 100%)',
                  boxShadow: '0 6px 16px rgba(29, 161, 242, 0.35)',
                },
              }}
            >
              Get Started
            </Button>
          </Box>
        </Box>
      </Container>
    </Box>
  );
};

export default LandingHeader;
