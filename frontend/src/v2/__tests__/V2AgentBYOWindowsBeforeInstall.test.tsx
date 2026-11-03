// @ts-nocheck
// Keep setup request assertions independent of funnel telemetry.
jest.mock('../utils/byoTelemetry', () => ({ recordByoStep: jest.fn() }));
// On a computer where the listener can't run (Windows), the page says before the
// agent is created that it won't answer @mentions, and leads with "Run it here".
// Earned 11-02: an outside user on Windows created four agents that never ran,
// because that warning came only after install.
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
      return Promise.resolve({ data: { configured: hostingConfigured, caps: { agentsPerUser: 1, turnsPerDay: 200 } } });
    }
    if (url === '/api/pods') return Promise.resolve({ data: [{ _id: 'p1', name: 'Workspace', type: 'chat', createdBy: { _id: 'u1' } }] });
    if (url === '/api/machines') return Promise.resolve({ data: { machines: [], offlineAfterMs: 90000 } });
    return Promise.resolve({ data: {} });
  });
});

let hostingConfigured = true;
const renderPage = () => render(
  <AuthContext.Provider value={authValue}>
    <MemoryRouter>
      <V2AgentBYO />
    </MemoryRouter>
  </AuthContext.Provider>,
);

describe('V2AgentBYO: before install on a computer the listener cannot run on', () => {
  const realUserAgent = window.navigator.userAgent;
  const setUserAgent = (value) => Object.defineProperty(window.navigator, 'userAgent', { value, configurable: true });
  const WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';
  const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)';
  afterEach(() => {
    setUserAgent(realUserAgent);
    hostingConfigured = true;
    window.history.replaceState({}, '', '/');
  });

  test('on Windows, choosing your own agent says it will not answer @mentions and leads with Run it here', async () => {
    setUserAgent(WINDOWS);
    renderPage();
    fireEvent.click(await screen.findByTestId('byo-mode-byo'));

    const notice = await screen.findByTestId('byo-wont-answer-before-install');
    expect(notice).toHaveAttribute('role', 'status');
    expect(notice).toHaveTextContent('On Windows, Claude Code can’t answer @mentions yet');
    expect(notice).toHaveTextContent('won’t reply when someone @mentions it');
    const runHere = screen.getByTestId('byo-wont-answer-run-here');
    expect(runHere).toHaveTextContent('Run it here');
    expect(runHere).toHaveClass('v2-byo__submit');
    // The connect-command button stays, but no longer as the lead action.
    const install = screen.getByRole('button', { name: /^Get my connect command/ });
    expect(install).toHaveClass('v2-byo__submit--quiet');
    expect(runHere.compareDocumentPosition(install) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fireEvent.click(runHere);
    expect(screen.getByTestId('byo-mode-hosted')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByTestId('byo-wont-answer-before-install')).not.toBeInTheDocument();
  });

  test('on Windows with the Codex CLI, the notice names Codex', async () => {
    setUserAgent(WINDOWS);
    window.history.replaceState({}, '', '/?adapter=codex');
    renderPage();
    fireEvent.click(await screen.findByTestId('byo-mode-byo'));

    expect(await screen.findByTestId('byo-wont-answer-before-install')).toHaveTextContent('On Windows, the Codex CLI can’t answer @mentions yet');
  });

  test('on Windows without hosting, it says so and points to a Mac instead of a button that is not there', async () => {
    setUserAgent(WINDOWS);
    hostingConfigured = false;
    renderPage();

    const notice = await screen.findByTestId('byo-wont-answer-before-install');
    expect(notice).toHaveTextContent('connect from a Mac');
    expect(screen.queryByTestId('byo-wont-answer-run-here')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Get my connect command/ })).not.toHaveClass('v2-byo__submit--quiet');
  });

  test('on a Mac, where the listener runs, there is no notice and Install leads', async () => {
    setUserAgent(MAC);
    renderPage();
    fireEvent.click(await screen.findByTestId('byo-mode-byo'));

    expect(await screen.findByRole('button', { name: /^Get my connect command/ })).not.toHaveClass('v2-byo__submit--quiet');
    expect(screen.queryByTestId('byo-wont-answer-before-install')).not.toBeInTheDocument();
  });

  test('on Linux, where the pod decides, there is no Windows notice', async () => {
    setUserAgent('Mozilla/5.0 (X11; Linux x86_64)');
    renderPage();
    fireEvent.click(await screen.findByTestId('byo-mode-byo'));

    await screen.findByRole('button', { name: /^Get my connect command/ });
    expect(screen.queryByTestId('byo-wont-answer-before-install')).not.toBeInTheDocument();
  });
});
