import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import i18n, { i18nReady } from '../../i18n';
import V2MobileTabs from '../components/V2MobileTabs';

const Location = () => <output data-testid="location">{useLocation().pathname}</output>;

describe('V2MobileTabs', () => {
  beforeAll(async () => {
    await i18nReady;
    await act(async () => { await i18n.changeLanguage('en'); });
  });

  test('four labelled tiles; the count lives inside the Needs you label; each tile navigates', () => {
    render(
      <MemoryRouter initialEntries={['/v2/pods/pod-1']}>
        <V2MobileTabs needsYouCount={3} />
        <Location />
      </MemoryRouter>,
    );

    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['Pods', 'Needs you · 3', 'Team', 'Settings']);
    expect(screen.getByRole('button', { name: 'Pods' })).toHaveAttribute('aria-current', 'page');
    fireEvent.click(screen.getByRole('button', { name: 'Needs you · 3' }));
    expect(screen.getByTestId('location')).toHaveTextContent('/v2/activity');
    fireEvent.click(screen.getByRole('button', { name: 'Team' }));
    expect(screen.getByTestId('location')).toHaveTextContent('/v2/agents');
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(screen.getByTestId('location')).toHaveTextContent('/v2/settings');
    fireEvent.click(screen.getByRole('button', { name: 'Pods' }));
    expect(screen.getByTestId('location')).toHaveTextContent('/v2');
  });

  test('at zero the label has no count', () => {
    render(
      <MemoryRouter initialEntries={['/v2']}>
        <V2MobileTabs needsYouCount={0} />
      </MemoryRouter>,
    );
    expect(screen.getByRole('button', { name: 'Needs you' })).toBeInTheDocument();
    expect(screen.queryByText(/· 0/)).not.toBeInTheDocument();
  });
});
