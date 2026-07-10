// @ts-nocheck
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import V2NavRail from '../components/V2NavRail';

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
