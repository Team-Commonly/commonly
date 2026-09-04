import React from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import GuidePage from './GuidePage';

test('Compare Commonly related links request the generated static document', () => {
  render(
    <MemoryRouter initialEntries={['/guides/multi-agent-collaboration-platform']}>
      <Routes>
        <Route path="/guides/:guideId" element={<GuidePage />} />
      </Routes>
    </MemoryRouter>,
  );

  expect(screen.getByRole('link', { name: 'Compare Commonly' })).toHaveAttribute('href', '/compare/');
});
