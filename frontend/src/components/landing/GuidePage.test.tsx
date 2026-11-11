import React from 'react';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import GuidePage from './GuidePage';

// Every live guide gets its revised pass in time, so the unrevised case is a fixture:
// a real guide with `revised` and `answer` taken off, served next to the real ones.
jest.mock('../../content/guides.json', () => {
  const real = jest.requireActual('../../content/guides.json');
  const { revised, answer, ...unrevised } = real['ai-agent-memory'];
  return { ...real, 'unrevised-fixture': unrevised };
});

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

const renderGuideAt = (id: string) => render(
  <MemoryRouter initialEntries={[`/guides/${id}`]}>
    <Routes>
      <Route path="/guides/:guideId" element={<GuidePage />} />
    </Routes>
  </MemoryRouter>,
);

test('a revised guide shows its short answer, Sam as author and its revised date, as the static page does', () => {
  renderGuideAt('multi-agent-collaboration-platform');
  const answer = screen.getByText('Short answer.').parentElement as HTMLElement;
  expect(answer.textContent).toMatch(/^Short answer\. A multi-agent collaboration platform gives people and agents/);
  // The answer sits between the byline and the intro, as on the static page.
  expect(answer.previousElementSibling?.textContent).toMatch(/^By Sam Xu · Reviewed by/);
  expect(answer.nextElementSibling?.firstElementChild?.tagName).toBe('P');
  const author = screen.getByRole('link', { name: 'Sam Xu' });
  expect(author).toHaveAttribute('href', 'https://x.com/sam_commonly');
  expect(author).toHaveAttribute('rel', 'author');
  expect(answer.previousElementSibling?.textContent).toContain('Published August 24, 2026 · Updated November 11, 2026');
});

test('a revised guide whose original dates match still shows its revised date as Updated', () => {
  renderGuideAt('ai-agent-memory');
  const byline = screen.getByText('Short answer.').parentElement?.previousElementSibling as HTMLElement;
  expect(byline.textContent).toContain('Published August 30, 2026 · Updated November 11, 2026');
  expect(byline.textContent).not.toContain('Published and updated');
});

test('a guide without a revised pass renders as before: no short answer, the provenance author and dates', () => {
  renderGuideAt('unrevised-fixture');
  expect(screen.queryByText('Short answer.')).not.toBeInTheDocument();
  expect(screen.queryByRole('link', { name: 'Sam Xu' })).not.toBeInTheDocument();
  const byline = screen.getByText(/By Commonly · Reviewed by Commonly SEO team/);
  expect(byline.textContent).toContain('Published and updated August 30, 2026');
});

test('the three question guides render, and the Slack one says it does not replace Slack', () => {
  const renderGuide = (id: string) => render(
    <MemoryRouter initialEntries={[`/guides/${id}`]}>
      <Routes>
        <Route path="/guides/:guideId" element={<GuidePage />} />
      </Routes>
    </MemoryRouter>,
  );

  const slack = renderGuide('open-source-slack-alternative-ai-agents');
  expect(screen.getByRole('heading', { level: 1, name: 'Open source Slack alternative with AI agents built in' })).toBeInTheDocument();
  // The answer in the same FAQ box as the question, not the connector line elsewhere on the page.
  const faqItem = screen.getByRole('heading', { level: 3, name: 'Does Commonly replace Slack?' }).parentElement as HTMLElement;
  expect(within(faqItem).getByText(/^No\. Teams use Commonly alongside their chat\./)).toBeInTheDocument();
  expect(screen.queryByText(/full (Slack )?replacement/)).toBeNull();
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
