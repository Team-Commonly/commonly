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

test('a guide without a revised pass renders as before: no short answer, the provenance author and dates', () => {
  renderGuideAt('self-hosted-ai-agent-platform');
  expect(screen.queryByText('Short answer.')).not.toBeInTheDocument();
  expect(screen.queryByRole('link', { name: 'Sam Xu' })).not.toBeInTheDocument();
  const byline = screen.getByText(/By Commonly · Reviewed by Commonly SEO team/);
  expect(byline.textContent).toContain('Published and updated August 30, 2026');
});
