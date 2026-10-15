// @ts-nocheck
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import V2NavRail from '../components/V2NavRail';
import { FIRST_RUN_REOPEN_EVENT, FIRST_RUN_STARTED_KEY } from '../firstRunGuide';

const mockLogout = jest.fn();

jest.mock('../../context/AuthContext', () => ({
  useAuth: () => ({
    currentUser: { _id: 'user-1', username: 'Sam' },
    logout: mockLogout,
  }),
}));

describe('V2FeedbackMenu', () => {
  const originalVersion = process.env.REACT_APP_VERSION;

  beforeEach(() => {
    process.env.REACT_APP_VERSION = 'abc12345';
    localStorage.clear();
  });

  test('Guide from a feature page saves the request and returns to the shell', () => {
    const LocationProbe = () => {
      const location = useLocation();
      return <span data-testid="location">{location.pathname}</span>;
    };
    render(
      <MemoryRouter initialEntries={['/v2/settings']}>
        <div className="v2-root">
          <V2NavRail />
          <LocationProbe />
        </div>
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Feedback' }));
    fireEvent.click(screen.getByRole('button', { name: 'Guide', hidden: true }));

    expect(localStorage.getItem(FIRST_RUN_STARTED_KEY)).toBe('1');
    expect(screen.getByTestId('location')).toHaveTextContent('/v2');
  });

  test('Guide leaves the current pod in place when a mounted guide handler handles the request', () => {
    const LocationProbe = () => {
      const location = useLocation();
      return <span data-testid="location">{location.pathname + location.search}</span>;
    };
    const heroListener = (event: Event) => { event.detail.handled = true; };
    window.addEventListener(FIRST_RUN_REOPEN_EVENT, heroListener);
    try {
      render(
        <MemoryRouter initialEntries={['/v2/pods/pod-123?view=files']}>
          <div className="v2-root">
            <V2NavRail />
            <LocationProbe />
          </div>
        </MemoryRouter>,
      );
      fireEvent.click(screen.getByRole('button', { name: 'Feedback' }));
      fireEvent.click(screen.getByRole('button', { name: 'Guide', hidden: true }));

      expect(screen.getByTestId('location')).toHaveTextContent('/v2/pods/pod-123?view=files');
      expect(localStorage.getItem(FIRST_RUN_STARTED_KEY)).toBe('1');
    } finally {
      window.removeEventListener(FIRST_RUN_REOPEN_EVENT, heroListener);
    }
  });

  afterEach(() => {
    if (originalVersion === undefined) {
      delete process.env.REACT_APP_VERSION;
    } else {
      process.env.REACT_APP_VERSION = originalVersion;
    }
    jest.clearAllMocks();
  });

  test('renders all feedback destinations from the shared navigation rail', async () => {
    render(
      <MemoryRouter initialEntries={['/v2/pods/pod-123?view=files']}>
        <div className="v2-root">
          <V2NavRail />
        </div>
      </MemoryRouter>,
    );

    const trigger = screen.getByRole('button', { name: 'Feedback' });
    fireEvent.click(trigger);

    // setupTests renders portals inline, so MUI's modal aria-hides the rail
    // ancestor in jsdom. Production portals the menu beside the rail instead.
    const roleOptions = { hidden: true };
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(trigger).toHaveAttribute('aria-controls', 'v2-feedback-options');
    expect(screen.getByRole('navigation', { name: 'Feedback options', ...roleOptions })).toHaveAttribute(
      'id',
      'v2-feedback-options',
    );
    const bugLink = await screen.findByRole('link', { name: 'Report a bug', ...roleOptions });
    const featureLink = screen.getByRole('link', { name: 'Request a feature', ...roleOptions });
    const questionLink = screen.getByRole('link', { name: 'Ask a question', ...roleOptions });

    const bugUrl = new URL(bugLink.getAttribute('href'));
    expect(bugUrl.searchParams.get('template')).toBe('bug_report.yml');
    expect(bugUrl.searchParams.get('app_context')).toBe('abc12345 @ /v2/pods/pod-123');
    expect(bugUrl.searchParams.get('deployment')).toBe('Commonly hosted (commonly.me)');
    expect(featureLink).toHaveAttribute(
      'href',
      'https://github.com/Team-Commonly/commonly/issues/new?template=feature_request.yml',
    );
    expect(questionLink).toHaveAttribute(
      'href',
      'https://github.com/Team-Commonly/commonly/discussions/new?category=q-a',
    );

    [bugLink, featureLink, questionLink].forEach((link) => {
      expect(link).toHaveAttribute('target', '_blank');
      expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    });
  });
});
