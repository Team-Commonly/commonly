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

  test('four labelled tiles; the count is a badge on the Needs you icon; each tile navigates', () => {
    render(
      <MemoryRouter initialEntries={['/v2/pods/pod-1']}>
        <V2MobileTabs needsYouCount={3} />
        <Location />
      </MemoryRouter>,
    );

    // D215: the label is a word; the count rides the icon as a cobalt badge.
    expect(screen.getAllByRole('button').map((b) => b.querySelector('.v2-mobile-tabs__label')?.textContent)).toEqual(['Pods', 'Needs you', 'Team', 'Settings']);
    const badge = document.querySelector('.v2-mobile-tabs__icon .v2-mobile-tabs__count');
    expect(badge).toHaveTextContent('3');
    expect(badge).toHaveAttribute('aria-hidden', 'true');
    // The accessible name keeps the count.
    expect(screen.getByRole('button', { name: 'Pods' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('button', { name: 'Settings' })).not.toHaveAttribute('aria-current');
    fireEvent.click(screen.getByRole('button', { name: 'Needs you · 3' }));
    expect(screen.getByTestId('location')).toHaveTextContent('/v2/activity');
    fireEvent.click(screen.getByRole('button', { name: 'Team' }));
    expect(screen.getByTestId('location')).toHaveTextContent('/v2/agents');
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(screen.getByTestId('location')).toHaveTextContent('/v2/settings');
    fireEvent.click(screen.getByRole('button', { name: 'Pods' }));
    expect(screen.getByTestId('location')).toHaveTextContent('/v2');
  });

  test.each(['/v2/connectors', '/v2/connectors/'])('%s lights Settings, the tab it sits under on a phone', (path) => {
    render(
      <MemoryRouter initialEntries={[path]}>
        <V2MobileTabs needsYouCount={0} />
      </MemoryRouter>,
    );

    expect(screen.getByRole('button', { name: 'Settings' })).toHaveAttribute('aria-current', 'page');
    expect(document.querySelectorAll('.v2-mobile-tabs__item--active')).toHaveLength(1);
  });

  test('at zero there is no badge and no count in the name', () => {
    render(
      <MemoryRouter initialEntries={['/v2']}>
        <V2MobileTabs needsYouCount={0} />
      </MemoryRouter>,
    );
    expect(screen.getByRole('button', { name: 'Needs you' })).toBeInTheDocument();
    expect(screen.queryByText(/· 0/)).not.toBeInTheDocument();
    expect(document.querySelector('.v2-mobile-tabs__count')).toBeNull();
  });
});
