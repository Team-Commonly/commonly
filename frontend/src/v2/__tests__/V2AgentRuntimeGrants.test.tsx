// @ts-nocheck
import React from 'react';
import i18n from '../../i18n';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import V2AgentRuntimeGrants, { describeRuntime } from '../components/V2AgentRuntimeGrants';
import { AuthContext } from '../../context/AuthContext';
import { daemonSetupCommand } from '../utils/daemonSetupCommand';

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
    <V2AgentRuntimeGrants name="nib" instanceId="default" runtime={{ managed: true, inventory: ['claude', 'codex'].map((harness) => ({ harness, installed: true, version: '1', models: ['sonnet', 'opus', 'gpt-5', 'gpt-5.3-codex', 'gpt-6-sol'], efforts: ['low', 'medium', 'high', 'xhigh'] })), ...runtime }} onSaveRuntime={saveRuntime} />
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
  expect(describeRuntime({ runtimeType: 'wrapper', adapter: 'claude', managed: false }))
    .toEqual({ mode: 'cli', adapter: 'Claude Code' });
  expect(describeRuntime({ runtimeType: 'webhook', host: 'byo', adapter: 'dsh' })).toEqual({ mode: 'cli', adapter: 'DeepSeek Harness' });
  expect(describeRuntime({ runtimeType: 'wrapper', adapter: 'unwalked' })).toEqual({ mode: 'daemon', adapter: null });
  expect(describeRuntime({ runtimeType: 'hosted' })).toEqual({ mode: 'hosted', adapter: null });
  expect(describeRuntime({ runtimeType: 'native', host: 'cloud' })).toEqual({ mode: 'native', adapter: null });
  expect(describeRuntime({ runtimeType: 'webhook', host: 'byo' })).toEqual({ mode: 'unknown', adapter: null });
});

test('shows the native engine for a native agent', async () => {
  renderSection({ runtimeType: 'native' });
  expect(await screen.findByText('read only · runs on commonly')).toBeInTheDocument();
  expect(screen.queryByText('Hosted')).not.toBeInTheDocument();
});

test('revoked Runtime row offers an active computer and moves in one request', async () => {
  axios.get.mockImplementation((url) => Promise.resolve({ data: url.includes('/agent-binding/placement')
    ? { boundMachineId: 'old', requestedMachineId: null, boundMachineRevoked: true,
      activeMachines: [{ machineId: 'new', name: 'New Mac' }] } : response }));
  renderSection();
  expect(await screen.findByText('This computer’s key was revoked. Choose another computer to run this agent.')).toBeInTheDocument();
  expect(screen.getByLabelText('Run on')).toHaveValue('new');
  fireEvent.click(screen.getByRole('button', { name: 'Move agent' }));
  await waitFor(() => expect(axios.post).toHaveBeenCalledWith('/api/agent-binding/move',
    { agentName: 'nib', instanceId: 'default', machineId: 'new', fromMachineId: 'old' }, expect.anything()));
  expect(axios.post).toHaveBeenCalledTimes(1);
});

test('without an active computer, the setup hint includes daemon installation', async () => {
  renderSection();
  expect(await screen.findByText(/Register another computer to move this agent/)).toBeInTheDocument();
  expect(screen.getByText(daemonSetupCommand())).toBeInTheDocument();
});

