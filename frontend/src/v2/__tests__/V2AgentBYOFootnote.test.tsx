// @ts-nocheck
// Keep setup request assertions independent of funnel telemetry.
jest.mock('../utils/byoTelemetry', () => ({ recordByoStep: jest.fn() }));
// The CLI footnote must describe the connection available after install.
// `agent init` scaffolds a Python webhook and does not connect Claude/Codex.
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import V2AgentBYO from '../components/V2AgentBYO';
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

beforeEach(() => {
  axios.get.mockImplementation((url) => {
    if (url.startsWith('/api/hosted/availability')) {
      return Promise.resolve({ data: { configured: true, caps: { agentsPerUser: 1, turnsPerDay: 200 } } });
    }
    if (url === '/api/pods') return Promise.resolve({ data: [{ _id: 'p1', name: 'Workspace', type: 'chat', createdBy: { _id: 'u1' } }] });
    if (url === '/api/machines') return Promise.resolve({ data: { machines: [], offlineAfterMs: 90000 } });
    return Promise.resolve({ data: {} });
  });
});

const renderPage = () => render(
  <AuthContext.Provider value={authValue}>
    <MemoryRouter>
      <V2AgentBYO />
    </MemoryRouter>
  </AuthContext.Provider>,
);

describe('V2AgentBYO footnote', () => {
  const modeTitle = (testId) => screen.getByTestId(testId).querySelector('.v2-byo__mode-title').textContent;
  const realUserAgent = window.navigator.userAgent;
  const setUserAgent = (value) => Object.defineProperty(window.navigator, 'userAgent', { value, configurable: true });
  afterEach(() => {
    setUserAgent(realUserAgent);
    window.history.replaceState({}, '', '/');
  });

  test('names the runtime mode leading to the listener, even from Run it here', async () => {
    setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)');
    renderPage();
    const footnote = await screen.findByText(/Prefer the CLI\?/);
    await screen.findByTestId('byo-mode-byo');
    expect(footnote).toHaveTextContent(`Choose “${modeTitle('byo-mode-byo')}”; after install`);
    expect(footnote).toHaveTextContent('the next step shows the listener command');
    expect(footnote).not.toHaveTextContent('commonly agent init');

    fireEvent.click(await screen.findByTestId('byo-mode-hosted'));
    expect(footnote).toHaveTextContent(`Choose “${modeTitle('byo-mode-byo')}”; after install`);
  });

  // D245: the listener runs on Windows too (unsandboxed), so the footnote is the same as a Mac's.
  test.each([[''], ['?adapter=codex']])('on Windows (%s), the footnote points to the listener command', async (query) => {
    setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64)');
    window.history.replaceState({}, '', `/${query}`);
    renderPage();
    const footnote = await screen.findByText(/Prefer the CLI\?/);
    await screen.findByTestId('byo-mode-byo');
    expect(footnote).toHaveTextContent(`Choose “${modeTitle('byo-mode-byo')}”; after install`);
    expect(footnote).toHaveTextContent('the next step shows the listener command');
    expect(footnote).not.toHaveTextContent(/supported computer|on a Mac computer/);
  });

  test('on Linux with Codex, the footnote still points to a Mac or hosting', async () => {
    setUserAgent('Mozilla/5.0 (X11; Linux x86_64)');
    window.history.replaceState({}, '', '/?adapter=codex');
    renderPage();
    const footnote = await screen.findByText(/Prefer the CLI\?/);
    await screen.findByTestId('byo-mode-byo');
    expect(footnote).toHaveTextContent('run the listener on a Mac computer');
    expect(footnote).toHaveTextContent(`To answer @mentions from Linux, choose “${modeTitle('byo-mode-hosted')}”`);
  });
});
