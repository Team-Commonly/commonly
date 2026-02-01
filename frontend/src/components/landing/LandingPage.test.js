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
      expect(screen.getByText(/A shared home for/i)).toBeInTheDocument();
      expect(screen.getByText(/team context/i)).toBeInTheDocument();
    });

    it('renders the header with logo', () => {
      renderLandingPage();

      expect(screen.getByText('Commonly')).toBeInTheDocument();
    });

    it('renders Get Started and Log in buttons in header', () => {
      renderLandingPage();

      expect(screen.getByRole('button', { name: /get started/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /log in/i })).toBeInTheDocument();
    });

    it('renders the hero section with CTAs', () => {
      renderLandingPage();

      expect(screen.getByRole('button', { name: /get started free/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /learn more/i })).toBeInTheDocument();
    });

    it('renders all feature cards', () => {
      renderLandingPage();

      expect(screen.getByText('AI-Powered Summaries')).toBeInTheDocument();
      expect(screen.getByText('Real-Time Pods')).toBeInTheDocument();
      expect(screen.getByText('Agent Hub')).toBeInTheDocument();
      expect(screen.getByText('Activity Feed')).toBeInTheDocument();
      expect(screen.getByText('Integrations')).toBeInTheDocument();
      expect(screen.getByText('Pod Memory Search')).toBeInTheDocument();
    });

    it('renders integration badges', () => {
      renderLandingPage();

      expect(screen.getByText('Discord')).toBeInTheDocument();
      expect(screen.getByText('Slack')).toBeInTheDocument();
      expect(screen.getByText('Telegram')).toBeInTheDocument();
      expect(screen.getByText('WhatsApp')).toBeInTheDocument();
      expect(screen.getByText('GitHub')).toBeInTheDocument();
    });

    it('renders the CTA section', () => {
      renderLandingPage();

      expect(screen.getByText(/Ready to give your team/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /create your pod/i })).toBeInTheDocument();
      expect(screen.getByRole('link', { name: /view docs/i })).toBeInTheDocument();
    });

    it('renders the footer', () => {
      renderLandingPage();

      expect(screen.getByText(/Commonly\. Built for teams who work with AI\./i)).toBeInTheDocument();
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

    it('navigates to /register when Get Started Free is clicked', () => {
      renderLandingPage();

      const getStartedFreeButton = screen.getByRole('button', { name: /get started free/i });
      fireEvent.click(getStartedFreeButton);

      expect(mockNavigate).toHaveBeenCalledWith('/register');
    });

    it('navigates to /register when Create Your Pod is clicked', () => {
      renderLandingPage();

      const createPodButton = screen.getByRole('button', { name: /create your pod/i });
      fireEvent.click(createPodButton);

      expect(mockNavigate).toHaveBeenCalledWith('/register');
    });

    it('has correct href for View Docs link', () => {
      renderLandingPage();

      const viewDocsLink = screen.getByRole('link', { name: /view docs/i });
      expect(viewDocsLink).toHaveAttribute('href', 'https://docs.molt.bot');
      expect(viewDocsLink).toHaveAttribute('target', '_blank');
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

      expect(screen.getByText(/A shared home for/i)).toBeInTheDocument();
    });
  });

  describe('Scroll behavior', () => {
    it('scrolls to features section when Learn More is clicked', () => {
      // Mock scrollIntoView
      const scrollIntoViewMock = jest.fn();
      const originalGetElementById = document.getElementById;
      document.getElementById = jest.fn((id) => {
        if (id === 'features') {
          return { scrollIntoView: scrollIntoViewMock };
        }
        return originalGetElementById.call(document, id);
      });

      renderLandingPage();

      const learnMoreButton = screen.getByRole('button', { name: /learn more/i });
      fireEvent.click(learnMoreButton);

      expect(scrollIntoViewMock).toHaveBeenCalledWith({ behavior: 'smooth' });

      // Restore original
      document.getElementById = originalGetElementById;
    });
  });
});
