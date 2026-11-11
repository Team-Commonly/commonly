import React from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import GuidePage from './GuidePage';

test('guide related links no longer offer the unlisted compare page', () => {
  render(
    <MemoryRouter initialEntries={['/guides/multi-agent-collaboration-platform']}>
      <Routes>
        <Route path="/guides/:guideId" element={<GuidePage />} />
      </Routes>
    </MemoryRouter>,
  );

  expect(screen.getByRole('button', { name: 'Explore agent collaboration' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Compare Commonly' })).not.toBeInTheDocument();
  expect(document.querySelector('a[href="/compare/"]')).toBeNull();
});

test('a guide with no FAQ entries shows no FAQ heading', () => {
  const renderGuide = (id: string) => render(
    <MemoryRouter initialEntries={[`/guides/${id}`]}>
      <Routes>
        <Route path="/guides/:guideId" element={<GuidePage />} />
      </Routes>
    </MemoryRouter>,
  );

  const { unmount } = renderGuide('claude-code-team-chat-mentions');
  expect(screen.queryByRole('heading', { name: 'Frequently asked questions' })).not.toBeInTheDocument();
  unmount();
  renderGuide('ai-agent-collaboration-platforms');
  expect(screen.getByRole('heading', { name: 'Frequently asked questions' })).toBeInTheDocument();
});

test('the three question guides render, and the Slack one says it is no full replacement', () => {
  const renderGuide = (id: string) => render(
    <MemoryRouter initialEntries={[`/guides/${id}`]}>
      <Routes>
        <Route path="/guides/:guideId" element={<GuidePage />} />
      </Routes>
    </MemoryRouter>,
  );

  const slack = renderGuide('open-source-slack-alternative-ai-agents');
  expect(screen.getByRole('heading', { level: 1, name: 'Open source Slack alternative with AI agents built in' })).toBeInTheDocument();
  expect(screen.getByText('Is Commonly a full replacement for Slack?')).toBeInTheDocument();
  expect(screen.getByText('Some external chat channels can be brought into a Commonly pod through a connector.')).toBeInTheDocument();
  slack.unmount();
  const seeing = renderGuide('see-what-your-coding-agent-is-doing');
  expect(screen.getByRole('heading', { level: 1, name: 'How can my teammates see what my coding agent is doing?' })).toBeInTheDocument();
  expect(document.querySelector('a[href="/guides/ai-agent-observability/"]')).not.toBeNull();
  seeing.unmount();
  renderGuide('share-context-between-claude-code-sessions');
  expect(screen.getByRole('heading', { level: 1, name: 'How do I share context between Claude Code sessions across my team?' })).toBeInTheDocument();
  expect(document.querySelector('a[href="https://code.claude.com/docs/en/memory"]')).not.toBeNull();
});
