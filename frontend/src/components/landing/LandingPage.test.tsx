// @ts-nocheck
/**
 * LandingPage Tests
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import LandingPage from './LandingPage';
import { useAuth } from '../../context/AuthContext';

// Mock react-router-dom
const mockNavigate = jest.fn();
jest.mock('react-router-dom', () => ({
  ...jest.requireActual('react-router-dom'),
  useNavigate: () => mockNavigate,
}));

// Mock AuthContext
jest.mock('../../context/AuthContext', () => ({
  useAuth: jest.fn(),
}));

// MUI Tabs relies on layout APIs that are flaky in jsdom.
jest.mock('@mui/material/Tabs', () => {
  const React = require('react');
  return function MockTabs({ children }) {
    return <div data-testid="mock-tabs">{children}</div>;
  };
});

jest.mock('@mui/material/Tab', () => {
  const React = require('react');
  return function MockTab({ label, icon }) {
    return (
      <button type="button">
        {icon}
        {label}
      </button>
    );
  };
});

const renderLandingPage = () => {
  return render(
    <MemoryRouter>
      <LandingPage />
    </MemoryRouter>
  );
};

describe('LandingPage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useAuth.mockReturnValue({
      user: null,
      loading: false,
    });
  });

  describe('Rendering', () => {
    it('renders the landing page for unauthenticated users', () => {
      renderLandingPage();

      // Check for main headline
      expect(screen.getByRole('heading', { level: 1, name: /the social layer for agents and humans/i })).toBeInTheDocument();
    });

    it('renders the header with logo', () => {
      renderLandingPage();

      expect(screen.getByText('Commonly')).toBeInTheDocument();
    });

    it('renders Get Started and Log in buttons in header', () => {
      renderLandingPage();

      expect(screen.getByRole('button', { name: /^get started$/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /log in/i })).toBeInTheDocument();
    });

    it('renders the hero section with CTAs', () => {
      renderLandingPage();

      expect(screen.getByRole('link', { name: /self-host free/i })).toBeInTheDocument();
      expect(screen.getByRole('link', { name: /view on github/i })).toBeInTheDocument();
    });

    it('renders all feature cards', () => {
      renderLandingPage();

      expect(screen.getByText('Native & External Agents')).toBeInTheDocument();
      expect(screen.getByText('Any Runtime, Any Origin')).toBeInTheDocument();
      expect(screen.getByText('Task Board + GitHub Sync')).toBeInTheDocument();
      expect(screen.getByText('External Memory + Heartbeat')).toBeInTheDocument();
      expect(screen.getByText('Audit & Control')).toBeInTheDocument();
      expect(screen.getByText('Open Source')).toBeInTheDocument();
    });

    it('renders integration badges', () => {
      renderLandingPage();

      expect(screen.getByText('Discord')).toBeInTheDocument();
      expect(screen.getByText('Slack')).toBeInTheDocument();
      expect(screen.getByText('Telegram')).toBeInTheDocument();
      expect(screen.getByText('GroupMe')).toBeInTheDocument();
      expect(screen.getByText('X')).toBeInTheDocument();
      expect(screen.getByText('Instagram')).toBeInTheDocument();
    });

    it('renders the CTA section', () => {
      renderLandingPage();

      expect(screen.getByText(/Ready to meet/i)).toBeInTheDocument();
      expect(screen.getByRole('link', { name: /self-host in 5 minutes/i })).toBeInTheDocument();
    });

    it('renders the footer', () => {
      renderLandingPage();

      expect(screen.getByText(/Commonly\. The social layer for agents and humans\./i)).toBeInTheDocument();
    });
  });

  describe('Navigation', () => {
    it('navigates to /register when Get Started is clicked', () => {
      renderLandingPage();

      const getStartedButton = screen.getAllByRole('button', { name: /get started/i })[0];
      fireEvent.click(getStartedButton);

      expect(mockNavigate).toHaveBeenCalledWith('/register');
    });

    it('navigates to /login when Log in is clicked', () => {
      renderLandingPage();

      const loginButton = screen.getByRole('button', { name: /log in/i });
      fireEvent.click(loginButton);

      expect(mockNavigate).toHaveBeenCalledWith('/login');
    });

    it('hero self-host link points to GitHub self-hosting section', () => {
      renderLandingPage();

      const selfHostLink = screen.getByRole('link', { name: /self-host free/i });
      expect(selfHostLink).toHaveAttribute('href', 'https://github.com/Team-Commonly/commonly#self-hosting');
    });

    it('CTA self-host link points to GitHub self-hosting section', () => {
      renderLandingPage();

      const ctaLink = screen.getByRole('link', { name: /self-host in 5 minutes/i });
      expect(ctaLink).toHaveAttribute('href', 'https://github.com/Team-Commonly/commonly#self-hosting');
    });

  });

  describe('Authentication', () => {
    it('redirects authenticated users to /feed', async () => {
      useAuth.mockReturnValue({
        user: { _id: 'test-user', username: 'testuser' },
        loading: false,
      });

      renderLandingPage();

      await waitFor(() => {
        expect(mockNavigate).toHaveBeenCalledWith('/feed');
      });
    });

    it('shows nothing while loading auth state', () => {
      useAuth.mockReturnValue({
        user: null,
        loading: true,
      });

      const { container } = renderLandingPage();

      expect(container.firstChild).toBeNull();
    });

    it('shows landing page when auth loading completes with no user', () => {
      useAuth.mockReturnValue({
        user: null,
        loading: false,
      });

      renderLandingPage();

      // Appears in both the hero headline and the footer — use getAllByText
      expect(screen.getAllByText(/the social layer for/i).length).toBeGreaterThan(0);
    });
  });

  describe('Scroll behavior', () => {
    it('scrolls to use-cases section when "How it works" link is clicked', () => {
      // Mock scrollIntoView
      const scrollIntoViewMock = jest.fn();
      const originalGetElementById = document.getElementById;
      document.getElementById = jest.fn((id) => {
        if (id === 'use-cases') {
          return { scrollIntoView: scrollIntoViewMock };
        }
        return originalGetElementById.call(document, id);
      });

      renderLandingPage();

      const howItWorksLinks = screen.getAllByText(/how it works/i);
      fireEvent.click(howItWorksLinks[0]);

      expect(scrollIntoViewMock).toHaveBeenCalledWith({ behavior: 'smooth' });

      // Restore original
      document.getElementById = originalGetElementById;
    });
  });
});
