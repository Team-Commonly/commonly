import React from 'react';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import axios from 'axios';
import { useAuth } from '../../context/AuthContext';
import V2LandingPage from '../landing/V2LandingPage';

jest.mock('axios');
jest.mock('../../context/AuthContext', () => ({
  useAuth: jest.fn(),
}));

const mockAxiosGet = axios.get as jest.Mock;
const mockUseAuth = useAuth as jest.Mock;

const renderLanding = () => render(
  <MemoryRouter>
    <V2LandingPage />
  </MemoryRouter>,
);

describe('V2LandingPage public proof', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseAuth.mockReturnValue({ isAuthenticated: false });
  });

  it('renders only agent and activity stats', async () => {
    mockAxiosGet.mockResolvedValue({
      data: {
        activePods: 12,
        activeAgents: 3,
        messageCount24h: 1234,
        agentCount: 262,
      },
    });

    renderLanding();

    const agentsLabel = await screen.findByText('agents');
    const statsRow = agentsLabel.closest('.v2-landing__proof-stats');
    expect(statsRow).not.toBeNull();

    const stats = within(statsRow as HTMLElement);
    expect(agentsLabel.previousElementSibling).toHaveTextContent('262');
    expect(stats.getByText('messages / 24h').previousElementSibling).toHaveTextContent('1,234');
    expect(stats.getByText('active pods').previousElementSibling).toHaveTextContent('12');
    expect(stats.queryByText('builders')).not.toBeInTheDocument();
    expect(stats.queryByText('people')).not.toBeInTheDocument();
    expect(stats.queryByText('ADRs')).not.toBeInTheDocument();
    expect(statsRow?.children).toHaveLength(3);
  });

  it('renders the provenance-backed trusted-by logo marquee', () => {
    mockAxiosGet.mockResolvedValue({ data: {} });

    const { container } = renderLanding();

    expect(screen.getByText('Trusted by people from')).toBeInTheDocument();

    // First set carries the accessible names (alt text), in list order. All
    // 24 entries are logos; each has a row in
    // docs/design/landing-trusted-banner-provenance.md.
    const sets = container.querySelectorAll('.v2-landing__trusted-set');
    expect(sets).toHaveLength(2);
    const names = [
      'Arista',
      'UCLA',
      'Rice University',
      'Peking University',
      'University of Pennsylvania',
      'Yale University',
      'Columbia University',
      'McMaster University',
      'University of Illinois',
      'ByteDance',
      'Microsoft',
      'Ajaib',
      'OROZ',
      'CLCK',
      'Ollow',
      'Verifran',
      'AIMS',
      'Fluxr',
      'Cyber Solutions',
      'Altur',
      'ILOapps',
      'Rivne Tech',
      'NewTech Kuwait',
      'Ada',
    ];
    expect(Array.from(sets[0].querySelectorAll('img')).map((img) => img.getAttribute('alt'))).toEqual(names);

    // The duplicate set exists only to make the loop seamless — it must be
    // hidden from assistive tech (aria-hidden + empty alts), or every name
    // is announced twice.
    expect(sets[1].getAttribute('aria-hidden')).toBe('true');
    expect(Array.from(sets[1].querySelectorAll('img')).every(
      (img) => img.getAttribute('alt') === '',
    )).toBe(true);

    // Every logo file is referenced from /logos/ (public assets; sources in
    // docs/design/landing-trusted-banner-provenance.md).
    expect(Array.from(sets[0].querySelectorAll('img')).every(
      (img) => img.getAttribute('src')?.startsWith('/logos/'),
    )).toBe(true);

    // Each name is announced exactly once: one alt in the first set, nothing
    // in the hidden copy, and the section label lists every name.
    const section = container.querySelector('.v2-landing__trusted');
    for (const name of names) {
      expect(screen.getAllByAltText(name)).toHaveLength(1);
      expect(section?.getAttribute('aria-label')).toContain(name);
    }
    expect(sets[1].querySelectorAll('img')).toHaveLength(names.length);
  });
});
