// @ts-nocheck
// F662: a wrapped Claude Code or Codex agent runs every turn on its owner's own
// login or key. The page says so before it connects: anyone in a team pod can
// start a turn on it, and in a public or listed pod it answers only its owner.
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import V2AgentBYO from '../components/V2AgentBYO';
import { AuthContext } from '../../context/AuthContext';
import i18n, { i18nReady } from '../../i18n';

jest.mock('../utils/byoTelemetry', () => ({ recordByoStep: jest.fn(), recordByoStepOnce: jest.fn() }));
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

const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)';
const realUserAgent = window.navigator.userAgent;
const setUserAgent = (value) => Object.defineProperty(window.navigator, 'userAgent', { value, configurable: true });

const TEAM_POD = { _id: 'p1', name: 'Workspace', type: 'chat', joinPolicy: 'invite-only', publicRead: false, communityListed: false, createdBy: { _id: 'u1' } };
const LISTED_POD = { ...TEAM_POD, _id: 'p2', name: 'Showcase', communityListed: true, joinPolicy: 'open' };
let pods = [TEAM_POD];
let machines = [];

const TEAM_LINE = (tool) => `${tool} runs on your own login or API key, and anyone in this pod can start a turn on it. `
  + 'For a team, use an API key or a team plan. In public or listed pods it answers only you.';
const OPEN_LINE = 'This pod is open to people outside your team, so this agent will answer only you here. '
  + 'Others can bring their own agent on their own login or key.';

const open = async (mode = 'byo') => {
  render(
    <AuthContext.Provider value={authValue}>
      <MemoryRouter><V2AgentBYO /></MemoryRouter>
    </AuthContext.Provider>,
  );
  fireEvent.click(await screen.findByTestId(`byo-mode-${mode}`));
};

beforeAll(async () => { await i18nReady; });
beforeEach(() => {
  pods = [TEAM_POD];
  machines = [];
  setUserAgent(MAC);
  axios.get.mockImplementation((url) => {
    if (url.startsWith('/api/hosted/availability')) return Promise.resolve({ data: { configured: true, caps: { agentsPerUser: 1, turnsPerDay: 200 } } });
    if (url === '/api/pods') return Promise.resolve({ data: pods });
    if (url === '/api/registry/harness-catalog') {
      return Promise.resolve({
        data: {
          harnesses: [
            { id: 'claude', label: 'Claude Code', models: null, efforts: [] },
            { id: 'codex', label: 'Codex', models: null, efforts: [] },
            { id: 'opencode', label: 'OpenCode', models: null, efforts: [] },
          ],
        },
      });
    }
    if (url === '/api/machines') return Promise.resolve({ data: { machines, offlineAfterMs: 90000 } });
    if (url.startsWith('/api/registry/agents/next-free-name?')) return Promise.resolve({ data: { name: new URLSearchParams(url.split('?')[1]).get('base') } });
    if (url === '/api/users/me/agent-connection') return Promise.resolve({ data: { issued: false } });
    return Promise.resolve({ data: {} });
  });
});
afterEach(async () => {
  jest.clearAllMocks();
  setUserAgent(realUserAgent);
  await act(async () => { await i18n.changeLanguage('en'); });
});

describe('the account line', () => {
  test('shows the team line for Claude Code', async () => {
    await open();
    expect(await screen.findByTestId('byo-account-use')).toHaveTextContent(TEAM_LINE('Claude Code'));
  });

  test('shows the team line for Codex', async () => {
    await open();
    fireEvent.click(await screen.findByTestId('byo-runner-codex'));
    expect(await screen.findByTestId('byo-account-use')).toHaveTextContent(TEAM_LINE('Codex'));
  });

  test('a listed pod gets the open line', async () => {
    pods = [LISTED_POD];
    await open();
    expect(await screen.findByTestId('byo-account-use')).toHaveTextContent(OPEN_LINE);
  });

  test('is hidden for another runner', async () => {
    await open();
    await screen.findByTestId('byo-account-use');
    fireEvent.click(await screen.findByTestId('byo-runner-more'));
    fireEvent.click(await screen.findByTestId('byo-runner-opencode'));
    expect(screen.queryByTestId('byo-account-use')).toBeNull();
  });

  test('shows on a computer already added, by the harness picked there', async () => {
    machines = [{ id: 'm1', machineId: 'mach-a', name: 'Sam’s MacBook', status: 'online', agentStates: [] }];
    await open('machine');
    fireEvent.change(await screen.findByTestId('byo-adapter-select'), { target: { value: 'codex' } });
    expect(await screen.findByTestId('byo-account-use')).toHaveTextContent(TEAM_LINE('Codex'));
    fireEvent.change(screen.getByTestId('byo-adapter-select'), { target: { value: 'opencode' } });
    expect(screen.queryByTestId('byo-account-use')).toBeNull();
  });

  test('is hidden on the hosted path', async () => {
    await open('hosted');
    expect(screen.queryByTestId('byo-account-use')).toBeNull();
  });

  test('zh-CN reads in Chinese', async () => {
    await act(async () => { await i18n.changeLanguage('zh-CN'); });
    await open();
    const line = await screen.findByTestId('byo-account-use');
    expect(line).toHaveTextContent('Claude Code 用的是你自己的登录账号或 API 密钥');
    expect(line).toHaveTextContent('这个 Pod 里的任何人都能让它回复。团队使用的话，建议改用 API 密钥或团队版。');
  });
});
