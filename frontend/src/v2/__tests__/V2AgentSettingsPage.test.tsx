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
    if (url.includes('/manage-settings')) return Promise.resolve({ data: {
      writablePodId: 'pod-1', installations: [{ podId: 'pod-1', podName: 'Workspace', status: 'active' }],
    } });
    if (url.startsWith('/api/registry/pods/')) return Promise.resolve({ data: { agent: {
      name: 'maya-claude', instanceId: 'default', displayName: 'Maya', runtime: { runtimeType: 'webhook' },
    } } });
    if (url === '/api/registry/agents/maya-claude') return Promise.resolve({ data: {
      status: 'active', registry: 'commonly-community', ephemeral: false, verified: true,
    } });
    return Promise.resolve({ data: [{
      _id: 'tok-1', label: 'Laptop', createdAt: '2026-10-01T00:00:00Z', lastUsedAt: null, revokedAt: null, status: 'active',
    }] });
  });
});

test('Identity shows the listing state and links to the public profile without publishing', async () => {
  renderPage();
  expect(await screen.findByText('Published')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'View public profile' }))
    .toHaveAttribute('href', '/v2/agent/maya-claude/default');
  expect(axios.post).not.toHaveBeenCalled();
});

test('an ephemeral registry row is not presented as a marketplace listing', async () => {
  const defaultGet = axios.get.getMockImplementation();
  axios.get.mockImplementation((url, options) => (
    url === '/api/registry/agents/maya-claude'
      ? Promise.resolve({ data: { status: 'active', registry: 'commonly-community', ephemeral: true, verified: true } })
      : defaultGet(url, options)
  ));
  renderPage();
  expect(await screen.findByText('Not published')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'View public profile' })).toBeInTheDocument();
});

test('wrapper key replacement cannot bypass the daemon reconnect flow', async () => {
  axios.get.mockImplementation((url) => {
    if (url.includes('/manage-settings')) return Promise.resolve({ data: {
      writablePodId: 'pod-1', installations: [{ podId: 'pod-1', podName: 'Workspace', status: 'active' }],
    } });
    if (url.endsWith('/manage-settings')) return Promise.resolve({ data: { writablePodId: 'pod-1' } });
    if (url.startsWith('/api/registry/pods/')) return Promise.resolve({ data: { agent: {
      name: 'maya-claude', instanceId: 'default', displayName: 'Maya', runtime: { runtimeType: 'wrapper' },
    } } });
    return Promise.resolve({ data: [] });
  });
  renderPage();
  await screen.findByText("Replace this computer's key from Control.");
  expect(screen.queryByRole('button', { name: 'Regenerate key' })).not.toBeInTheDocument();
  expect(screen.queryByRole('link', { name: 'Reconnect to regenerate key' })).not.toBeInTheDocument();
  expect(axios.post).not.toHaveBeenCalled();
});

test('revoked webhook key has one Reconnect action in Control', async () => {
  axios.get.mockImplementation((url) => {
    if (url.startsWith('/api/agent-memory/')) return Promise.resolve({ data: {
      displayName: 'Maya', pods: [{ id: 'pod-1', name: 'Workspace' }],
    } });
    if (url.endsWith('/manage-settings')) return Promise.resolve({ data: {
      writablePodId: 'pod-1', installations: [{ podId: 'pod-1', podName: 'Workspace', status: 'active' }],
    } });
    if (url === '/api/registry/pods/pod-1/agents') return Promise.resolve({ data: { agents: [{
      name: 'maya-claude', instanceId: 'default', runtime: { runtimeType: 'webhook' },
      connection: { state: 'revoked', lastSeenAt: null },
    }] } });
    if (url.startsWith('/api/registry/pods/')) return Promise.resolve({ data: { agent: {
      name: 'maya-claude', instanceId: 'default', displayName: 'Maya', runtime: { runtimeType: 'webhook' },
    } } });
    return Promise.resolve({ data: [] });
  });
  renderPage();
  expect(await screen.findByRole('link', { name: 'Reconnect' }))
    .toHaveAttribute('href', '/v2/agents/byo?pod=pod-1&name=maya-claude&instanceId=default&reconnect=1');
  expect(screen.queryByRole('button', { name: 'Regenerate key' })).toBeNull();
});

