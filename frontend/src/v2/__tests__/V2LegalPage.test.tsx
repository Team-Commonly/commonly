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
    // F91: hosted agents on Claude Haiku; a connected tool's data goes only there.
    expect(screen.getByText(/^AI models, reached through our own model gateway: hosted agents, Commonly's own included, run on Anthropic's Claude Haiku\./)).toBeInTheDocument();
    expect(screen.getByText(/what the agent reads from it goes only to Anthropic\./)).toBeInTheDocument();
    expect(screen.getByText(/^Code sandbox: E2B\./)).toBeInTheDocument();
    // D81: the Workers AI route was removed; the page must not name it.
    expect(screen.queryByText(/Workers AI/)).not.toBeInTheDocument();
    // A provider our requests reach with user content is named, even one whose
    // key is rejected: a rejected request still carried the content. F85: with
    // aiProviders.gemini and .openai off on dev, LiteLLM routes nothing to Google
    // or OpenAI and the backend holds no Gemini key, so neither is named; the
    // commonly-bot client still falls back to OpenRouter on any gateway error,
    // a budget refusal included.
    expect(screen.getByText(/the design description behind an agent's avatar/)).toBeInTheDocument();
    expect(screen.getByText(/fails or turns a request away, the Commonly bot that summarizes connected chats may retry it through OpenRouter/)).toBeInTheDocument();
    expect(screen.queryByText(/Gemini/)).not.toBeInTheDocument();
    expect(screen.queryByText(/OpenAI/)).not.toBeInTheDocument();
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
