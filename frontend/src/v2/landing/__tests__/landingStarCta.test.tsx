import fs from 'fs';
import path from 'path';
import React from 'react';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import axios from 'axios';
import i18n from '../../../i18n';
import { useAuth } from '../../../context/AuthContext';
import { STAR_CACHE_KEY, writeStarCache } from '../githubStars';
import V2LandingPage from '../V2LandingPage';

/**
 * The repo star ask appears in the nav and the open-source section as well
 * as the final CTA, and each one opens the repository.
 */

jest.mock('axios');
jest.mock('../../../context/AuthContext', () => ({
  useAuth: jest.fn(),
}));

const REPO = 'https://github.com/Team-Commonly/commonly';

describe('V2LandingPage star links', () => {
  beforeEach(async () => {
    (axios.get as jest.Mock).mockResolvedValue({ data: {} });
    (useAuth as jest.Mock).mockReturnValue({ isAuthenticated: false });
    await i18n.changeLanguage('en');
  });

  afterEach(() => {
    jest.clearAllMocks();
    window.localStorage.removeItem(STAR_CACHE_KEY);
  });

  it('asks for a star in the nav, the open-source section and the final CTA', () => {
    const { container } = render(<MemoryRouter><V2LandingPage /></MemoryRouter>);

    const nav = screen.getByRole('navigation', { name: i18n.t('landing.nav.primary') });
    expect(within(nav).getByRole('link', { name: 'Star on GitHub' })).toHaveAttribute('href', REPO);

    const open = container.querySelector('.v2-landing__open') as HTMLElement;
    expect(within(open).getByRole('link', { name: 'Star on GitHub' })).toHaveAttribute('href', REPO);

    const cta = container.querySelector('.v2-landing__cta') as HTMLElement;
    expect(within(cta).getByRole('link', { name: 'Star on GitHub' })).toHaveAttribute('href', REPO);
  });

  it('reads as a star count wherever the repo is linked, with a star and a name that says so', async () => {
    writeStarCache(window.localStorage, 1400, Date.now());
    const { container } = render(<MemoryRouter><V2LandingPage /></MemoryRouter>);

    const spots = await screen.findAllByTestId('star-count');
    expect(spots).toHaveLength(4);
    for (const spot of spots) {
      expect(spot).toHaveTextContent('1.4K');
      expect(spot).toHaveAccessibleName('1.4K GitHub stars');
      expect(within(spot).getByTestId('star-mark')).toBeInTheDocument();
      expect(spot.closest('a')).toHaveAttribute('href', REPO);
    }
    // No separator glyph: the star is what says what the number is.
    expect(container.textContent).not.toContain(' · 1.4K');
    expect(within(container.querySelector('.v2-landing__cta') as HTMLElement).getByTestId('star-count')).toBeInTheDocument();
    expect(within(container.querySelector('.v2-landing__hero') as HTMLElement).getByTestId('star-count')).toBeInTheDocument();
  });

  it('shows no star and no number while there is no count', () => {
    render(<MemoryRouter><V2LandingPage /></MemoryRouter>);
    expect(screen.queryByTestId('star-count')).not.toBeInTheDocument();
    expect(screen.queryByTestId('star-mark')).not.toBeInTheDocument();
  });

  it('keeps the count in the colour of what holds it, never the disabled grey', () => {
    const css = fs.readFileSync(path.join(__dirname, '..', 'v2-landing.css'), 'utf8');
    const rule = /\.v2-landing__star-count \{[^}]*\}/.exec(css)?.[0] ?? '';
    expect(rule).toContain('color: inherit');
    expect(rule).not.toContain('--v2-text-tertiary');
  });

  it('leads with the team: agent teams and works-with come before the feature tour', () => {
    const { container } = render(<MemoryRouter><V2LandingPage /></MemoryRouter>);
    const ids = [...container.querySelectorAll('main section[id]')].map((section) => section.id);
    expect(ids.slice(0, 3)).toEqual(['agent-teams', 'works-with', 'features']);
  });

  it.each(['en', 'zh-CN'])('keeps the board out of the first team card (%s)', (locale) => {
    const card = JSON.stringify(i18n.getResource(locale, 'translation', 'landing.agentTeams.cards.one'));
    expect(card).not.toMatch(/board|TASK-|任务板|看板/i);
  });
});
