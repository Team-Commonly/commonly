// @ts-nocheck
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import V2AgentSettingsPage from '../agents/V2AgentSettingsPage';
import { AuthContext } from '../../context/AuthContext';

jest.mock('axios', () => {
  const mock = {
    get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn(),
    defaults: { baseURL: '', headers: { common: {} } },
    interceptors: { request: { use: jest.fn() }, response: { use: jest.fn() } },
  };
  return { __esModule: true, default: mock, ...mock };
});
const axios = jest.requireMock('axios').default;
const authValue = {
  currentUser: { _id: 'owner', username: 'owner' }, user: { _id: 'owner', username: 'owner' },
  token: 'user-jwt', loading: false, error: null, isAuthenticated: true,
  register: jest.fn(), login: jest.fn(), signInWithToken: jest.fn(), logout: jest.fn(), updateProfile: jest.fn(),
};

const renderPage = (path = '/v2/agents/maya-claude/default') => render(
  <AuthContext.Provider value={authValue}>
    <MemoryRouter initialEntries={[path]}>
      <Routes><Route path="/v2/agents/:agentName/:instanceId" element={<V2AgentSettingsPage />} /></Routes>
    </MemoryRouter>
  </AuthContext.Provider>,
);

beforeEach(() => {
  jest.clearAllMocks();
  axios.get.mockImplementation((url) => {
    if (url.startsWith('/api/agent-memory/')) return Promise.resolve({ data: {
      displayName: 'Maya', pods: [{ id: 'pod-1', name: 'Workspace' }],
    } });
    if (url.startsWith('/api/registry/pods/')) return Promise.resolve({ data: { agent: {
      name: 'maya-claude', instanceId: 'default', displayName: 'Maya', runtime: { runtimeType: 'webhook' },
    } } });
    return Promise.resolve({ data: [{
      _id: 'tok-1', label: 'Laptop', createdAt: '2026-10-01T00:00:00Z', lastUsedAt: null, revokedAt: null, status: 'active',
    }] });
  });
});

test('wrapper key replacement cannot bypass the daemon reconnect flow', async () => {
  axios.get.mockImplementation((url) => {
    if (url.startsWith('/api/agent-memory/')) return Promise.resolve({ data: {
      displayName: 'Maya', pods: [{ id: 'pod-1', name: 'Workspace' }],
    } });
    if (url.startsWith('/api/registry/pods/')) return Promise.resolve({ data: { agent: {
      name: 'maya-claude', instanceId: 'default', displayName: 'Maya', runtime: { runtimeType: 'wrapper' },
    } } });
    return Promise.resolve({ data: [] });
  });
  renderPage();
  await screen.findByText('Key replacement is unavailable here for locally connected agents.');
  expect(screen.queryByRole('button', { name: 'Regenerate key' })).not.toBeInTheDocument();
  expect(screen.queryByRole('link', { name: 'Reconnect to regenerate key' })).not.toBeInTheDocument();
  expect(axios.post).not.toHaveBeenCalled();
});

