// @ts-nocheck
import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import V2AgentRuntimeGrants, { describeRuntime } from '../components/V2AgentRuntimeGrants';
import { AuthContext } from '../../context/AuthContext';

jest.mock('axios', () => {
  const mock = {
    get: jest.fn(), post: jest.fn(),
    defaults: { baseURL: '', headers: { common: {} } },
    interceptors: { request: { use: jest.fn(), eject: jest.fn() }, response: { use: jest.fn(), eject: jest.fn() } },
  };
  return { __esModule: true, default: mock, ...mock };
});
const axios = jest.requireMock('axios').default;
const saveRuntime = jest.fn();
const authValue = {
  currentUser: { _id: 'owner', username: 'owner' }, user: { _id: 'owner', username: 'owner' }, token: 'user-jwt',
  loading: false, error: null, isAuthenticated: true,
  register: jest.fn(), login: jest.fn(), logout: jest.fn(), updateProfile: jest.fn(),
};
const response = {
  grants: [{
    grantId: 'grant-1', connector: 'linear', tools: ['linear.list_issues'], podName: 'Work',
    grantedBy: 'Owner', createdAt: '2026-10-01T00:00:00Z', expiresAt: '2099-11-01T00:00:00Z',
    revokedAt: null, canRevoke: true,
  }],
};

const renderSection = (runtime = { runtimeType: 'wrapper', adapter: 'claude', model: 'sonnet' }) => render(
  <AuthContext.Provider value={authValue}>
    <V2AgentRuntimeGrants name="nib" instanceId="default" runtime={runtime} onSaveRuntime={saveRuntime} />
  </AuthContext.Provider>,
);

beforeEach(() => {
  jest.clearAllMocks();
  axios.get.mockImplementation((url) => Promise.resolve({ data: url.includes('/agent-binding/placement')
    ? { boundMachineId: null, requestedMachineId: null, boundMachineRevoked: false, activeMachines: [] }
    : response }));
  axios.post.mockResolvedValue({ data: { revoked: 1 } });
  saveRuntime.mockResolvedValue(undefined);
});

test('runtime labels only recognize walked adapters and distinguish daemon from a single CLI', () => {
  expect(describeRuntime({ runtimeType: 'wrapper', adapter: 'claude' })).toEqual({ mode: 'daemon', adapter: 'Claude Code' });
  expect(describeRuntime({ runtimeType: 'webhook', host: 'byo', adapter: 'dsh' })).toEqual({ mode: 'cli', adapter: 'DeepSeek Harness' });
  expect(describeRuntime({ runtimeType: 'wrapper', adapter: 'unwalked' })).toEqual({ mode: 'daemon', adapter: null });
  expect(describeRuntime({ runtimeType: 'hosted' })).toEqual({ mode: 'hosted', adapter: null });
  expect(describeRuntime({ runtimeType: 'webhook', host: 'byo' })).toEqual({ mode: 'unknown', adapter: null });
});

test('revoked Runtime row offers an active computer and releases before requesting placement', async () => {
  axios.get.mockImplementation((url) => Promise.resolve({ data: url.includes('/agent-binding/placement')
    ? { boundMachineId: 'old', requestedMachineId: null, boundMachineRevoked: true,
      activeMachines: [{ machineId: 'new', name: 'New Mac' }] } : response }));
  renderSection();
  expect(await screen.findByText('This computer was revoked. Choose another computer to run this agent.')).toBeInTheDocument();
  expect(screen.getByLabelText('Run on')).toHaveValue('new');
  fireEvent.click(screen.getByRole('button', { name: 'Move agent' }));
  await waitFor(() => expect(axios.post).toHaveBeenCalledWith('/api/agent-binding/request',
    { agentName: 'nib', instanceId: 'default', machineId: 'new' }, expect.anything()));
  expect(axios.post.mock.calls.slice(0, 2).map(([url]) => url)).toEqual([
    '/api/agent-binding/release', '/api/agent-binding/request',
  ]);
});

test('shows this agent grant and requires a second click to revoke through the existing route', async () => {
  renderSection();
  expect(await screen.findByText('On a computer, via the daemon')).toBeInTheDocument();
  expect(screen.getByText('Claude Code')).toBeInTheDocument();
  expect(await screen.findByText(/Work · Granted by Owner/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
  expect(axios.post).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Yes, revoke it' }));
  await waitFor(() => expect(axios.post).toHaveBeenCalledWith('/api/grants/grant-1/revoke', undefined, expect.anything()));
});

test('model changes delegate to the shared settings hook; a single CLI has no edit control', async () => {
  const { rerender } = renderSection();
  const input = await screen.findByLabelText('Model');
  fireEvent.change(input, { target: { value: 'opus' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save runtime' }));
  await waitFor(() => expect(saveRuntime).toHaveBeenCalledWith({ model: 'opus' }));
  expect(axios.post).not.toHaveBeenCalled();

  rerender(<AuthContext.Provider value={authValue}><V2AgentRuntimeGrants name="other" instanceId="default" runtime={{ runtimeType: 'webhook', host: 'byo', adapter: 'hermes' }} onSaveRuntime={saveRuntime} /></AuthContext.Provider>);
  expect(await screen.findByText('Single CLI')).toBeInTheDocument();
  expect(screen.queryByLabelText('Model')).toBeNull();
});

test('daemon effort changes are passed to the shared settings callback', async () => {
  renderSection({ runtimeType: 'wrapper', adapter: 'codex', model: 'gpt-6-sol', effort: 'medium' });
  const input = screen.getByLabelText('Effort');
  fireEvent.change(input, { target: { value: 'high' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save runtime' }));
  await waitFor(() => expect(saveRuntime).toHaveBeenCalledWith({ effort: 'high' }));
});

test('the unset effort option clears a saved effort', async () => {
  renderSection({ runtimeType: 'wrapper', adapter: 'codex', model: 'gpt-6-sol', effort: 'medium' });
  fireEvent.change(screen.getByLabelText('Effort'), { target: { value: '' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save runtime' }));
  await waitFor(() => expect(saveRuntime).toHaveBeenCalledWith({ effort: '' }));
});

test('a failed runtime save reports next to the editor', async () => {
  saveRuntime.mockRejectedValue(new Error('unavailable'));
  renderSection();
  fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'opus' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save runtime' }));
  const runtimeSection = screen.getByRole('heading', { name: 'Runtime' }).closest('section');
  expect(await within(runtimeSection).findByRole('alert')).toHaveTextContent('Could not save the model.');
});

test('a successful revoke stays ended if the grant reload fails', async () => {
  renderSection();
  await screen.findByText(/Work · Granted by Owner/);
  axios.get.mockRejectedValue(new Error('reload failed'));
  fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
  fireEvent.click(screen.getByRole('button', { name: 'Yes, revoke it' }));
  const grantsSection = screen.getByRole('heading', { name: 'Connector grants' }).closest('section');
  expect(await within(grantsSection).findByRole('alert')).toHaveTextContent('Could not load connector grants.');
  expect(screen.queryByRole('button', { name: 'Revoke' })).toBeNull();
});

test('does not offer revoke when the server says this viewer cannot revoke', async () => {
  axios.get.mockResolvedValue({ data: { ...response, grants: [{ ...response.grants[0], canRevoke: false }] } });
  renderSection();
  expect(await screen.findByText(/Work · Granted by Owner/)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Revoke' })).toBeNull();
});
