// @ts-nocheck
import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
  await screen.findByText("Reconnect this computer to replace its key.");
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
      profile: {
        instructions: 'Old', persona: { tone: 'friendly', specialties: ['writing'] },
        toolPolicy: { requireApproval: ['search'] }, contextPolicy: { maxTokens: 8000 },
      },
    } } });
    return Promise.resolve({ data: [] });
  });
  axios.patch.mockResolvedValue({ data: { success: true } });
  renderPage();
  const save = await screen.findByRole('button', { name: 'Save identity' });
  expect(save).toBeDisabled();
  fireEvent.change(screen.getByRole('textbox', { name: 'Display name' }), { target: { value: 'Maya 2' } });
  expect(screen.queryByRole('textbox', { name: 'Instructions' })).not.toBeInTheDocument();
  expect(screen.queryByRole('group', { name: 'Persona' })).not.toBeInTheDocument();
  expect(screen.queryByRole('combobox', { name: 'Tone' })).not.toBeInTheDocument();
  expect(save).toBeEnabled();
  fireEvent.click(save);
  await waitFor(() => expect(axios.patch).toHaveBeenCalledWith(
    '/api/registry/pods/pod-1/agents/maya-claude',
    { instanceId: 'default', displayName: 'Maya 2' },
  ));
});

