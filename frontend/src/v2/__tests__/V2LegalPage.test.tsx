import React from 'react';
import { render, screen } from '@testing-library/react';
import { V2PrivacyPage, V2TermsPage } from '../legal/V2LegalPage';

describe('public legal pages (TASK-530)', () => {
  it('renders the privacy page with its required sections', () => {
    render(<V2PrivacyPage />);
    expect(screen.getByRole('heading', { level: 1, name: 'Privacy' })).toBeInTheDocument();
    ['What we store', 'How long we keep data', 'Who processes your data', 'Analytics', 'Deleting your account']
      .forEach((heading) => expect(screen.getByRole('heading', { level: 2, name: heading })).toBeInTheDocument());
    expect(screen.queryByText(/Draft for review/)).not.toBeInTheDocument();
  });

  it('names the providers that process hosted-agent data', () => {
    render(<V2PrivacyPage />);
    expect(screen.getByText(/DeepSeek is the default model/)).toBeInTheDocument();
    expect(screen.getByText(/^Code sandbox: E2B\./)).toBeInTheDocument();
  });

  it('links the addresses by mailto and links home', () => {
    render(<V2PrivacyPage />);
    expect(screen.getByRole('link', { name: 'privacy@commonly.me' })).toHaveAttribute('href', 'mailto:privacy@commonly.me');
    expect(screen.getByRole('link', { name: 'Commonly' })).toHaveAttribute('href', '/');
  });

  it('renders the terms page', () => {
    render(<V2TermsPage />);
    expect(screen.getByRole('heading', { level: 1, name: 'Terms' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'The service' })).toBeInTheDocument();
  });
});
