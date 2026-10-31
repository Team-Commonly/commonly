import React from 'react';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import axios from 'axios';
import i18n from '../../../i18n';
import { useAuth } from '../../../context/AuthContext';
import V2LandingPage from '../V2LandingPage';

/**
 * Launch row 2. /terms and /privacy shipped with no link reaching them; the
 * footer's Legal column is where a visitor looks for both.
 */

jest.mock('axios');
jest.mock('../../../context/AuthContext', () => ({
  useAuth: jest.fn(),
}));

describe('V2LandingPage legal links', () => {
  beforeEach(async () => {
    (axios.get as jest.Mock).mockResolvedValue({ data: {} });
    (useAuth as jest.Mock).mockReturnValue({ isAuthenticated: false });
    await i18n.changeLanguage('en');
  });

  afterEach(() => jest.clearAllMocks());

  it('links Terms and Privacy from the footer', () => {
    const { container } = render(<MemoryRouter><V2LandingPage /></MemoryRouter>);
    const footer = container.querySelector('footer') as HTMLElement;
    expect(within(footer).getByRole('link', { name: 'Terms' })).toHaveAttribute('href', '/terms');
    expect(within(footer).getByRole('link', { name: 'Privacy' })).toHaveAttribute('href', '/privacy');
  });
});