test('OpenClaw identity keeps the live Persona editor and saves its changes', async () => {
  axios.get.mockImplementation((url) => {
    if (url.startsWith('/api/agent-memory/')) return Promise.resolve({ data: {
      displayName: 'Scout', pods: [{ id: 'pod-1', name: 'Workspace' }],
    } });
    if (url.endsWith('/manage-settings')) return Promise.resolve({ data: {
      writablePodId: 'pod-1', installations: [{ podId: 'pod-1', podName: 'Workspace', status: 'active' }],
    } });
    if (url.startsWith('/api/registry/pods/')) return Promise.resolve({ data: { agent: {
      name: 'openclaw', instanceId: 'scout', displayName: 'Scout',
      profile: { persona: { tone: 'friendly', specialties: ['writing'], customInstructions: 'Stay clear' } },
    } } });
    return Promise.resolve({ data: [] });
  });
  axios.patch.mockResolvedValue({ data: { success: true } });
  renderPage('/v2/agents/openclaw/scout');
  expect(await screen.findByRole('group', { name: 'Persona' })).toBeInTheDocument();
  fireEvent.change(screen.getByRole('textbox', { name: 'Persona notes' }), { target: { value: 'Keep detail' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save identity' }));
  await waitFor(() => expect(axios.patch).toHaveBeenCalledWith(
    '/api/registry/pods/pod-1/agents/openclaw',
    { instanceId: 'scout', persona: {
      tone: 'friendly', specialties: ['writing'], boundaries: [], customInstructions: 'Keep detail',
    } },
  ));
});

test('OpenClaw name-only edits leave Persona out of the PATCH', async () => {
  axios.get.mockImplementation((url) => {
    if (url.startsWith('/api/agent-memory/')) return Promise.resolve({ data: {
      displayName: 'Scout', pods: [{ id: 'pod-1', name: 'Workspace' }],
    } });
    if (url.endsWith('/manage-settings')) return Promise.resolve({ data: {
      writablePodId: 'pod-1', installations: [{ podId: 'pod-1', podName: 'Workspace', status: 'active' }],
    } });
    if (url.startsWith('/api/registry/pods/')) return Promise.resolve({ data: { agent: {
      name: 'openclaw', instanceId: 'scout', displayName: 'Scout',
      profile: { persona: { tone: 'friendly', specialties: ['writing'] } },
    } } });
    return Promise.resolve({ data: [] });
  });
  axios.patch.mockResolvedValue({ data: { success: true } });
  renderPage('/v2/agents/openclaw/scout');
  await screen.findByRole('button', { name: 'Save identity' });
  expect(screen.getByRole('group', { name: 'Persona' })).toBeInTheDocument();
  fireEvent.change(screen.getByRole('textbox', { name: 'Display name' }), { target: { value: 'Scout 2' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save identity' }));
  await waitFor(() => expect(axios.patch).toHaveBeenCalledWith(
    '/api/registry/pods/pod-1/agents/openclaw',
    { instanceId: 'scout', displayName: 'Scout 2' },
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
  await screen.findByText("Reconnect this computer to replace its key.");
  expect(screen.queryByRole('link', { name: 'Reconnect to regenerate key' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Regenerate key' })).not.toBeInTheDocument();
});

test('regeneration waits for the explicit running-key replacement confirmation', async () => {
  axios.post.mockResolvedValue({ data: { token: 'cm_agent_once' } });
  renderPage();
  await screen.findByText('Runtime key · Laptop');
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
  await screen.findByText('Runtime key · Laptop');
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
  expect(await screen.findByRole('heading', { name: 'Memory' })).toBeInTheDocument();
  expect(await screen.findByText('Key management is unavailable for this agent. Ask an admin for access.')).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Remove' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Regenerate key' })).not.toBeInTheDocument();
  expect(screen.queryByText('Laptop')).not.toBeInTheDocument();
  expect(axios.get.mock.calls.some(([url]) => url === '/api/agent-memory/maya-claude/default')).toBe(false);
});

test('revocation uses the credential id only after confirmation', async () => {
  axios.delete.mockResolvedValue({ data: { revoked: 1 } });
  renderPage();
  await screen.findByText('Runtime key · Laptop');
  fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
  expect(axios.delete).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Revoke key' }));
  await waitFor(() => expect(axios.delete).toHaveBeenCalledWith('/api/credentials/tok-1', {
    params: { agentName: 'maya-claude', instanceId: 'default' },
  }));
});

test('shows active keys first and keeps revoked history collapsed', async () => {
  const defaultGet = axios.get.getMockImplementation();
  axios.get.mockImplementation((url, options) => (
    url === '/api/credentials' ? Promise.resolve({ data: [
      { _id: 'old', label: 'Old token', status: 'revoked', revokedAt: '2026-10-02T00:00:00Z' },
      { _id: 'daemon', label: 'Runtime token', machineId: 'opaque-id', machineName: "Sam's MacBook", status: 'active' },
    ] }) : defaultGet(url, options)
  ));
  renderPage();
  expect(await screen.findByText("Runtime key · Sam's MacBook")).toBeInTheDocument();
  const disclosure = screen.getByText('1 revoked');
  expect(disclosure.closest('details')).not.toHaveAttribute('open');
  fireEvent.click(disclosure);
  expect(disclosure.closest('details')).toHaveAttribute('open');
  expect(screen.getByText('Runtime key · Old token')).toBeInTheDocument();
});

test('a revoked-only key list has a useful empty state and accessible history', async () => {
  const defaultGet = axios.get.getMockImplementation();
  axios.get.mockImplementation((url, options) => (
    url === '/api/credentials' ? Promise.resolve({ data: [
      { _id: 'old', label: 'Previous key', status: 'revoked' },
    ] }) : defaultGet(url, options)
  ));
  renderPage();
  expect(await screen.findByText('No active keys.')).toBeInTheDocument();
  expect(screen.getByText('1 revoked').closest('details')).not.toHaveAttribute('open');
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
  expect(screen.getByRole('heading', { name: 'Skills' }).compareDocumentPosition(
    screen.getByRole('heading', { name: 'Access key' }),
  ) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'Reach per pod' }).compareDocumentPosition(
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
      runtimeManaged: true, runtimeInventory: [{ harness: 'claude', installed: true, version: '1', models: ['old', 'new-model', 'selected-model', 'opus'], efforts: ['low', 'medium', 'high', 'xhigh'] }], writablePodId: 'pod-1', installations: [{ podId: 'pod-1', podName: 'Workspace', status: 'active' }],
    } });
    if (url.endsWith('/manage-settings')) return Promise.resolve({ data: { runtimeManaged: true, runtimeInventory: [{ harness: 'claude', installed: true, version: '1', models: ['old', 'new-model', 'selected-model', 'opus'], efforts: ['low', 'medium', 'high', 'xhigh'] }], writablePodId: 'pod-1' } });
    if (url.startsWith('/api/registry/pods/')) return Promise.resolve({ data: { agent: {
      name: 'maya-claude', instanceId: 'default', displayName: 'Maya',
      runtime: { runtimeType: 'wrapper' },
      config: { environment: { adapter: 'claude', model: 'old', effort: 'medium' } },
    } } });
    if (url.includes('/grants')) return Promise.resolve({ data: { grants: [] } });
    return Promise.resolve({ data: [] });
  });
  renderPage();
  const model = await screen.findByLabelText('model');
  await screen.findByRole('heading', { name: 'Reach per pod' });
  await screen.findByRole('heading', { name: 'Memory' });
  await screen.findByRole('heading', { name: 'Skills' });
  const sections = Array.from(document.querySelectorAll('.v2-agent-settings h2')).map((node) => node.textContent)
    .filter((text) => text !== 'Identity');
  expect(sections).toEqual(['Status', 'Runtime', 'Reach per pod', 'Memory', 'What it can use', 'Usage', 'Access key', 'Remove']);
  fireEvent.change(model, { target: { value: 'new-model' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save runtime' }));
  await waitFor(() => expect(axios.patch).toHaveBeenCalledWith(
    '/api/registry/pods/pod-1/agents/maya-claude',
    { config: { environment: { model: 'new-model' }, runtime: { adapter: 'claude' } }, instanceId: 'default' },
  ));
});

test('runtime editor keeps a wrapper model when no environment override exists', async () => {
  axios.get.mockImplementation((url) => {
    if (url.includes('/manage-settings')) return Promise.resolve({ data: {
      runtimeManaged: true, runtimeInventory: [{ harness: 'claude', installed: true, version: '1', models: ['old', 'new-model', 'selected-model', 'opus'], efforts: ['low', 'medium', 'high', 'xhigh'] }], writablePodId: 'pod-1', installations: [{ podId: 'pod-1', podName: 'Workspace', status: 'active' }],
    } });
    if (url.startsWith('/api/registry/pods/')) return Promise.resolve({ data: { agent: {
      name: 'maya-claude', instanceId: 'default', displayName: 'Maya',
      runtime: { runtimeType: 'wrapper', adapter: 'claude', model: 'selected-model', effort: 'medium' },
    } } });
    return Promise.resolve({ data: [] });
  });
  renderPage();
  expect(await screen.findByLabelText('model')).toHaveValue('selected-model');
  expect(screen.getByLabelText('effort')).toHaveValue('medium');
});

test('runtime editor shows the daemon-selected effort instead of a different pod config', async () => {
  axios.patch.mockResolvedValue({ data: { updated: true } });
  axios.get.mockImplementation((url) => {
    if (url.includes('/manage-settings')) return Promise.resolve({ data: {
      runtimeManaged: true, runtimeInventory: [{ harness: 'claude', installed: true, version: '1', models: ['old', 'new-model', 'selected-model', 'opus'], efforts: ['low', 'medium', 'high', 'xhigh'] }], writablePodId: 'skills-pod', runtimeSourcePodId: 'source-pod',
      runtimeControls: { runtimeType: 'wrapper', adapter: 'claude', model: 'opus', effort: 'high' },
      runtimeEditable: true, installations: [
        { podId: 'skills-pod', podName: 'Work', status: 'active' },
        { podId: 'source-pod', podName: 'Source', status: 'active' },
      ],
    } });
    if (url.startsWith('/api/registry/pods/')) return Promise.resolve({ data: { agent: {
      name: 'maya-claude', instanceId: 'default', displayName: 'Maya',
      runtime: { runtimeType: 'wrapper', adapter: 'claude' },
      config: { environment: { model: 'opus', effort: 'max' } },
    } } });
    return Promise.resolve({ data: [] });
  });
  renderPage();
  const effort = await screen.findByLabelText('effort');
  expect(effort).toHaveValue('high');
  fireEvent.change(effort, { target: { value: 'xhigh' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save runtime' }));
  await waitFor(() => expect(axios.patch).toHaveBeenCalledWith(
    '/api/registry/pods/source-pod/agents/maya-claude',
    { config: { environment: { effort: 'xhigh' }, runtime: { adapter: 'claude' } }, instanceId: 'default' },
  ));
});

test('standalone CLI settings label the saved preference without claiming a runtime receipt or offering a save', async () => {
  axios.get.mockImplementation((url) => {
    if (url.includes('/manage-settings')) return Promise.resolve({ data: {
      writablePodId: 'pod-1', runtimeSourcePodId: null, runtimeManaged: false,
      runtimeEditable: false, runtimeControls: { runtimeType: 'wrapper', adapter: 'claude', model: '', effort: '' },
      runtimeSavedControls: { runtimeType: 'wrapper', adapter: 'claude', model: 'opus', effort: 'max' },
      installations: [{ podId: 'pod-1', podName: 'Work', status: 'active' }],
    } });
    if (url.startsWith('/api/registry/pods/')) return Promise.resolve({ data: { agent: {
      name: 'maya-claude', instanceId: 'default', displayName: 'Maya',
      runtime: { runtimeType: 'wrapper', adapter: 'claude' },
      config: { environment: { model: 'opus', effort: 'max' } },
    } } });
    return Promise.resolve({ data: [] });
  });
  renderPage();
  await screen.findByRole('heading', { name: 'Runtime' });
  expect(screen.queryByLabelText('effort')).toBeNull();
  expect(screen.queryByDisplayValue('max')).toBeNull();
  expect(screen.queryByDisplayValue('opus')).toBeNull();
  expect(screen.getByText('not reported')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Save runtime' })).not.toBeInTheDocument();
});

test('runner facts refresh without resetting unsaved controls, and a failed read becomes unreported', async () => {
  jest.useFakeTimers();
  let failed = false;
  let connected = true;
  let running = true;
  const at = '2026-10-25T05:00:00Z';
  axios.get.mockImplementation((url) => {
    if (url.includes('/manage-settings')) {
      if (failed) return Promise.reject(new Error('offline'));
      return Promise.resolve({ data: { writablePodId: 'pod-1', runtimeSourcePodId: 'pod-1',
        runtimeManaged: true, runtimeEditable: true, runtimeControls: { runtimeType: 'wrapper', adapter: 'claude', model: 'saved' },
        runtimeInventory: [{ harness: 'claude', installed: true, version: '2.1', models: ['saved', 'unsaved-draft'], efforts: [] }],
        processConnected: connected, runtimeObservation: { connectedAt: at, lastSeenAt: at, turnRunning: running,
          lastTurnAt: at, lastSpawn: { harness: 'claude', version: '2.1', model: 'actual', effort: null, at }, confirmed: null },
        installations: [{ podId: 'pod-1', podName: 'Work', status: 'active' }],
      } });
    }
    if (url.startsWith('/api/registry/pods/')) return Promise.resolve({ data: { agent: {
      name: 'maya-claude', instanceId: 'default', displayName: 'Maya', runtime: { runtimeType: 'wrapper', adapter: 'claude' },
    } } });
    if (url.includes('/grants')) return Promise.resolve({ data: { grants: [] } });
    return Promise.resolve({ data: [] });
  });
  const view = renderPage();
  try {
    const input = await screen.findByLabelText('model');
    fireEvent.change(input, { target: { value: 'unsaved-draft' } });
    expect(screen.getByText('process').closest('div')).toHaveTextContent('connected');
    connected = false; running = false;
    await act(async () => { jest.advanceTimersByTime(30_000); });
    expect(input).toHaveValue('unsaved-draft');
    expect(screen.getByText('process').closest('div')).toHaveTextContent('disconnected');
    expect(screen.queryByText('running')).toBeNull();
    failed = true;
    await act(async () => { jest.advanceTimersByTime(30_000); });
    expect(screen.getByText('process').closest('div')).toHaveTextContent('not reported');
    expect(input).toHaveValue('unsaved-draft');
  } finally { view.unmount(); jest.useRealTimers(); }
});


test.each(['hosted', 'native'])('rev3 %s shows the server run model and never requests credentials', async (runtimeType) => {
  const defaultGet = axios.get.getMockImplementation();
  axios.get.mockImplementation((url, options) => {
    if (url.includes('/manage-settings')) return Promise.resolve({ data: {
      writablePodId: 'pod-1', runtimeRun: { model: 'actual-server-model', startedAt: '2026-10-25T12:00:00Z', status: 'succeeded' },
      runtimeControls: { model: 'saved-not-run' }, installations: [{ podId: 'pod-1', podName: 'Workspace', status: 'active' }],
    } });
    if (url === '/api/registry/pods/pod-1/agents') return Promise.resolve({ data: { agents: [{
      name: 'maya-claude', instanceId: 'default', runtime: { runtimeType }, connection: { state: 'available' },
    }] } });
    if (url.startsWith('/api/registry/pods/')) return Promise.resolve({ data: { agent: {
      name: 'maya-claude', instanceId: 'default', displayName: 'Maya', runtime: { runtimeType },
    } } });
    return defaultGet(url, options);
  });
  renderPage();
  expect(await screen.findByText(/Commonly picks the model: actual-server-model/)).toBeInTheDocument();
  expect(screen.queryByText('saved-not-run')).toBeNull();
  expect(screen.queryByRole('heading', { name: 'Access key' })).toBeNull();
  expect(screen.queryByText('Use my own API key')).toBeNull();
  expect(axios.get.mock.calls.some(([url]) => url === '/api/credentials')).toBe(false);
  if (runtimeType === 'native') {
    expect(screen.getByText('built in')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Usage' })).toBeNull();
  } else {
    const pause = await screen.findByRole('button', { name: 'Pause', exact: true });
    axios.patch.mockResolvedValue({ data: {} });
    fireEvent.click(pause);
    await waitFor(() => expect(axios.patch).toHaveBeenCalledWith('/api/registry/pods/pod-1/agents/maya-claude',
      { status: 'paused', instanceId: 'default' }));
  }
});

test('the primary harness follows the last spawn, not a different saved choice', async () => {
  const defaultGet = axios.get.getMockImplementation();
  axios.get.mockImplementation((url, options) => {
    if (url.includes('/manage-settings')) return Promise.resolve({ data: {
      writablePodId: 'pod-1', runtimeManaged: true,
      runtimeControls: { runtimeType: 'wrapper', adapter: 'codex', model: 'saved-model' },
      runtimeObservation: { lastSpawn: { harness: 'claude', model: 'actual-model', effort: 'high', at: '2026-10-25T12:00:00Z' } },
      installations: [{ podId: 'pod-1', podName: 'Workspace', status: 'active' }],
    } });
    return defaultGet(url, options);
  });
  renderPage();
  const section = (await screen.findByRole('heading', { name: 'Runtime', exact: true })).closest('section');
  expect(within(section).getByText('On your machine · Claude Code')).toBeInTheDocument();
  expect(section).toHaveTextContent('actual-model · high');
  expect(section).not.toHaveTextContent('saved-model');
  expect(section).not.toHaveTextContent('On your machine · Codex');
});


test('managed runtimes keep the provider-key editor reachable', async () => {
  const defaultGet = axios.get.getMockImplementation();
  axios.get.mockImplementation((url, options) => {
    if (url.includes('/manage-settings')) return Promise.resolve({ data: {
      writablePodId: 'pod-1', runtimeManaged: true,
      runtimeControls: { runtimeType: 'wrapper', adapter: 'claude' },
      ownKeyCapability: { available: true, provider: 'anthropic' },
      installations: [{ podId: 'pod-1', podName: 'Workspace', status: 'active' }],
    } });
    if (url.includes('/provider-key?')) return Promise.resolve({ data: { set: false } });
    return defaultGet(url, options);
  });
  renderPage();
  const button = await screen.findByRole('button', { name: 'Set key' });
  await waitFor(() => expect(button).toBeEnabled());
  expect(button.closest('details')).toHaveTextContent('Change runtime');
  fireEvent.click(button);
  expect(screen.getByLabelText('API key')).toHaveAttribute('type', 'password');
});

test('never-connected agents keep removal folded and available', async () => {
  const defaultGet = axios.get.getMockImplementation();
  axios.get.mockImplementation((url, options) => {
    if (url === '/api/registry/pods/pod-1/agents') return Promise.resolve({ data: { agents: [{
      name: 'maya-claude', instanceId: 'default', runtime: { runtimeType: 'wrapper' }, connection: { state: 'never' },
    }] } });
    return defaultGet(url, options);
  });
  renderPage();
  const heading = await screen.findByRole('heading', { name: 'Remove', hidden: true });
  const disclosure = heading.closest('details');
  expect(disclosure).not.toHaveAttribute('open');
  fireEvent.click(disclosure.querySelector('summary'));
  // jsdom does not implement the native summary toggle.
  disclosure.open = true;
  expect(within(disclosure).getByRole('button', { name: 'Remove from pod' })).toBeEnabled();
});


test('BYO without a receipt describes a future connection without a missing command', async () => {
  renderPage();
  const section = (await screen.findByRole('heading', { name: 'Runtime', exact: true })).closest('section');
  expect(within(section).getByText('On your machine, once connected')).toBeInTheDocument();
  expect(section).not.toHaveTextContent('To change it, run this there:');
  expect(within(section).queryByRole('button', { name: 'Copy' })).toBeNull();
});
