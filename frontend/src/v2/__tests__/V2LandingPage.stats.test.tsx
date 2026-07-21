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

describe('V2LandingPage proof stats', () => {
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
});
