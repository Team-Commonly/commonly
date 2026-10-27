import React from 'react';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import axios from 'axios';
import i18n from '../../../i18n';
import { useAuth } from '../../../context/AuthContext';
import V2LandingPage from '../V2LandingPage';

/**
 * D139. The repo star ask appears in the nav and the open-source section as well
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

  afterEach(() => jest.clearAllMocks());

  it('asks for a star in the nav, the open-source section and the final CTA', () => {
    const { container } = render(<MemoryRouter><V2LandingPage /></MemoryRouter>);

    const nav = screen.getByRole('navigation', { name: i18n.t('landing.nav.primary') });
    expect(within(nav).getByRole('link', { name: 'Star on GitHub' })).toHaveAttribute('href', REPO);

    const open = container.querySelector('.v2-landing__open') as HTMLElement;
    expect(within(open).getByRole('link', { name: 'Star on GitHub' })).toHaveAttribute('href', REPO);

    const cta = container.querySelector('.v2-landing__cta') as HTMLElement;
    expect(within(cta).getByRole('link', { name: 'Star on GitHub' })).toHaveAttribute('href', REPO);
  });
});
