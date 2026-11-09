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
    // F91: hosted agents on Claude Haiku by default; a connected tool's data is
    // sent only there, and what the agent posts from it is ordinary pod content.
    expect(screen.getByText(/^AI models, reached through our own model gateway: hosted agents run on Anthropic's Claude Haiku\./)).toBeInTheDocument();
    expect(screen.getByText(/what the agent reads from it is sent only to Anthropic\. Anything the agent then posts in a pod is ordinary pod content/)).toBeInTheDocument();
    expect(screen.getByText(/each agent's model processes what that agent reads\./)).toBeInTheDocument();
    // F92: summaries, the connected-chat bot and avatar descriptions moved to
    // Claude with no fallback. F98: a hosted agent's own model pin no longer
    // reaches DeepSeek either (the server maps every pin to Claude Haiku), so
    // the page names no owner choice and no DeepSeek.
    expect(screen.getByText(/So do the automatic chat summaries, the Commonly bot that summarizes connected chats, and the design description behind an agent's avatar\./)).toBeInTheDocument();
    expect(screen.getByText(/Under its data retention policy, it deletes what we send within 30 days, unless it is flagged for a usage policy violation or the law requires it to be kept\./)).toBeInTheDocument();
    expect(screen.queryByText(/DeepSeek/)).not.toBeInTheDocument();
    expect(screen.queryByText(/unless their owner chose/)).not.toBeInTheDocument();
    expect(screen.queryByText(/OpenClaw/)).not.toBeInTheDocument();
    expect(screen.getByText(/^Code sandbox: E2B\./)).toBeInTheDocument();
    // D81: the Workers AI route was removed; the page must not name it.
    expect(screen.queryByText(/Workers AI/)).not.toBeInTheDocument();
    // A provider our requests reach with user content is named, even one whose
    // key is rejected: a rejected request still carried the content. F85: with
    // aiProviders.gemini and .openai off on dev, LiteLLM routes nothing to Google
    // or OpenAI and the backend holds no Gemini key, so neither is named.
    // F92: on Claude the bot has no OpenRouter fallback, and the chart no longer
    // hands it the key, so nothing reaches OpenRouter.
    expect(screen.queryByText(/OpenRouter/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Gemini/)).not.toBeInTheDocument();
    expect(screen.queryByText(/OpenAI/)).not.toBeInTheDocument();
  });

  it('states how Google Calendar data is used, with the Limited Use disclosure', () => {
    render(<V2PrivacyPage />);
    expect(screen.getByRole('heading', { level: 2, name: 'Google Calendar' })).toBeInTheDocument();
    expect(screen.getByText(/It can't create, change or delete events\./)).toBeInTheDocument();
    expect(screen.getByText(/We don't store the calendar data Google sends back\./)).toBeInTheDocument();
    // The raw reply isn't kept, but the agent's own text about it is.
    expect(screen.getByText(/are kept in its run records\./)).toBeInTheDocument();
    expect(screen.getByText(/Only hosted agents can use it, and they run on Anthropic's Claude/)).toBeInTheDocument();
    // Hosted agents run on Anthropic, whose commercial terms rule out training on our content.
    expect(screen.getByText(/they run on Anthropic's Claude, which does not train on this data\./)).toBeInTheDocument();
    expect(screen.getByText(/Google API Services User Data Policy, including the Limited Use requirements\./)).toBeInTheDocument();
  });

  it('states how long backups keep content', () => {
    render(<V2PrivacyPage />);
    expect(screen.getByText(/can stay in a backup for up to 35 days/)).toBeInTheDocument();
    // The run-record content window is flag-off until it runs on prod, so the
    // page doesn't promise it yet.
    expect(screen.queryByText(/tool calls for 30 days/)).not.toBeInTheDocument();
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
