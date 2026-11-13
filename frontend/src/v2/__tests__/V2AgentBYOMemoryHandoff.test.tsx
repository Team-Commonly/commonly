// @ts-nocheck
// A pod's handoff card sends Claude Code and Codex on Windows to this page
// instead of showing `agent attach --memory-from <hosted agent>`. The link
// carries that source (?memoryFrom=&memoryInstance=), and the install the page
// makes copies the hosted agent's long-term memory, as the attach line would.
// The server checks the person owns both agents; the page only passes it on.
jest.mock('../utils/byoTelemetry', () => ({ recordByoStep: jest.fn(), recordByoStepOnce: jest.fn() }));
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import V2AgentBYO from '../components/V2AgentBYO';
import { AuthContext } from '../../context/AuthContext';

jest.mock('../components/V2NavRail', () => () => null);
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

const pods = [{ _id: 'aaa111', name: 'Workspace', type: 'chat', createdBy: { _id: 'u1' } }];

beforeEach(() => {
  axios.get.mockImplementation((url) => {
    if (url.startsWith('/api/registry/agents/next-free-name?')) return Promise.resolve({ data: { name: new URLSearchParams(url.split('?')[1]).get('base') } });
    if (url === '/api/pods') return Promise.resolve({ data: pods });
    if (url === '/api/machines') return Promise.resolve({ data: { machines: [] } });
    return Promise.resolve({ data: {} });
  });
  axios.post
    .mockResolvedValueOnce({ data: { ok: true } }) // /api/registry/install
    .mockResolvedValueOnce({ data: { token: 'cm_agent_test_token' } }); // runtime-tokens
});

afterEach(() => {
  jest.clearAllMocks();
  window.history.pushState({}, '', '/');
});

const renderAt = (url) => {
  window.history.pushState({}, '', url);
  return render(
    <AuthContext.Provider value={authValue}>
      <MemoryRouter initialEntries={[url]}>
        <V2AgentBYO />
      </MemoryRouter>
    </AuthContext.Provider>,
  );
};

const installRequest = async () => {
  const act = await screen.findByRole('button', { name: /^Get my connect command/ });
  await waitFor(() => expect(act).toBeEnabled());
  fireEvent.click(act);
  await screen.findByTestId('byo-listen');
  return axios.post.mock.calls.find(([url]) => url === '/api/registry/install')[1];
};

describe('a handoff card link that carries the hosted agent\'s memory', () => {
  test('says the agent starts with that memory, and the install asks for the copy', async () => {
    renderAt('/v2/agents/byo?pod=aaa111&name=sam-codex&adapter=codex&memoryFrom=scout&memoryInstance=hosted-123');
    expect(await screen.findByTestId('byo-memory-handoff')).toHaveTextContent('It starts with scout’s long-term memory');
    const body = await installRequest();
    expect(body).toMatchObject({
      agentName: 'sam-codex',
      podId: 'aaa111',
      memoryFrom: { agentName: 'scout', instanceId: 'hosted-123' },
      config: { runtime: { runtimeType: 'webhook', adapter: 'codex', host: 'byo' } },
    });
  });

  test('a missing instance means the default one', async () => {
    renderAt('/v2/agents/byo?pod=aaa111&name=sam-codex&adapter=codex&memoryFrom=scout');
    const body = await installRequest();
    expect(body.memoryFrom).toEqual({ agentName: 'scout', instanceId: 'default' });
  });

  test('a source the handoff service would refuse is ignored: no note, no copy', async () => {
    renderAt('/v2/agents/byo?pod=aaa111&name=sam-codex&adapter=codex&memoryFrom=Scout%20X');
    const body = await installRequest();
    expect(screen.queryByTestId('byo-memory-handoff')).toBeNull();
    expect(body).not.toHaveProperty('memoryFrom');
    expect(body.config.runtime).not.toHaveProperty('host');
  });

  test('without a source, the install is what it always was', async () => {
    renderAt('/v2/agents/byo?pod=aaa111&name=sam-codex&adapter=codex');
    const body = await installRequest();
    expect(screen.queryByTestId('byo-memory-handoff')).toBeNull();
    expect(body).not.toHaveProperty('memoryFrom');
    expect(body.config.runtime).not.toHaveProperty('host');
  });
});

// A Mac or Linux browser can pick the card's Windows tab. The link says so, and
// the page sets up for Windows instead of the browser's own OS.
describe('the OS a handoff card link names', () => {
  test('a Mac browser following a Windows link gets the PowerShell lines', async () => {
    renderAt('/v2/agents/byo?pod=aaa111&name=sam-claude&adapter=claude&os=windows&memoryFrom=scout');
    await installRequest();
    expect(screen.getByTestId('byo-listen')).toHaveTextContent('npm.cmd i -g @commonlyai/cli@latest');
    expect(screen.getByTestId('byo-listen')).toHaveTextContent('$env:COMMONLY_AGENT_TOKEN');
  });

  test('without an OS, or with one the page does not offer, it keeps the browser\'s', async () => {
    renderAt('/v2/agents/byo?pod=aaa111&name=sam-codex&adapter=codex&os=solaris');
    await installRequest();
    expect(screen.getByTestId('byo-listen')).not.toHaveTextContent('npm.cmd');
    expect(screen.getByTestId('byo-listen')).toHaveTextContent('export COMMONLY_AGENT_TOKEN');
  });
});
