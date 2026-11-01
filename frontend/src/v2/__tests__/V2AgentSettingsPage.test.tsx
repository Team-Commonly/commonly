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

// Row panels in the Identity & access list are closed until their toggle opens them.
const openKeys = async () => fireEvent.click(await screen.findByRole('button', { name: 'Key actions' }));
const openRename = async () => fireEvent.click(await screen.findByRole('button', { name: 'Rename' }));

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
  await openKeys();
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
  await openKeys();
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
  await openKeys();
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
  await openRename();
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
  await openRename();
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
  await openRename();
  expect(await screen.findByRole('group', { name: 'Persona' })).toBeInTheDocument();
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
  await openRename();
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
  await openRename();
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
  await openRename();
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
  await openKeys();
  await screen.findByText("Replace this computer's key from Control.");
  expect(screen.queryByRole('link', { name: 'Reconnect to regenerate key' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Regenerate key' })).not.toBeInTheDocument();
});

test('regeneration waits for the explicit running-key replacement confirmation', async () => {
  axios.post.mockResolvedValue({ data: { token: 'cm_agent_once' } });
  renderPage();
  await openKeys();
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
  await openKeys();
  await screen.findByText('Runtime key · Laptop');
  fireEvent.click(screen.getByRole('button', { name: 'Regenerate key' }));
  fireEvent.click(screen.getByRole('button', { name: /replace the running agent/i }));
  await waitFor(() => expect(axios.post).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole('button', { name: 'Next agent' }));
  await screen.findByRole('heading', { name: 'Other agent' });
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
  expect(await screen.findByRole('region', { name: 'Policy' })).toBeInTheDocument();
  expect(await screen.findByText('Key management is unavailable for this agent. Ask an admin for access.')).toBeInTheDocument();
  // No key panel to open: the row offers no Key actions.
  expect(screen.queryByRole('button', { name: 'Key actions' })).toBeNull();
  expect(screen.getByRole('columnheader', { name: 'Pods' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Regenerate key' })).not.toBeInTheDocument();
  expect(screen.queryByText('Laptop')).not.toBeInTheDocument();
  expect(axios.get.mock.calls.some(([url]) => url === '/api/agent-memory/maya-claude/default')).toBe(false);
});

test('revocation uses the credential id only after confirmation', async () => {
  axios.delete.mockResolvedValue({ data: { revoked: 1 } });
  renderPage();
  await openKeys();
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
  await openKeys();
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
  await openKeys();
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
  await openKeys();
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
  const skillsRow = screen.getByText('Skills', { selector: '.lb' });
  expect(screen.getByText('Runtime key', { selector: '.lb' }).compareDocumentPosition(skillsRow)
    & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(screen.getByRole('heading', { name: /^Wake/ }).compareDocumentPosition(skillsRow)
    & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
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
      runtimeManaged: true, runtimeInventory: [{ harness: 'claude', installed: true, version: '1', models: null, efforts: ['low', 'medium', 'high', 'xhigh'] }], writablePodId: 'pod-1', installations: [{ podId: 'pod-1', podName: 'Workspace', status: 'active' }],
    } });
    if (url.endsWith('/manage-settings')) return Promise.resolve({ data: { runtimeManaged: true, runtimeInventory: [{ harness: 'claude', installed: true, version: '1', models: null, efforts: ['low', 'medium', 'high', 'xhigh'] }], writablePodId: 'pod-1' } });
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
  await screen.findByRole('heading', { name: /^Wake/ });
  await screen.findByRole('region', { name: 'Policy' });
  // Headings and row labels, in document order. The Wake title carries its tooltip text, so match it by prefix.
  const sections = Array.from(document.querySelectorAll('.v2-agent-settings h2, .v2-agent-settings-page__group > .list > .lrow > .lb, .v2-agent-settings-page__group > .list > details > summary > .lb'))
    .map((node) => node.textContent.trim());
  // D215 artboard: Wake, then ONE Identity & access list in the frame's row order. This roster
  // read carries no connection signal, so the Connection row stays to say so.
  expect(sections.filter((text) => !text.startsWith('Wake'))).toEqual([
    'Identity & access', 'Name', 'Runtime key', 'Connection', 'Marketplace listing', 'Connectors', 'Memory', 'Skills', 'How it runs',
  ]);
  expect(sections[0].startsWith('Wake')).toBe(true);
  // None of the old section headings remain.
  for (const gone of ['Identity', 'Policy', 'Skills', 'Connector grants', 'How it runs']) {
    expect(screen.queryByRole('heading', { name: gone })).toBeNull();
  }
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
      runtimeManaged: true, runtimeInventory: [{ harness: 'claude', installed: true, version: '1', models: null, efforts: ['low', 'medium', 'high', 'xhigh'] }], writablePodId: 'pod-1', installations: [{ podId: 'pod-1', podName: 'Workspace', status: 'active' }],
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
      runtimeManaged: true, runtimeInventory: [{ harness: 'claude', installed: true, version: '1', models: null, efforts: ['low', 'medium', 'high', 'xhigh'] }], writablePodId: 'skills-pod', runtimeSourcePodId: 'source-pod',
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
  expect(await screen.findByText('read only · this seat runs from the cli')).toBeInTheDocument();
  expect(screen.getByLabelText('effort')).toHaveValue('max');
  expect(screen.getByLabelText('effort')).toBeDisabled();
  expect(screen.getAllByText('unconfirmed')).toHaveLength(3);
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
        runtimeInventory: [{ harness: 'claude', installed: true, version: '2.1', models: null, efforts: [] }],
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

test('the key list re-reads while visible, so an outside call updates Last used', async () => {
  jest.useFakeTimers();
  let used = false;
  const defaultGet = axios.get.getMockImplementation();
  axios.get.mockImplementation((url, options) => (
    url === '/api/credentials'
      ? Promise.resolve({ data: [{ _id: 'tok-1', label: 'Laptop', createdAt: '2026-10-01T00:00:00Z',
        lastUsedAt: used ? '2026-10-31T09:15:00Z' : null, revokedAt: null, status: 'active' }] })
      : defaultGet(url, options)
  ));
  const view = renderPage();
  try {
    await openKeys();
    const before = await screen.findByText(/last used/i);
    const beforeText = before.textContent;
    used = true;
    await act(async () => { jest.advanceTimersByTime(15_000); });
    expect(screen.getByText(/last used/i).textContent).not.toEqual(beforeText);
  } finally { view.unmount(); jest.useRealTimers(); }
});

test('key polling stops on unmount', async () => {
  jest.useFakeTimers();
  const view = renderPage();
  try {
    await openKeys();
    await screen.findByText(/last used/i);
    view.unmount();
    const calls = axios.get.mock.calls.filter(([url]) => url === '/api/credentials').length;
    await act(async () => { jest.advanceTimersByTime(60_000); });
    expect(axios.get.mock.calls.filter(([url]) => url === '/api/credentials').length).toBe(calls);
  } finally { jest.useRealTimers(); }
});

test('a revoke from outside moves the header off Connected without a remount', async () => {
  jest.useFakeTimers();
  let state = 'connected';
  axios.get.mockImplementation((url) => {
    if (url.startsWith('/api/agent-memory/')) return Promise.resolve({ data: {
      displayName: 'Maya', pods: [{ id: 'pod-1', name: 'Workspace' }],
    } });
    if (url.endsWith('/manage-settings')) return Promise.resolve({ data: {
      writablePodId: 'pod-1', installations: [{ podId: 'pod-1', podName: 'Workspace', status: 'active' }],
    } });
    if (url === '/api/registry/pods/pod-1/agents') return Promise.resolve({ data: { agents: [{
      name: 'maya-claude', instanceId: 'default', runtime: { runtimeType: 'webhook' },
      connection: { state, lastSeenAt: null },
    }] } });
    if (url.startsWith('/api/registry/pods/')) return Promise.resolve({ data: { agent: {
      name: 'maya-claude', instanceId: 'default', displayName: 'Maya', runtime: { runtimeType: 'webhook' },
    } } });
    return Promise.resolve({ data: [] });
  });
  const view = renderPage();
  try {
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByRole('link', { name: 'Reconnect' })).toBeNull();
    state = 'revoked';
    await act(async () => { jest.advanceTimersByTime(30_000); });
    expect(await screen.findByRole('link', { name: 'Reconnect' })).toBeInTheDocument();
  } finally { view.unmount(); jest.useRealTimers(); }
});

test('key polling pauses while hidden and re-reads on focus', async () => {
  jest.useFakeTimers();
  const view = renderPage();
  const keyReads = () => axios.get.mock.calls.filter(([url]) => url === '/api/credentials').length;
  try {
    await openKeys();
    await screen.findByText(/last used/i);
    const hidden = jest.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    const before = keyReads();
    await act(async () => { jest.advanceTimersByTime(45_000); });
    expect(keyReads()).toBe(before);
    hidden.mockReturnValue(false);
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    expect(keyReads()).toBe(before + 1);
    hidden.mockRestore();
  } finally { view.unmount(); jest.useRealTimers(); }
});

test('a name outside 1–80 characters is refused under the field; other refusals sit by Save', async () => {
  renderPage();
  await openRename();
  const save = await screen.findByRole('button', { name: 'Save identity' });
  const name = screen.getByRole('textbox', { name: 'Display name' });
  fireEvent.change(name, { target: { value: '   ' } });
  fireEvent.click(save);
  const error = await screen.findByText('Enter a display name of 1–80 characters.');
  expect(name).toHaveAttribute('aria-invalid', 'true');
  expect(name).toHaveAttribute('aria-describedby', error.id);
  expect(axios.patch).not.toHaveBeenCalled();

  axios.patch.mockRejectedValue({ response: { status: 403, data: {} } });
  fireEvent.change(name, { target: { value: 'Maya 2' } });
  fireEvent.click(save);
  await screen.findByText("You don't have permission to change this agent's identity.");
  expect(name).not.toHaveAttribute('aria-invalid');
  expect(screen.queryByText('Enter a display name of 1–80 characters.')).toBeNull();
});

describe('one Identity & access list (d215 frame)', () => {
  // A connected webhook agent with one active key, a memory index and no skills or grants.
  const fleet = ({ state = 'connected', memory = 'ok', skills = 'ok', runtimeType = 'webhook', placement = null } = {}) => (url) => {
    if (url.includes('/agent-binding/placement')) return Promise.resolve({ data: placement === 'revoked'
      ? { boundMachineId: 'old', requestedMachineId: null, boundMachineRevoked: true, activeMachines: [{ machineId: 'new', name: 'New Mac' }] }
      : { boundMachineId: 'old', requestedMachineId: null, boundMachineRevoked: false, activeMachines: [{ machineId: 'old', name: 'Old Mac' }] } });
    if (url.endsWith('/manage-settings')) return Promise.resolve({ data: {
      writablePodId: 'pod-1', installations: [{ podId: 'pod-1', podName: 'Workspace', status: 'active' }],
    } });
    if (url === '/api/registry/pods/pod-1/agents') return Promise.resolve({ data: { agents: [{
      name: 'maya-claude', instanceId: 'default', runtime: { runtimeType },
      connection: { state, lastSeenAt: null },
    }] } });
    if (url.startsWith('/api/registry/pods/')) return Promise.resolve({ data: { agent: {
      name: 'maya-claude', instanceId: 'default', displayName: 'Maya', runtime: { runtimeType },
    } } });
    if (url === '/api/registry/agents/maya-claude') return Promise.resolve({ data: { status: 'active', verified: true } });
    if (url === '/api/agent-memory/maya-claude/default') {
      if (memory === 'denied') return Promise.reject({ response: { status: 403 } });
      return Promise.resolve({ data: { viewerRole: 'owner', totalEntries: 3, sections: [
        { key: 'long_term', label: 'Long-term', kind: 'doc', updatedAt: new Date(Date.now() - 2 * 3600_000).toISOString(),
          notes: [{ header: 'Rules', snippet: 'a' }, { header: 'How', snippet: 'b' }] },
        { key: 'daily', label: 'Daily', kind: 'log', updatedAt: null, notes: [{ header: '2026-10-30', snippet: 'c' }] },
      ] } });
    }
    if (url.startsWith('/api/skills/pods/')) {
      if (skills === 'failed') return Promise.reject({ response: { status: 500 } });
      return Promise.resolve({ data: { items: [], canEdit: true, skillLoad: null } });
    }
    if (url.includes('/grants')) return Promise.resolve({ data: { grants: [] } });
    if (url === '/api/credentials') return Promise.resolve({ data: [{
      _id: 'tok-1', label: 'Laptop', createdAt: '2026-10-01T00:00:00Z', lastUsedAt: new Date(Date.now() - 5 * 60_000).toISOString(), status: 'active',
    }] });
    return Promise.resolve({ data: [] });
  };

  test('How it runs opens by itself when the machine was revoked, and stays closed when it is healthy', async () => {
    axios.get.mockImplementation(fleet({ runtimeType: 'wrapper', placement: 'revoked' }));
    const { unmount } = renderPage();
    await waitFor(() => expect(screen.getByTestId('agent-how-it-runs')).toHaveAttribute('open'));
    unmount();
    axios.get.mockImplementation(fleet({ runtimeType: 'wrapper', placement: 'healthy' }));
    renderPage();
    expect(await screen.findByText(/Old Mac/)).toBeInTheDocument();
    expect(screen.getByTestId('agent-how-it-runs')).not.toHaveAttribute('open');
  });

  test('How it runs stays open after a successful move clears what opened it', async () => {
    let moved = false;
    const base = fleet({ runtimeType: 'wrapper', placement: 'revoked' });
    axios.get.mockImplementation((url) => (url.includes('/agent-binding/placement') && moved
      ? Promise.resolve({ data: { boundMachineId: 'new', requestedMachineId: null, boundMachineRevoked: false, activeMachines: [{ machineId: 'new', name: 'New Mac' }] } })
      : base(url)));
    axios.post.mockImplementation(() => { moved = true; return Promise.resolve({ data: {} }); });
    renderPage();
    const runs = await screen.findByTestId('agent-how-it-runs');
    await waitFor(() => expect(runs).toHaveAttribute('open'));
    fireEvent.click(await screen.findByRole('button', { name: 'Move agent' }));
    await waitFor(() => expect(axios.post).toHaveBeenCalledWith('/api/agent-binding/move', expect.anything(), expect.anything()));
    expect(await screen.findByText(/New Mac/, { selector: 'span' })).toBeInTheDocument();
    expect(runs).toHaveAttribute('open');
  });

  test('a failed skills read opens the Skills panel, where its error is', async () => {
    axios.get.mockImplementation(fleet({ skills: 'failed' }));
    renderPage();
    expect(await screen.findByText('Connected · 1 pod')).toBeInTheDocument();
    await waitFor(() => expect(document.getElementById('agent-skills-panel')).not.toHaveAttribute('hidden'));
    const toggle = screen.getByRole('button', { name: 'Skills' });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    // Opened by the error, but still the reader's to close.
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(document.getElementById('agent-skills-panel')).toHaveAttribute('hidden');
  });

  test('a healthy skills read leaves the Skills panel closed', async () => {
    axios.get.mockImplementation(fleet());
    renderPage();
    expect(await screen.findByText('Connected · 1 pod')).toBeInTheDocument();
    await waitFor(() => expect(axios.get).toHaveBeenCalledWith(expect.stringMatching(/^\/api\/skills\/pods\//), expect.anything()));
    expect(document.getElementById('agent-skills-panel')).toHaveAttribute('hidden');
  });

  test('a healthy connection lives in the header, and the Connection row is hidden', async () => {
    axios.get.mockImplementation(fleet());
    renderPage();
    expect(await screen.findByText('Connected · 1 pod')).toBeInTheDocument();
    expect(document.querySelector('.ph .st .dot')).not.toHaveClass('dot--off');
    expect(screen.queryByTestId('agent-control-section')).toBeNull();
    expect(screen.queryByText('Connection', { selector: '.lb' })).toBeNull();
  });

  test('a revoked connection dims the header dot and shows the Connection row with Reconnect', async () => {
    axios.get.mockImplementation(fleet({ state: 'revoked' }));
    renderPage();
    const row = await screen.findByTestId('agent-control-section');
    expect(row).toHaveTextContent('Disconnected: key revoked');
    expect(within(row).getByRole('link', { name: 'Reconnect' })).toHaveAttribute('href', expect.stringContaining('reconnect=1'));
    expect(document.querySelector('.ph .st .dot')).toHaveClass('dot--off');
    expect(screen.getByText('Disconnected: key revoked · 1 pod')).toBeInTheDocument();
  });

  test('the key row reads active with its last use, and Key actions opens the key list (closed by default)', async () => {
    axios.get.mockImplementation(fleet());
    renderPage();
    const toggle = await screen.findByRole('button', { name: 'Key actions' });
    expect(screen.getByText('used 5m ago')).toBeInTheDocument();
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Runtime key · Laptop')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Regenerate key' })).toBeNull();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Runtime key · Laptop')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Regenerate key' })).toBeInTheDocument();
  });

  test('a one-time key forces the key panel open until it is dismissed', async () => {
    axios.get.mockImplementation(fleet());
    axios.post.mockResolvedValue({ data: { token: 'cm_agent_once' } });
    renderPage();
    await openKeys();
    fireEvent.click(screen.getByRole('button', { name: 'Regenerate key' }));
    fireEvent.click(screen.getByRole('button', { name: /replace the running agent/i }));
    expect(await screen.findByTestId('agent-one-time-key')).toHaveTextContent('cm_agent_once');
    const toggle = screen.getByRole('button', { name: 'Key actions' });
    // A key shown only once can't be folded away, and the toggle says so rather than doing nothing.
    expect(toggle).toBeDisabled();
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByTestId('agent-one-time-key')).toBeNull();
    expect(screen.queryByText('Runtime key · Laptop')).toBeNull();
    // Done closes the panel and hands focus back to the row, not to the page.
    expect(toggle).toBeEnabled();
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveFocus();
  });

  test('a key error opens the panel, and its toggle still closes it', async () => {
    axios.get.mockImplementation(fleet());
    axios.post.mockRejectedValue({ response: { data: { error: 'Replacement refused' } } });
    renderPage();
    await openKeys();
    fireEvent.click(screen.getByRole('button', { name: 'Regenerate key' }));
    fireEvent.click(screen.getByRole('button', { name: /replace the running agent/i }));
    expect(await screen.findByText('Replacement refused')).toBeInTheDocument();
    const toggle = screen.getByRole('button', { name: 'Key actions' });
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Replacement refused')).toBeNull();
    fireEvent.click(toggle);
    expect(screen.getByText('Replacement refused')).toBeInTheDocument();
  });

  test('Rename is closed by default and opens the name form inside the list', async () => {
    axios.get.mockImplementation(fleet());
    renderPage();
    const rename = await screen.findByRole('button', { name: 'Rename' });
    expect(screen.getByText('Maya', { selector: '.lrow .vl' })).toBeInTheDocument();
    expect(rename).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('textbox', { name: 'Display name' })).toBeNull();
    fireEvent.click(rename);
    expect(rename).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('textbox', { name: 'Display name' })).toHaveValue('Maya');
    expect(screen.getByRole('button', { name: 'Save identity' }).closest('.list')).toBe(rename.closest('.list'));
  });

  test('Skills is closed by default; its toggle opens the skills panel', async () => {
    axios.get.mockImplementation(fleet());
    renderPage();
    const toggle = await screen.findByRole('button', { name: 'Skills' });
    expect(await within(toggle.closest('.lrow')).findByText('None')).toBeInTheDocument();
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('region', { name: 'Skills' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add skill' })).toBeNull();
    fireEvent.click(toggle);
    expect(screen.getByRole('region', { name: 'Skills' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add skill' })).toBeInTheDocument();
  });

  test('Connectors reads None, opens its grants list, and links to where grants are made', async () => {
    axios.get.mockImplementation(fleet());
    renderPage();
    const toggle = await screen.findByRole('button', { name: 'Connector grants' });
    expect(await within(toggle.closest('.lrow')).findByText('None')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Connector grants' })).toBeNull();
    fireEvent.click(toggle);
    expect(within(screen.getByRole('region', { name: 'Connector grants' })).getByText('This agent has no connector grants.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Grant a connector' })).toHaveAttribute('href', '/v2/connectors');
  });

  test('How it runs is a closed disclosure whose summary names the runtime', async () => {
    axios.get.mockImplementation(fleet());
    renderPage();
    const disc = await screen.findByTestId('agent-how-it-runs');
    expect(disc).not.toHaveAttribute('open');
    expect(disc.querySelector('summary')).toHaveTextContent('webhook');
    expect(within(disc).getByRole('region', { name: 'Policy' })).toBeInTheDocument();
    expect(within(disc).getByRole('region', { name: 'How it runs' })).toBeInTheDocument();
  });

  test('Memory counts notes the way the Memory tab does, and says nothing when refused', async () => {
    axios.get.mockImplementation(fleet());
    const view = renderPage();
    expect(await screen.findByText('3 notes')).toBeInTheDocument();
    expect(screen.getByText('saved 2h ago')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open memory' })).toHaveAttribute('href', '/v2/agents/maya-claude/default/memory');
    view.unmount();

    axios.get.mockImplementation(fleet({ memory: 'denied' }));
    renderPage();
    await screen.findByRole('link', { name: 'Open memory' });
    await waitFor(() => expect(axios.get).toHaveBeenCalledWith('/api/agent-memory/maya-claude/default'));
    expect(screen.queryByText(/notes?$/)).toBeNull();
    expect(screen.queryByText(/^saved /)).toBeNull();
  });

  test('no dead buttons: every list control either toggles a panel or links somewhere, and there is no More', async () => {
    axios.get.mockImplementation(fleet());
    renderPage();
    await screen.findByRole('button', { name: 'Key actions' });
    expect(screen.queryByRole('button', { name: 'More' })).toBeNull();
    const list = document.querySelector('.v2-agent-settings-page__group > .list');
    const controls = Array.from(list.querySelectorAll(':scope > .lrow > .ac > button, :scope > .lrow > .ac > a'));
    expect(controls.length).toBeGreaterThanOrEqual(6);
    for (const control of controls) {
      if (control.tagName === 'A') {
        expect(control.getAttribute('href')).toMatch(/^\/v2\//);
      } else {
        expect(control).toHaveAttribute('aria-controls');
        expect(control).toHaveAttribute('aria-expanded', 'false');
        fireEvent.click(control);
        expect(control).toHaveAttribute('aria-expanded', 'true');
        expect(document.getElementById(control.getAttribute('aria-controls'))).not.toBeNull();
        expect(document.getElementById(control.getAttribute('aria-controls'))).not.toHaveAttribute('hidden');
      }
    }
  });

  test('Talk to opens the agent room from the header', async () => {
    axios.get.mockImplementation(fleet());
    axios.post.mockResolvedValue({ data: { room: { _id: 'room-1' } } });
    render(
      <AuthContext.Provider value={authValue}>
        <MemoryRouter initialEntries={['/v2/agents/maya-claude/default']}>
          <Routes>
            <Route path="/v2/agents/:agentName/:instanceId" element={<V2AgentSettingsPage />} />
            <Route path="/v2/pods/:id" element={<div>room opened</div>} />
          </Routes>
        </MemoryRouter>
      </AuthContext.Provider>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Talk to Maya' }));
    expect(await screen.findByText('room opened')).toBeInTheDocument();
    expect(axios.post).toHaveBeenCalledWith('/api/agents/runtime/room', { agentName: 'maya-claude', instanceId: 'default' });
  });

  describe('phone (390)', () => {
    const realMatchMedia = window.matchMedia;
    beforeEach(() => {
      window.matchMedia = jest.fn().mockImplementation((query) => ({
        matches: query === '(max-width: 600px)', media: query, onchange: null,
        addEventListener: jest.fn(), removeEventListener: jest.fn(), addListener: jest.fn(), removeListener: jest.fn(),
      }));
    });
    afterEach(() => { window.matchMedia = realMatchMedia; });

    test('a 52px bar with back to Your team, the tabs as their own row, and every row still reachable', async () => {
      axios.get.mockImplementation(fleet());
      render(
        <AuthContext.Provider value={authValue}>
          <MemoryRouter initialEntries={['/v2/agents/maya-claude/default']}>
            <Routes>
              <Route path="/v2/agents/:agentName/:instanceId" element={<V2AgentSettingsPage />} />
              <Route path="/v2/agents" element={<div>your team</div>} />
            </Routes>
          </MemoryRouter>
        </AuthContext.Provider>,
      );
      await screen.findByRole('button', { name: 'Key actions' });
      expect(document.querySelector('.mtop')).not.toBeNull();
      expect(document.querySelector('.ph')).toBeNull();
      expect(screen.queryByRole('button', { name: 'More' })).toBeNull();
      const tabs = screen.getByRole('navigation', { name: 'Agent tabs' });
      expect(tabs.closest('.mtop')).toBeNull();
      expect(tabs).toHaveClass('seg--full');
      for (const label of ['Name', 'Runtime key', 'Marketplace listing', 'Connectors', 'Memory', 'Skills', 'How it runs']) {
        expect(screen.getByText(label, { selector: '.lb' })).toBeInTheDocument();
      }
      fireEvent.click(screen.getByRole('button', { name: 'Your team' }));
      expect(await screen.findByText('your team')).toBeInTheDocument();
    });
  });
});
