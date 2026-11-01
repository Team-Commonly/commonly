// @ts-nocheck
// BYO copy telemetry: every copy surface that writes a command must post its
// step. The "Add a computer" daemon command was the one that did not (TASK-653:
// 6 seats were created in a week and no copy step was ever recorded).
import React from 'react';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import V2AgentBYO from '../components/V2AgentBYO';
import { AuthContext } from '../../context/AuthContext';
import { recordByoStep } from '../utils/byoTelemetry';

jest.mock('../utils/byoTelemetry', () => ({
  recordByoStep: jest.fn(),
  recordByoStepOnce: jest.fn(),
  resetByoStepsForTest: jest.fn(),
}));

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

const axios = jest.requireMock('axios').default;

const authValue = {
  currentUser: { _id: 'u1', username: 'sam' },
  user: { _id: 'u1', username: 'sam' },
  token: 'user-jwt',
  loading: false,
  error: null,
  isAuthenticated: true,
  register: jest.fn(),
  login: jest.fn(),
  logout: jest.fn(),
  updateProfile: jest.fn(),
};

const mockGet = () => {
  axios.get.mockImplementation((url) => {
    if (url.startsWith('/api/registry/agents/next-free-name?')) return Promise.resolve({ data: { name: 'agent' } });
    if (url.startsWith('/api/hosted/availability')) {
      return Promise.resolve({ data: { configured: false, caps: { agentsPerUser: 1, turnsPerDay: 200 } } });
    }
    if (url === '/api/pods') return Promise.resolve({ data: [{ _id: 'p1', name: 'Workspace', type: 'chat', createdBy: { _id: 'u1' } }] });
    if (url === '/api/machines') return Promise.resolve({ data: { machines: [], offlineAfterMs: 90000 } });
    return Promise.resolve({ data: {} });
  });
};

const renderPage = () => render(
  <AuthContext.Provider value={authValue}>
    <MemoryRouter>
      <V2AgentBYO />
    </MemoryRouter>
  </AuthContext.Provider>,
);

beforeEach(() => {
  window.history.pushState({}, '', '/v2/agents/byo');
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: jest.fn().mockResolvedValue(undefined) } });
  mockGet();
});

afterEach(() => {
  jest.clearAllMocks();
});

const stepsPosted = () => recordByoStep.mock.calls.map(([, step]) => step);

test('copying the add-a-computer daemon command posts daemon-command-copied', async () => {
  renderPage();
  await waitFor(() => expect(axios.get).toHaveBeenCalledWith('/api/machines', expect.anything()));
  const block = await screen.findByTestId('byo-add-computer');
  await act(async () => {
    fireEvent.click(block.querySelector('button.v2-byo__copy'));
  });

  expect(navigator.clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining('commonly daemon'));
  expect(stepsPosted()).toContain('daemon-command-copied');
});

test('a failed daemon copy posts no copy step', async () => {
  navigator.clipboard.writeText.mockRejectedValueOnce(new Error('Denied'));
  renderPage();
  const block = await screen.findByTestId('byo-add-computer');
  await act(async () => {
    fireEvent.click(block.querySelector('button.v2-byo__copy'));
  });

  expect(stepsPosted()).not.toContain('daemon-command-copied');
});
