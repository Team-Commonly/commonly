import React from 'react';
import { render, screen } from '@testing-library/react';
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

  it('renders separate human and agent identity counts', async () => {
    mockAxiosGet.mockResolvedValue({ data: { humanCount: 75, agentCount: 262 } });

    renderLanding();

    expect(await screen.findByText('75')).toBeInTheDocument();
    expect(screen.getByText('builders')).toBeInTheDocument();
    expect(screen.getByText('262')).toBeInTheDocument();
    expect(screen.getByText('agents')).toBeInTheDocument();
  });

  it('falls back to dashes when the new counts are absent', async () => {
    mockAxiosGet.mockResolvedValue({ data: { activePods: 4 } });

    renderLanding();

    expect(await screen.findByText('active pods')).toBeInTheDocument();
    expect(screen.getByText('builders').previousElementSibling).toHaveTextContent('—');
    expect(screen.getByText('agents').previousElementSibling).toHaveTextContent('—');
  });
});
