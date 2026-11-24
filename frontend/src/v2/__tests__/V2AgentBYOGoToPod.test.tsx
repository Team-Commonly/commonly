// @ts-nocheck
// F573: the hosted path's "Go to your pod" opens the pod with the composer
// already addressed to the new agent (navigation state `composeDraft`, Walk 4).
// The BYO path's "Go to your pod" opened an empty composer, so a person whose agent
// had just started listening still had to type its handle. It now carries the
// same `@<agentName> ` draft through the same state. A second instance of a
// name shares the pod with its sibling, where the bare name reaches nobody
// (agentMentionService answers it only for a single install), so its draft
// names the instance's username, `<agentName>-<instanceId>`.
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import V2AgentBYO from '../components/V2AgentBYO';
import { AuthContext } from '../../context/AuthContext';

jest.mock('../utils/byoTelemetry', () => ({ recordByoStep: jest.fn() }));
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

const mockServer = () => {
  axios.get.mockImplementation((url) => {
    if (url === '/api/pods') return Promise.resolve({ data: [{ _id: 'abc1', name: 'Workspace', type: 'chat' }] });
    if (url.startsWith('/api/registry/agents/next-free-name?')) return Promise.resolve({ data: { name: new URLSearchParams(url.split('?')[1]).get('base') } });
    return Promise.resolve({ data: {} });
  });
  axios.post.mockImplementation((url) => (/runtime-tokens/.test(url)
    ? Promise.resolve({ data: { token: 'cm_agent_test_token' } })
    : Promise.resolve({ data: { ok: true } })));
};

// Issues a key on the page at `search`, clicks "Go to your pod", and returns
// where the router landed.
const goToPodFrom = async (search) => {
  mockServer();
  window.history.pushState({}, '', `/v2/agents/byo${search}`);
  let landed;
  const Probe = () => { landed = useLocation(); return null; };
  render(
    <AuthContext.Provider value={authValue}>
      <MemoryRouter initialEntries={[`/v2/agents/byo${search}`]}>
        <Routes>
          <Route path="/v2/agents/byo" element={<V2AgentBYO />} />
          <Route path="/v2/pods/:podId" element={<Probe />} />
        </Routes>
      </MemoryRouter>
    </AuthContext.Provider>,
  );
  await waitFor(() => expect(screen.getByText('Workspace (chat)')).toBeInTheDocument());
  await waitFor(() => expect(screen.getByRole('button', { name: /get my connect command/i })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: /get my connect command/i }));
  await screen.findByText(/your connect command for/i);
  fireEvent.click(screen.getByRole('button', { name: /go to your pod/i }));
  return landed;
};

beforeEach(() => jest.clearAllMocks());
afterEach(() => window.history.pushState({}, '', '/'));

test('BYO "Go to your pod" opens the pod with the composer addressed to the new agent, as hosted does', async () => {
  const landed = await goToPodFrom('');
  expect(landed.pathname).toBe('/v2/pods/abc1');
  expect(landed.state).toEqual({ composeDraft: '@sam-claude ' });
});

test('the default instance of a linked agent keeps the bare name', async () => {
  const landed = await goToPodFrom('?pod=abc1&name=sam-claude&instanceId=default&reconnect=1');
  expect(landed.state).toEqual({ composeDraft: '@sam-claude ' });
});

test('a second instance drafts its own username, which routes to that instance alone', async () => {
  const landed = await goToPodFrom('?pod=abc1&name=sam-claude&instanceId=nova&reconnect=1');
  expect(landed.pathname).toBe('/v2/pods/abc1');
  expect(landed.state).toEqual({ composeDraft: '@sam-claude-nova ' });
});
