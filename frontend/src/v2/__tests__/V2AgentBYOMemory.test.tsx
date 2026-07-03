// @ts-nocheck
// Retention plan Phase C: the optional "bring its memory" step on the BYO
// page. Pins the wire contract: the import uses the freshly issued
// cm_agent_* runtime token (NOT the user JWT), patch mode, sourceRuntime
// 'import-web', and read-then-append semantics.
import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
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

const AGENT_TOKEN = 'cm_agent_test_token';

const renderPage = () => render(
  <AuthContext.Provider value={authValue}>
    <MemoryRouter>
      <V2AgentBYO />
    </MemoryRouter>
  </AuthContext.Provider>,
);

const issueToken = async () => {
  axios.get.mockResolvedValueOnce({ data: [{ _id: 'p1', name: 'Workspace', type: 'chat' }] });
  axios.post
    .mockResolvedValueOnce({ data: { ok: true } }) // /api/registry/install
    .mockResolvedValueOnce({ data: { token: AGENT_TOKEN } }); // runtime-tokens

  renderPage();
  await waitFor(() => expect(screen.getByText('Workspace (chat)')).toBeInTheDocument());
  fireEvent.click(screen.getByRole('button', { name: /install \+ generate token/i }));
  await screen.findByText(/token issued for/i);
};

afterEach(() => jest.clearAllMocks());

describe('V2AgentBYO memory import', () => {
  test('imports pasted memory with the runtime token, patch mode, append semantics', async () => {
    await issueToken();

    // Fresh agent: memory read 404s.
    axios.get.mockRejectedValueOnce({ response: { status: 404 } });
    axios.post.mockResolvedValueOnce({ data: {} }); // memory/sync

    fireEvent.change(screen.getByPlaceholderText(/paste memory\.md/i), {
      target: { value: '## Learned\nthe repo layout' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /import memory/i }));
    });

    await screen.findByText(/memory imported/i);

    const readCall = axios.get.mock.calls.find(([url]) => url === '/api/agents/runtime/memory');
    expect(readCall[1].headers.Authorization).toBe(`Bearer ${AGENT_TOKEN}`);

    const syncCall = axios.post.mock.calls.find(([url]) => url === '/api/agents/runtime/memory/sync');
    const [, body, config] = syncCall;
    expect(config.headers.Authorization).toBe(`Bearer ${AGENT_TOKEN}`);
    expect(body.mode).toBe('patch');
    expect(body.sourceRuntime).toBe('import-web');
    expect(body.sections.long_term.visibility).toBe('private');
    expect(body.sections.long_term.content).toMatch(/^# Imported local memory/);
    expect(body.sections.long_term.content).toContain('the repo layout');
  });

  test('appends after existing long_term content instead of clobbering', async () => {
    await issueToken();

    axios.get.mockResolvedValueOnce({
      data: { sections: { long_term: { content: '## Prior knowledge' } } },
    });
    axios.post.mockResolvedValueOnce({ data: {} });

    fireEvent.change(screen.getByPlaceholderText(/paste memory\.md/i), {
      target: { value: 'new facts' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /import memory/i }));
    });
    await screen.findByText(/memory imported/i);

    const syncCall = axios.post.mock.calls.find(([url]) => url === '/api/agents/runtime/memory/sync');
    expect(syncCall[1].sections.long_term.content.startsWith('## Prior knowledge')).toBe(true);
    expect(syncCall[1].sections.long_term.content).toContain('new facts');
  });

  test('import button stays disabled with nothing pasted; nothing is sent on render', async () => {
    await issueToken();

    expect(screen.getByRole('button', { name: /import memory/i })).toBeDisabled();
    expect(axios.post.mock.calls.some(([url]) => url === '/api/agents/runtime/memory/sync')).toBe(false);
  });
});
