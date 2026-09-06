import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import V2MobileTabs from '../components/V2MobileTabs';

const Location = () => <output data-testid="location">{useLocation().pathname}</output>;

describe('V2MobileTabs', () => {
  test('keeps chat, board, needs-you and settings reachable from the phone shell', () => {
    const openInspector = jest.fn();
    render(
      <MemoryRouter initialEntries={['/v2/pods/pod-1']}>
        <V2MobileTabs podId="pod-1" needsYouCount={2} onOpenInspector={openInspector} />
        <Location />
      </MemoryRouter>,
    );

    expect(screen.getByText('2')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Board' }));
    expect(screen.getByTestId('location')).toHaveTextContent('/v2/pods/pod-1/board');
    fireEvent.click(screen.getByRole('button', { name: 'Needs you' }));
    expect(openInspector).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(screen.getByTestId('location')).toHaveTextContent('/v2/settings');
  });
});