test('a changed installer refuses the move before release and explains the blocking installation', async () => {
  let placementReads = 0;
  axios.get.mockImplementation((url) => {
    if (!url.includes('/agent-binding/placement')) return Promise.resolve({ data: response });
    placementReads += 1;
    if (placementReads > 1) return Promise.reject({ response: { data: {
      code: 'another_installer', blockers: [{ podName: 'Other human pod', installerName: 'alex' }],
    } } });
    return Promise.resolve({ data: { boundMachineId: 'old', requestedMachineId: null,
      boundMachineRevoked: true, activeMachines: [{ machineId: 'new', name: 'New Mac' }] } });
  });
  renderSection();
  fireEvent.click(await screen.findByRole('button', { name: 'Move agent' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Other human pod (alex)');
  expect(axios.post).not.toHaveBeenCalled();
});

test('a revoked target after preflight keeps the old placement visible and shows localized error', async () => {
  axios.get.mockImplementation((url) => Promise.resolve({ data: url.includes('/agent-binding/placement')
    ? { boundMachineId: 'old', requestedMachineId: null, boundMachineRevoked: true,
      activeMachines: [{ machineId: 'new', name: 'New Mac' }] } : response }));
  axios.post.mockRejectedValue({ response: { data: { code: 'target_revoked', message: 'Machine access revoked' } } });
  renderSection();
  fireEvent.click(await screen.findByRole('button', { name: 'Move agent' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('That computer is no longer available.');
  expect(screen.getByText('This computer’s key was revoked. Choose another computer to run this agent.')).toBeInTheDocument();
  expect(axios.post).toHaveBeenCalledTimes(1);
});

test('shows this agent grant and requires a second click to revoke through the existing route', async () => {
  renderSection();
  expect(await screen.findByText('changes apply on the next spawn')).toBeInTheDocument();
  expect(screen.getByRole('option', { name: 'Claude Code 1' })).toBeInTheDocument();
  expect(await screen.findByText(/Work · Granted by Owner/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
  expect(axios.post).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Yes, revoke it' }));
  await waitFor(() => expect(axios.post).toHaveBeenCalledWith('/api/grants/grant-1/revoke', undefined, expect.anything()));
});

test('model changes delegate to the shared settings hook; a single CLI has no edit control', async () => {
  const { rerender } = renderSection();
  const input = await screen.findByLabelText('model');
  fireEvent.change(input, { target: { value: 'opus' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save runtime' }));
  await waitFor(() => expect(saveRuntime).toHaveBeenCalledWith({ adapter: 'claude', model: 'opus' }));
  expect(axios.post).not.toHaveBeenCalled();

  rerender(<AuthContext.Provider value={authValue}><V2AgentRuntimeGrants name="other" instanceId="default" runtime={{ runtimeType: 'webhook', host: 'byo', adapter: 'hermes' }} onSaveRuntime={saveRuntime} /></AuthContext.Provider>);
  expect(await screen.findByText('read only · this seat runs from the cli')).toBeInTheDocument();
  expect(screen.getByLabelText('model')).toBeDisabled();
});

test('daemon effort changes are passed to the shared settings callback', async () => {
  renderSection({ runtimeType: 'wrapper', adapter: 'codex', model: 'gpt-6-sol', effort: 'medium' });
  const input = screen.getByLabelText('effort');
  fireEvent.change(input, { target: { value: 'high' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save runtime' }));
  await waitFor(() => expect(saveRuntime).toHaveBeenCalledWith({ adapter: 'codex', effort: 'high' }));
});

test('the unset effort option clears a saved effort', async () => {
  renderSection({ runtimeType: 'wrapper', adapter: 'codex', model: 'gpt-6-sol', effort: 'medium' });
  fireEvent.change(screen.getByLabelText('effort'), { target: { value: '' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save runtime' }));
  await waitFor(() => expect(saveRuntime).toHaveBeenCalledWith({ adapter: 'codex', effort: '' }));
});

test('a failed runtime save reports next to the editor', async () => {
  saveRuntime.mockRejectedValue(new Error('unavailable'));
  renderSection();
  fireEvent.change(screen.getByLabelText('model'), { target: { value: 'opus' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save runtime' }));
  const runtimeSection = screen.getByRole('heading', { name: 'How it runs' }).closest('section');
  expect(await within(runtimeSection).findByRole('alert')).toHaveTextContent('Could not save runtime settings.');
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

test('placement errors clear when the mounted runtime becomes unmanaged', async () => {
  axios.get.mockImplementation((url) => url.includes('/agent-binding/placement')
    ? Promise.reject(new Error('fixture placement failure')) : Promise.resolve({ data: response }));
  const view = renderSection({ runtimeType: 'wrapper', adapter: 'claude' });
  await screen.findByRole('alert');
  view.rerender(<AuthContext.Provider value={authValue}>
    <V2AgentRuntimeGrants name="nib" instanceId="default" runtime={{ runtimeType: 'wrapper', adapter: 'claude', managed: false }} />
  </AuthContext.Provider>);
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
});

test('a late placement error cannot follow a runtime switch', async () => {
  let rejectPlacement;
  axios.get.mockImplementation((url) => url.includes('/agent-binding/placement')
    ? new Promise((resolve, reject) => { rejectPlacement = reject; }) : Promise.resolve({ data: response }));
  const view = renderSection({ runtimeType: 'wrapper', adapter: 'claude' });
  await waitFor(() => expect(rejectPlacement).toBeDefined());
  view.rerender(<AuthContext.Provider value={authValue}>
    <V2AgentRuntimeGrants name="nib" instanceId="default" runtime={{ runtimeType: 'native' }} />
  </AuthContext.Provider>);
  await act(async () => { rejectPlacement(new Error('fixture late error')); });
  await screen.findByText('read only · runs on commonly');
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
});


test.each(['en', 'zh-CN'])('grant dates use app language (%s)', async (language) => {
  await i18n.changeLanguage(language);
  const view = renderSection();
  try {
    const grant = response.grants[0];
    const date = new Date(grant.createdAt).toLocaleDateString(language);
    expect(await screen.findByText(`Work · ${i18n.t('agentManage.grants.by')} Owner · ${date}`)).toBeInTheDocument();
    const expiry = new Date(grant.expiresAt).toLocaleDateString(language);
    expect(screen.getByText(`${i18n.t('agentManage.grants.ends')} ${expiry}`)).toBeInTheDocument();
  } finally { view.unmount(); await i18n.changeLanguage('en'); }
});
