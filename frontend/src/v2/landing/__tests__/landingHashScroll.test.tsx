import React from 'react';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import axios from 'axios';
import { useAuth } from '../../../context/AuthContext';
import V2LandingPage from '../V2LandingPage';

/**
 * TASK-531. The /pricing redirect targets `/#pricing`. The browser's own
 * fragment scroll runs before React has rendered the sections, so a fresh load
 * stayed at the hero (Lumen measured scrollY 0 at 1440 and 390). The landing
 * must scroll the hash target itself once mounted.
 *
 * Mutation: delete the effect, and the first test fails because
 * scrollIntoView is never called on #pricing.
 */

jest.mock('axios');
jest.mock('../../../context/AuthContext', () => ({
  useAuth: jest.fn(),
}));

const mockAxiosGet = axios.get as jest.Mock;
const mockUseAuth = useAuth as jest.Mock;

describe('V2LandingPage hash scroll', () => {
  let scrollSpy: jest.SpyInstance;

  beforeEach(() => {
    mockAxiosGet.mockResolvedValue({ data: {} });
    mockUseAuth.mockReturnValue({ isAuthenticated: false });
    // jsdom has no layout and no scrollIntoView, so give it one to spy on.
    if (!Element.prototype.scrollIntoView) {
      Element.prototype.scrollIntoView = () => {};
    }
    scrollSpy = jest.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {});
  });

  afterEach(() => {
    scrollSpy.mockRestore();
    window.location.hash = '';
    jest.clearAllMocks();
  });

  it('scrolls the #pricing section into view on a fresh load of /#pricing', () => {
    window.location.hash = '#pricing';
    render(<MemoryRouter><V2LandingPage /></MemoryRouter>);

    expect(scrollSpy).toHaveBeenCalledTimes(1);
    expect(scrollSpy.mock.instances[0]).toBe(document.getElementById('pricing'));
    // Smooth scroll ends short of the target on mobile, under the sticky bar.
    expect(scrollSpy).toHaveBeenCalledWith({ behavior: 'instant' });
  });

  it('does not scroll when there is no hash', () => {
    window.location.hash = '';
    render(<MemoryRouter><V2LandingPage /></MemoryRouter>);

    expect(scrollSpy).not.toHaveBeenCalled();
  });
});
