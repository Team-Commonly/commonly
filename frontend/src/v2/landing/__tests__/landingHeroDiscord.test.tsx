import fs from 'fs';
import path from 'path';
import React from 'react';
import { render, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import axios from 'axios';
import i18n from '../../../i18n';
import { useAuth } from '../../../context/AuthContext';
import { DISCORD_INVITE_URL } from '../../utils/feedbackLinks';
import V2LandingPage from '../V2LandingPage';

/**
 * D38: the Discord invite is in the hero, not only the footer. It opens the
 * same invite as the in-app feedback links in a new tab, in both languages. It
 * is a text link on the band, never a third key beside the two CTAs.
 */

jest.mock('axios');
jest.mock('../../../context/AuthContext', () => ({
  useAuth: jest.fn(),
}));

const CSS = fs.readFileSync(path.join(__dirname, '..', 'v2-landing.css'), 'utf8');

describe('V2LandingPage hero Discord link', () => {
  beforeEach(() => {
    (axios.get as jest.Mock).mockResolvedValue({ data: {} });
    (useAuth as jest.Mock).mockReturnValue({ isAuthenticated: false });
  });

  afterEach(async () => {
    jest.clearAllMocks();
    await i18n.changeLanguage('en');
  });

  it.each([
    ['en', "Questions? We're on Discord"],
    ['zh-CN', '有问题？来 Discord 找我们'],
  ])('%s: the hero links to the Discord invite in a new tab', async (lng, name) => {
    await i18n.changeLanguage(lng);
    const { container } = render(<MemoryRouter><V2LandingPage /></MemoryRouter>);

    const hero = container.querySelector('.v2-landing__hero') as HTMLElement;
    const link = within(hero).getByRole('link', { name });
    expect(link).toHaveAttribute('href', DISCORD_INVITE_URL);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', expect.stringContaining('noreferrer'));
    expect(link.className).not.toMatch(/v2-landing__btn/);
    expect(link.closest('.v2-landing__cta-row')).toBeNull();
  });

  it('the footer keeps its Discord link too', () => {
    const { container } = render(<MemoryRouter><V2LandingPage /></MemoryRouter>);
    const footer = container.querySelector('.v2-landing__footer') as HTMLElement;
    expect(within(footer).getByRole('link', { name: 'Discord' })).toHaveAttribute('href', DISCORD_INVITE_URL);
  });

  it('the link row takes a full row of the hero actions and reads white on the band', () => {
    expect(CSS).toMatch(/\.v2-landing__hero-community \{[^}]*flex-basis: 100%/);
    expect(CSS).toMatch(/\.v2-root \.v2-landing__hero-community a \{[^}]*color: var\(--v2-on-accent, #ffffff\)/);
  });
});
