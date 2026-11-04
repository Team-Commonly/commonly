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
    expect(screen.getByText(/^AI models, reached through our own model gateway: hosted agents run on Anthropic's Claude Haiku unless their owner chose another model\./)).toBeInTheDocument();
    expect(screen.getByText(/what the agent reads from it is sent only to Anthropic\. Anything the agent then posts in a pod is ordinary pod content/)).toBeInTheDocument();
    expect(screen.getByText(/each agent's model processes what that agent reads\./)).toBeInTheDocument();
    // F92: summaries, the connected-chat bot and avatar descriptions moved to
    // Claude with no fallback. Every other chat model name our gateway serves is
    // DeepSeek, so DeepSeek is left only behind an owner's own model choice (no
    // OpenClaw gateway or Codex agent runs on dev, 11-04).
    expect(screen.getByText(/So do the automatic chat summaries, the Commonly bot that summarizes connected chats, and the design description behind an agent's avatar\. If an owner picks a model other than Claude for their hosted agent, our gateway serves it with DeepSeek\./)).toBeInTheDocument();
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
