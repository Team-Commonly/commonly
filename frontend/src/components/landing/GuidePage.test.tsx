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
