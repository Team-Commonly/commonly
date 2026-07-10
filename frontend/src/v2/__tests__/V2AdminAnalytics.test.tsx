// @ts-nocheck
// Wave 0 (GH#662): admin usage dashboard renders cards + funnel from the
// analytics endpoints, and degrades gracefully on zero data / API failure.
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import V2AdminAnalytics from '../components/V2AdminAnalytics';
import { AuthContext } from '../../context/AuthContext';

jest.mock('axios', () => {
  const mock = {
    get: jest.fn(),
    post: jest.fn(),
    patch: jest.fn(),
    delete: jest.fn(),
    defaults: { baseURL: '', headers: { common: {} } },
    interceptors: {
      request: { use: jest.fn(), eject: jest.fn() },
      response: { use: jest.fn(), eject: jest.fn() },
    },
  };
  return { __esModule: true, default: mock, ...mock };
});
const axios = require('axios');

const authValue = {
  currentUser: { _id: 'admin1', username: 'admin', role: 'admin' },
  user: { _id: 'admin1', username: 'admin', role: 'admin' },
  token: 't',
  loading: false,
  error: null,
  isAuthenticated: true,
  register: jest.fn(),
  login: jest.fn(),
  logout: jest.fn(),
  updateProfile: jest.fn(),
};

const renderPage = () => render(
  <MemoryRouter>
    <AuthContext.Provider value={authValue}>
      <V2AdminAnalytics />
    </AuthContext.Provider>
  </MemoryRouter>,
);

const usagePayload = {
  days: 30,
  daily: [
    { date: '2026-07-08', signups: 2, messages: 40, posters: 3 },
    { date: '2026-07-09', signups: 1, messages: 12, posters: 2 },
  ],
  totals: { signups: 3, messages: 52, dau: 2, wau: 4, totalUsers: 11 },
};

const funnelPayload = {
  days: 30,
  cohorts: [
    { date: '2026-07-08', signups: 2, attachedAgent: 1, sentMessage: 1, returnedD1: 1, returnedD7: 0 },
  ],
  totals: {
    signups: 3, attachedAgent: 1, sentMessage: 1, returnedD1: 1, returnedD7: 0,
    attachRatePct: 33, messageRatePct: 33, d1ReturnPct: 33, d7ReturnPct: 0,
  },
};

describe('V2AdminAnalytics', () => {
  beforeEach(() => jest.clearAllMocks());

  it('renders cards, charts, and the funnel table', async () => {
    axios.get.mockImplementation((url) => {
      if (url.includes('/usage')) return Promise.resolve({ data: usagePayload });
      if (url.includes('/funnel')) return Promise.resolve({ data: funnelPayload });
      return Promise.reject(new Error(`unexpected ${url}`));
    });
    renderPage();

    await waitFor(() => expect(screen.getByText('Active today')).toBeInTheDocument());
    expect(screen.getByText('Total users')).toBeInTheDocument();
    expect(screen.getByText('11')).toBeInTheDocument();
    expect(screen.getByText('Signups / day')).toBeInTheDocument();
    expect(screen.getByText('Messages / day')).toBeInTheDocument();
    expect(screen.getByText('Activation funnel')).toBeInTheDocument();
    expect(screen.getByText(/33% attached an agent/)).toBeInTheDocument();
    expect(screen.getByText('2026-07-08')).toBeInTheDocument();
  });

  it('renders with zero data without crashing', async () => {
    axios.get.mockImplementation((url) => {
      if (url.includes('/usage')) {
        return Promise.resolve({
          data: { days: 30, daily: [], totals: { signups: 0, messages: 0, dau: 0, wau: 0, totalUsers: 0 } },
        });
      }
      return Promise.resolve({
        data: {
          days: 30,
          cohorts: [],
          totals: {
            signups: 0, attachedAgent: 0, sentMessage: 0, returnedD1: 0, returnedD7: 0,
            attachRatePct: 0, messageRatePct: 0, d1ReturnPct: 0, d7ReturnPct: 0,
          },
        },
      });
    });
    renderPage();
    await waitFor(() => expect(screen.getByText('Active today')).toBeInTheDocument());
    expect(screen.getByText(/Of 0 signups/)).toBeInTheDocument();
  });

  it('surfaces an error message when the API fails', async () => {
    axios.get.mockRejectedValue({ response: { data: { message: 'Failed to compute usage' } } });
    renderPage();
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Failed to compute usage'));
  });
});