test('connected nondefault wrapper regenerates from Control without a second Key action', async () => {
  axios.get.mockImplementation((url) => {
    if (url.startsWith('/api/agent-memory/')) return Promise.resolve({ data: {
      displayName: 'Maya', pods: [{ id: 'pod-1', name: 'Workspace' }],
    } });
    if (url.endsWith('/manage-settings')) return Promise.resolve({ data: {
      writablePodId: 'pod-1', installations: [{ podId: 'pod-1', podName: 'Workspace', status: 'active' }],
    } });
    if (url === '/api/registry/pods/pod-1/agents') return Promise.resolve({ data: { agents: [{
      name: 'maya-claude', instanceId: 'second', runtime: { runtimeType: 'wrapper' },
      connection: { state: 'connected', lastSeenAt: new Date().toISOString() },
    }] } });
    if (url.startsWith('/api/registry/pods/')) return Promise.resolve({ data: { agent: {
      name: 'maya-claude', instanceId: 'second', displayName: 'Maya', runtime: { runtimeType: 'wrapper' },
    } } });
    return Promise.resolve({ data: [] });
  });
  renderPage('/v2/agents/maya-claude/second');
  expect(await screen.findByRole('link', { name: 'Regenerate key' }))
    .toHaveAttribute('href', '/v2/agents/byo?pod=pod-1&name=maya-claude&instanceId=second&reconnect=1&mode=machine');
  expect(screen.queryByRole('button', { name: 'Regenerate key' })).toBeNull();
});

