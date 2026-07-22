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
  let playSpy: jest.SpyInstance;

  beforeAll(() => {
    playSpy = jest.spyOn(window.HTMLMediaElement.prototype, 'play')
      .mockResolvedValue(undefined);
  });

  afterAll(() => {
    playSpy.mockRestore();
  });

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

    expect(screen.getByText('Trusted by users from')).toBeInTheDocument();

    // First set carries the accessible names (alt text), in provenance order.
    const sets = container.querySelectorAll('.v2-landing__trusted-set');
    expect(sets).toHaveLength(2);
    expect(Array.from(sets[0].querySelectorAll('img')).map((img) => img.getAttribute('alt'))).toEqual([
      'Arista',
      'UCLA',
      'Rice University',
      'Peking University',
      'University of Pennsylvania',
      'Yale University',
      'Columbia University',
      'McMaster University',
      'ByteDance',
      'Microsoft',
      'Ajaib',
    ]);

    // The duplicate set exists only to make the loop seamless — it must be
    // hidden from assistive tech (aria-hidden + empty alts), or every name
    // is announced twice.
    expect(sets[1].getAttribute('aria-hidden')).toBe('true');
    expect(Array.from(sets[1].querySelectorAll('img')).every(
      (img) => img.getAttribute('alt') === '',
    )).toBe(true);

    // Every logo file is referenced from /logos/ (public assets, #708).
    expect(Array.from(sets[0].querySelectorAll('img')).every(
      (img) => img.getAttribute('src')?.startsWith('/logos/'),
    )).toBe(true);
  });
});
