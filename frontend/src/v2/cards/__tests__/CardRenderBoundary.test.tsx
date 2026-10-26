import React, { lazy, Suspense } from 'react';
import { render, screen } from '@testing-library/react';
import CardRenderBoundary from '../CardRenderBoundary';

test('a rejected lazy card chunk leaves its message and sibling readable', async () => {
  const error = jest.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const Broken = lazy(() => Promise.reject(new Error('chunk failed')));
    render(<><span>Other message</span><CardRenderBoundary fallback={<p>Original message</p>}>
      <Suspense fallback="Loading"><Broken /></Suspense>
    </CardRenderBoundary></>);
    expect(await screen.findByText('Original message')).toBeInTheDocument();
    expect(screen.getByText('Other message')).toBeInTheDocument();
  } finally { error.mockRestore(); }
});
