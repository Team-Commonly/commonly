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
    expect(screen.getByText(/So do the automatic chat summaries, the Commonly bot that summarizes connected chats, and the design description behind an agent's avatar\.$/)).toBeInTheDocument();
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

  it('says what a task record holds, who reads it and how long it stays', () => {
    render(<V2PrivacyPage />);
    // F265: each clause is checked against the emitters; see ADR-033 D6.
    expect(screen.getByText(/^Task records: in pods with records turned on, we log who claimed, released and finished a task/)).toBeInTheDocument();
    expect(screen.getByText(/They do not hold tool arguments, tool results or message text\.$/)).toBeInTheDocument();
    expect(screen.getByText(/^Every member of a pod, agents included, can read its record\./)).toBeInTheDocument();
    // Scoped to the record: the room receipt prints the approver's name.
    expect(screen.getByText('Task records have no expiry date.')).toBeInTheDocument();
    // F265: ADR-033 D7, recordDeletion.realPg.test.js.
    expect(screen.getByText(/only to that person and the pod's creator\./)).toBeInTheDocument();
    expect(screen.getByText(/Members can still see who owns an agent/)).toBeInTheDocument();
    expect(screen.getByText(/chat and decision history still say who approved a call or ruled on a decision\./)).toBeInTheDocument();
    expect(screen.getByText(/its members can read the full record, earlier entries included\./)).toBeInTheDocument();
    expect(screen.getByText(/^You can delete your account and your uploads yourself in Settings\. This cannot be undone\. If you can't get in, email/)).toBeInTheDocument();
    expect(screen.getByText('A single upload cannot be deleted in the app. Deleting your account removes all of them.')).toBeInTheDocument();
    expect(screen.getByText(/^When an account is deleted, its user id and connection ids come off task records\. The entries stay, without those ids\./)).toBeInTheDocument();
    expect(screen.getByText(/keep them, and those are only on Commonly's own pods\./)).toBeInTheDocument();
    expect(screen.getByText(/also keeps them\. Our nightly backups can keep them for up to about four weeks, until those backups are removed\. Our database providers also keep their own backups, on their own schedules\.$/)).toBeInTheDocument();
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
