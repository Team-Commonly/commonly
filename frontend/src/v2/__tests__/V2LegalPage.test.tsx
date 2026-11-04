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
    expect(screen.getByText(/AI models for hosted agents: Anthropic's Claude\./)).toBeInTheDocument();
    // D243: hosted agents moved off DeepSeek; the page must not name it.
    expect(screen.queryByText(/DeepSeek/)).not.toBeInTheDocument();
    expect(screen.getByText(/^Code sandbox: E2B\./)).toBeInTheDocument();
    // D81: the Workers AI route was removed; the page must not name it.
    expect(screen.queryByText(/Workers AI/)).not.toBeInTheDocument();
    // A provider our requests reach with user content is named, even one whose
    // key is rejected: a rejected request still carried the content.
    expect(screen.getByText(/send pod content to Google's Gemini API/)).toBeInTheDocument();
    expect(screen.getByText(/description to OpenAI\./)).toBeInTheDocument();
  });

  it('states how Google Calendar data is used, with the Limited Use disclosure', () => {
    render(<V2PrivacyPage />);
    expect(screen.getByRole('heading', { level: 2, name: 'Google Calendar' })).toBeInTheDocument();
    expect(screen.getByText(/It can't create, change or delete events\./)).toBeInTheDocument();
    expect(screen.getByText(/We don't store the calendar data Google sends back\./)).toBeInTheDocument();
    // D239: Calendar is granted only to agents on their owner's machine, never to hosted agents.
    expect(screen.getByText(/never hosted agents\./)).toBeInTheDocument();
    expect(screen.getByText(/Google API Services User Data Policy, including the Limited Use requirements\./)).toBeInTheDocument();
  });

  it('states how long run records and backups keep content', () => {
    render(<V2PrivacyPage />);
    expect(screen.getByText(/inputs and outputs of its tool calls for 30 days\./)).toBeInTheDocument();
    expect(screen.getByText(/can stay in a backup for up to 35 days/)).toBeInTheDocument();
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