test('nondefault wrapper instances never link to a default-instance reconnect', async () => {
  axios.get.mockImplementation((url) => {
    if (url.startsWith('/api/agent-memory/')) return Promise.resolve({ data: {
      displayName: 'Maya', pods: [{ id: 'pod-1', name: 'Workspace' }],
    } });
    if (url.startsWith('/api/registry/pods/')) return Promise.resolve({ data: { agent: {
      name: 'maya-claude', instanceId: 'second', displayName: 'Maya', runtime: { runtimeType: 'wrapper' },
    } } });
    return Promise.resolve({ data: [] });
  });
  renderPage('/v2/agents/maya-claude/second');
  await screen.findByText('Key replacement is unavailable here for locally connected agents.');
  expect(screen.queryByRole('link', { name: 'Reconnect to regenerate key' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Regenerate key' })).not.toBeInTheDocument();
});

test('regeneration waits for the explicit running-key replacement confirmation', async () => {
  axios.post.mockResolvedValue({ data: { token: 'cm_agent_once' } });
  renderPage();
  await screen.findByText('Laptop');
  fireEvent.click(screen.getByRole('button', { name: 'Regenerate key' }));
  expect(axios.post).not.toHaveBeenCalled();
  expect(screen.getByTestId('agent-key-replace-confirmation')).toHaveTextContent('Replacing it will disconnect');
  fireEvent.click(screen.getByRole('button', { name: /keep the current key/i }));
  expect(axios.post).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Regenerate key' }));
  fireEvent.click(screen.getByRole('button', { name: /replace the running agent/i }));
  await waitFor(() => expect(axios.post).toHaveBeenCalledWith(
    '/api/registry/pods/pod-1/agents/maya-claude/runtime-tokens',
    { instanceId: 'default', label: 'Agent Settings replacement', force: true },
  ));
  expect(await screen.findByTestId('agent-one-time-key')).toHaveTextContent('cm_agent_once');
});

test('an in-flight replacement never reveals its key on another agent page', async () => {
  let finishPost;
  axios.post.mockImplementation(() => new Promise((resolve) => { finishPost = resolve; }));
  axios.get.mockImplementation((url, options) => {
    const other = url.includes('/other/') || options?.params?.agentName === 'other';
    if (url.startsWith('/api/agent-memory/')) return Promise.resolve({ data: {
      displayName: other ? 'Other agent' : 'Maya', pods: [{ id: 'pod-1', name: 'Workspace' }],
    } });
    if (url.startsWith('/api/registry/pods/')) return Promise.resolve({ data: { agent: {
      name: other ? 'other' : 'maya-claude', instanceId: 'default',
      displayName: other ? 'Other agent' : 'Maya', runtime: { runtimeType: 'webhook' },
    } } });
    return Promise.resolve({ data: other ? [] : [{ _id: 'tok-1', label: 'Laptop', status: 'active' }] });
  });
  const NextAgent = () => {
    const navigate = useNavigate();
    return <button type="button" onClick={() => navigate('/v2/agents/other/default')}>Next agent</button>;
  };
  render(
    <AuthContext.Provider value={authValue}>
      <MemoryRouter initialEntries={['/v2/agents/maya-claude/default']}>
        <NextAgent />
        <Routes><Route path="/v2/agents/:agentName/:instanceId" element={<V2AgentSettingsPage />} /></Routes>
      </MemoryRouter>
    </AuthContext.Provider>,
  );
  await screen.findByText('Laptop');
  fireEvent.click(screen.getByRole('button', { name: 'Regenerate key' }));
  fireEvent.click(screen.getByRole('button', { name: /replace the running agent/i }));
  await waitFor(() => expect(axios.post).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole('button', { name: 'Next agent' }));
  await screen.findByText('Other agent');
  await act(async () => { finishPost({ data: { token: 'cm_agent_old_identity' } }); });
  expect(screen.queryByTestId('agent-one-time-key')).not.toBeInTheDocument();
  expect(screen.queryByText('cm_agent_old_identity')).not.toBeInTheDocument();
});

test('a denied owner probe renders no key controls or metadata', async () => {
  axios.get.mockRejectedValue({ response: { status: 403, data: { error: 'Forbidden' } } });
  renderPage();
  expect(await screen.findByRole('alert')).toHaveTextContent('Forbidden');
  expect(screen.queryByRole('button', { name: 'Regenerate key' })).not.toBeInTheDocument();
  expect(screen.queryByText('Laptop')).not.toBeInTheDocument();
});

test('a partial installation owner cannot see identity-wide key controls', async () => {
  axios.get.mockImplementation((url) => {
    if (url.startsWith('/api/agent-memory/')) return Promise.resolve({ data: {
      displayName: 'Maya', pods: [{ id: 'pod-1', name: 'Workspace' }],
    } });
    if (url.startsWith('/api/registry/pods/')) return Promise.resolve({ data: { agent: {
      name: 'maya-claude', instanceId: 'default', displayName: 'Maya', runtime: { runtimeType: 'webhook' },
    } } });
    return Promise.reject({ response: { status: 403, data: { message: 'Access denied' } } });
  });
  renderPage();
  expect(await screen.findByRole('alert')).toHaveTextContent('Agent settings unavailable');
  expect(screen.queryByRole('button', { name: 'Regenerate key' })).not.toBeInTheDocument();
  expect(screen.queryByText('Laptop')).not.toBeInTheDocument();
});

test('revocation uses the credential id only after confirmation', async () => {
  axios.delete.mockResolvedValue({ data: { revoked: 1 } });
  renderPage();
  await screen.findByText('Laptop');
  fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
  expect(axios.delete).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Revoke key' }));
  await waitFor(() => expect(axios.delete).toHaveBeenCalledWith('/api/credentials/tok-1', {
    params: { agentName: 'maya-claude', instanceId: 'default' },
  }));
});

test('selects a pod the owner can read when the first identity pod is inaccessible', async () => {
  axios.get.mockImplementation((url) => {
    if (url.startsWith('/api/agent-memory/')) return Promise.resolve({ data: {
      displayName: 'Maya', pods: [{ id: 'foreign', name: 'Other pod' }, { id: 'owned', name: 'My pod' }],
    } });
    if (url.includes('/pods/foreign/')) return Promise.reject({ response: { status: 403 } });
    if (url.includes('/pods/owned/')) return Promise.resolve({ data: { agent: {
      name: 'maya-claude', instanceId: 'default', displayName: 'Maya', runtime: { runtimeType: 'webhook' },
    } } });
    return Promise.resolve({ data: [] });
  });
  axios.post.mockResolvedValue({ data: { token: 'cm_agent_once' } });
  renderPage();
  await screen.findByRole('button', { name: 'Regenerate key' });
  fireEvent.click(screen.getByRole('button', { name: 'Regenerate key' }));
  fireEvent.click(screen.getByRole('button', { name: /replace the running agent/i }));
  await waitFor(() => expect(axios.post).toHaveBeenCalledWith(
    '/api/registry/pods/owned/agents/maya-claude/runtime-tokens',
    expect.objectContaining({ force: true }),
  ));
});

test('runtime editor writes environment controls through the shared settings hook', async () => {
  axios.patch.mockResolvedValue({ data: { updated: true } });
  axios.get.mockImplementation((url) => {
    if (url.startsWith('/api/agent-memory/')) return Promise.resolve({ data: {
      displayName: 'Maya', pods: [{ id: 'pod-1', name: 'Workspace' }],
    } });
    if (url.startsWith('/api/registry/pods/')) return Promise.resolve({ data: { agent: {
      name: 'maya-claude', instanceId: 'default', displayName: 'Maya',
      runtime: { runtimeType: 'wrapper' },
      config: { environment: { adapter: 'claude', model: 'old', effort: 'medium' } },
    } } });
    if (url.includes('/grants')) return Promise.resolve({ data: { grants: [] } });
    return Promise.resolve({ data: [] });
  });
  renderPage();
  const model = await screen.findByLabelText('Change model on this computer');
  fireEvent.change(model, { target: { value: 'new-model' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save runtime' }));
  await waitFor(() => expect(axios.patch).toHaveBeenCalledWith(
    '/api/registry/pods/pod-1/agents/maya-claude',
    { config: { environment: { model: 'new-model' } }, instanceId: 'default' },
  ));
});