test('identity edits go through the shared installation PATCH with the exact instance', async () => {
  axios.get.mockImplementation((url) => {
    if (url.startsWith('/api/agent-memory/')) return Promise.resolve({ data: {
      displayName: 'Maya', pods: [{ id: 'pod-1', name: 'Workspace' }],
    } });
    if (url.endsWith('/manage-settings')) return Promise.resolve({ data: {
      writablePodId: 'pod-1', installations: [{ podId: 'pod-1', podName: 'Workspace', status: 'active' }],
    } });
    if (url.startsWith('/api/registry/pods/')) return Promise.resolve({ data: { agent: {
      name: 'maya-claude', instanceId: 'default', displayName: 'Maya',
      profile: { instructions: 'Old', persona: { tone: 'friendly', specialties: ['writing'] } },
    } } });
    return Promise.resolve({ data: [] });
  });
  axios.patch.mockResolvedValue({ data: { success: true } });
  renderPage();
  await screen.findByRole('button', { name: 'Save identity' });
  fireEvent.change(screen.getByRole('textbox', { name: 'Display name' }), { target: { value: 'Maya 2' } });
  fireEvent.change(screen.getByRole('textbox', { name: 'Instructions' }), { target: { value: 'New instructions' } });
  fireEvent.change(screen.getByRole('combobox', { name: 'Tone' }), { target: { value: 'technical' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save identity' }));
  await waitFor(() => expect(axios.patch).toHaveBeenCalledWith(
    '/api/registry/pods/pod-1/agents/maya-claude',
    expect.objectContaining({
      instanceId: 'default', displayName: 'Maya 2', instructions: 'New instructions',
      persona: expect.objectContaining({ tone: 'technical', specialties: ['writing'] }),
    }),
  ));
});

test.each([
  [403, "You don't have permission to change this agent's identity."],
  [409, 'This agent is installed in pods you cannot manage. An admin can rename it across every pod.'],
  [503, 'Name saved, but chat has not caught up. Try saving again in a moment.'],
])('identity refusal %i uses localized UI copy', async (status, expectedMessage) => {
  axios.patch.mockRejectedValue({ response: { status, data: { error: 'Raw English server text' } } });
  renderPage();
  await screen.findByRole('button', { name: 'Save identity' });
  fireEvent.change(screen.getByRole('textbox', { name: 'Display name' }), { target: { value: 'Maya 2' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save identity' }));
  expect(await screen.findByText(expectedMessage)).toBeInTheDocument();
  expect(screen.queryByText('Raw English server text')).not.toBeInTheDocument();
});

test('a taken display name has its own refusal, separate from the writable-pods 409', async () => {
  axios.patch.mockRejectedValue({ response: { status: 409, data: {
    code: 'agent_display_name_taken', error: 'Raw English server text',
  } } });
  renderPage();
  await screen.findByRole('button', { name: 'Save identity' });
  fireEvent.change(screen.getByRole('textbox', { name: 'Display name' }), { target: { value: 'Scout (Cody)' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save identity' }));
  expect(await screen.findByText('Another agent already uses this name.')).toBeInTheDocument();
  expect(screen.queryByText('Raw English server text')).not.toBeInTheDocument();
});

test('a partial rename tells the installer to retry Save', async () => {
  axios.patch.mockRejectedValue({ response: {
    status: 503, data: { code: 'identity_projection_retryable', error: 'Raw server text' },
  } });
  renderPage();
  await screen.findByRole('button', { name: 'Save identity' });
  fireEvent.change(screen.getByRole('textbox', { name: 'Display name' }), { target: { value: 'Maya 2' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save identity' }));
  expect(await screen.findByText('Name update was interrupted. Save again to finish updating every pod.'))
    .toBeInTheDocument();
});

test('nondefault wrapper instances never link to a default-instance reconnect', async () => {
  axios.get.mockImplementation((url) => {
    if (url.includes('/manage-settings')) return Promise.resolve({ data: {
      writablePodId: 'pod-1', installations: [{ podId: 'pod-1', podName: 'Workspace', status: 'active' }],
    } });
    if (url.endsWith('/manage-settings')) return Promise.resolve({ data: { writablePodId: 'pod-1' } });
    if (url.startsWith('/api/registry/pods/')) return Promise.resolve({ data: { agent: {
      name: 'maya-claude', instanceId: 'second', displayName: 'Maya', runtime: { runtimeType: 'wrapper' },
    } } });
    return Promise.resolve({ data: [] });
  });
  renderPage('/v2/agents/maya-claude/second');
  await screen.findByText("Replace this computer's key from Control.");
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
    const other = url.includes('/agents/other') || options?.params?.agentName === 'other';
    if (url.includes('/manage-settings')) return Promise.resolve({ data: {
      writablePodId: 'pod-1', installations: [{ podId: 'pod-1', podName: 'Workspace', status: 'active' }],
    } });
    if (url.endsWith('/manage-settings')) return Promise.resolve({ data: { writablePodId: 'pod-1' } });
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
    if (url.includes('/manage-settings')) return Promise.resolve({ data: {
      writablePodId: 'pod-1', installations: [{ podId: 'pod-1', podName: 'Workspace', status: 'active' }],
    } });
    if (url.endsWith('/manage-settings')) return Promise.resolve({ data: { writablePodId: 'pod-1' } });
    if (url.startsWith('/api/registry/pods/')) return Promise.resolve({ data: { agent: {
      name: 'maya-claude', instanceId: 'default', displayName: 'Maya', runtime: { runtimeType: 'webhook' },
    } } });
    return Promise.reject({ response: { status: 403, data: { message: 'Access denied' } } });
  });
  renderPage();
  expect(await screen.findByRole('heading', { name: 'Policy' })).toBeInTheDocument();
  expect(await screen.findByText('Key management is unavailable for this agent. Ask an admin for access.')).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Pods' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Regenerate key' })).not.toBeInTheDocument();
  expect(screen.queryByText('Laptop')).not.toBeInTheDocument();
  expect(axios.get.mock.calls.some(([url]) => url === '/api/agent-memory/maya-claude/default')).toBe(false);
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

test('selects an installation the owner can manage without exposing a foreign pod', async () => {
  axios.get.mockImplementation((url) => {
    if (url.includes('/manage-settings')) return Promise.resolve({ data: {
      writablePodId: 'owned', installations: [{ podId: 'owned', podName: 'My pod', status: 'active' }],
    } });
    if (url.includes('/pods/foreign/')) return Promise.reject({ response: { status: 403 } });
    if (url.startsWith('/api/skills/pods/owned/')) return Promise.resolve({ data: {
      items: [], canEdit: true, skillLoad: null,
    } });
    if (url.includes('/pods/owned/')) return Promise.resolve({ data: { agent: {
      name: 'maya-claude', instanceId: 'default', displayName: 'Maya', runtime: { runtimeType: 'webhook' },
    } } });
    return Promise.resolve({ data: [] });
  });
  axios.post.mockResolvedValue({ data: { token: 'cm_agent_once' } });
  renderPage();
  await screen.findByRole('button', { name: 'Regenerate key' });
  await waitFor(() => expect(axios.get).toHaveBeenCalledWith(
    '/api/skills/pods/owned/imported',
    { params: { scope: 'agent', agentName: 'maya-claude', instanceId: 'default' } },
  ));
  expect(axios.get).not.toHaveBeenCalledWith(
    '/api/skills/pods/foreign/imported', expect.anything(),
  );
  expect(screen.getByText('Pod · My pod')).toBeInTheDocument();
  expect(screen.queryByText('Pod · Other pod')).not.toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Key' }).compareDocumentPosition(
    screen.getByRole('heading', { name: 'Skills' }),
  ) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'Wake' }).compareDocumentPosition(
    screen.getByRole('heading', { name: 'Skills' }),
  ) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
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
    if (url.includes('/manage-settings')) return Promise.resolve({ data: {
      writablePodId: 'pod-1', installations: [{ podId: 'pod-1', podName: 'Workspace', status: 'active' }],
    } });
    if (url.endsWith('/manage-settings')) return Promise.resolve({ data: { writablePodId: 'pod-1' } });
    if (url.startsWith('/api/registry/pods/')) return Promise.resolve({ data: { agent: {
      name: 'maya-claude', instanceId: 'default', displayName: 'Maya',
      runtime: { runtimeType: 'wrapper' },
      config: { environment: { adapter: 'claude', model: 'old', effort: 'medium' } },
    } } });
    if (url.includes('/grants')) return Promise.resolve({ data: { grants: [] } });
    return Promise.resolve({ data: [] });
  });
  renderPage();
  const model = await screen.findByLabelText('Model');
  const sections = Array.from(document.querySelectorAll('.v2-agent-settings h2')).map((node) => node.textContent);
  expect(sections.indexOf('Key')).toBeLessThan(sections.indexOf('Runtime'));
  expect(sections.indexOf('Wake')).toBeLessThan(sections.indexOf('Runtime'));
  expect(sections.indexOf('Runtime')).toBeLessThan(sections.indexOf('Connector grants'));
  fireEvent.change(model, { target: { value: 'new-model' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save runtime' }));
  await waitFor(() => expect(axios.patch).toHaveBeenCalledWith(
    '/api/registry/pods/pod-1/agents/maya-claude',
    { config: { environment: { model: 'new-model' } }, instanceId: 'default' },
  ));
});

test('runtime editor keeps a wrapper model when no environment override exists', async () => {
  axios.get.mockImplementation((url) => {
    if (url.includes('/manage-settings')) return Promise.resolve({ data: {
      writablePodId: 'pod-1', installations: [{ podId: 'pod-1', podName: 'Workspace', status: 'active' }],
    } });
    if (url.startsWith('/api/registry/pods/')) return Promise.resolve({ data: { agent: {
      name: 'maya-claude', instanceId: 'default', displayName: 'Maya',
      runtime: { runtimeType: 'wrapper', adapter: 'claude', model: 'selected-model', effort: 'medium' },
    } } });
    return Promise.resolve({ data: [] });
  });
  renderPage();
  expect(await screen.findByLabelText('Model')).toHaveValue('selected-model');
  expect(screen.getByLabelText('Effort')).toHaveValue('medium');
});
