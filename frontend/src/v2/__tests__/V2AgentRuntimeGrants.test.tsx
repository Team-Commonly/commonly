// @ts-nocheck
import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import V2AgentRuntimeBody, { V2AgentConnectorsRow, describeRuntime } from '../components/V2AgentRuntimeGrants';
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

// The settings page renders the two halves apart: the Connectors row in the
// Identity & access list, the runtime body inside How it runs.
const renderSection = (runtime = { runtimeType: 'wrapper', adapter: 'claude', model: 'sonnet' }) => render(
  <AuthContext.Provider value={authValue}>
    <MemoryRouter>
      <div className="list"><V2AgentConnectorsRow name="nib" instanceId="default" /></div>
      <V2AgentRuntimeBody name="nib" instanceId="default" runtime={{ managed: true, inventory: ['claude', 'codex'].map((harness) => ({ harness, installed: true, version: '1', models: null, efforts: ['low', 'medium', 'high', 'xhigh'] })), ...runtime }} onSaveRuntime={saveRuntime} />
    </MemoryRouter>
  </AuthContext.Provider>,
);
// The grants list sits behind the Connectors row's toggle.
const openGrants = () => fireEvent.click(screen.getByRole('button', { name: 'Connector grants' }));
const grantsRegion = () => screen.getByRole('region', { name: 'Connector grants' });

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

test('two computers with one name are told apart by when each was added', async () => {
  axios.get.mockImplementation((url) => Promise.resolve({ data: url.includes('/agent-binding/placement')
    ? { boundMachineId: 'old', requestedMachineId: null, boundMachineRevoked: true,
      activeMachines: [
        { machineId: 'new', name: 'Sams-MacBook', createdAt: '2026-10-24T09:00:00.000Z' },
        { machineId: 'older', name: 'Sams-MacBook', createdAt: '2026-09-06T09:00:00.000Z' },
        { machineId: 'solo', name: 'Studio', createdAt: '2026-09-01T09:00:00.000Z' },
      ] } : response }));
  renderSection();
  const select = await screen.findByLabelText('Run on');
  const labels = Array.from(select.querySelectorAll('option')).map((option) => option.textContent);
  expect(labels[0]).toMatch(/^Sams-MacBook · added Oct 24, /);
  expect(labels[1]).toMatch(/^Sams-MacBook · added Sep 6, /);
  expect(labels[2]).toBe('Studio');
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
  openGrants();
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

  rerender(<AuthContext.Provider value={authValue}><MemoryRouter><V2AgentRuntimeBody name="other" instanceId="default" runtime={{ runtimeType: 'webhook', host: 'byo', adapter: 'hermes' }} onSaveRuntime={saveRuntime} /></MemoryRouter></AuthContext.Provider>);
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
  const runtimeSection = screen.getByRole('region', { name: 'How it runs' });
  expect(await within(runtimeSection).findByRole('alert')).toHaveTextContent('Could not save runtime settings.');
});

test('a successful revoke stays ended if the grant reload fails', async () => {
  renderSection();
  openGrants();
  await screen.findByText(/Work · Granted by Owner/);
  axios.get.mockRejectedValue(new Error('reload failed'));
  fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
  fireEvent.click(screen.getByRole('button', { name: 'Yes, revoke it' }));
  const grantsSection = grantsRegion();
  expect(await within(grantsSection).findByRole('alert')).toHaveTextContent('Could not load connector grants.');
  expect(screen.queryByRole('button', { name: 'Revoke' })).toBeNull();
});

test('does not offer revoke when the server says this viewer cannot revoke', async () => {
  axios.get.mockResolvedValue({ data: { ...response, grants: [{ ...response.grants[0], canRevoke: false }] } });
  renderSection();
  openGrants();
  expect(await screen.findByText(/Work · Granted by Owner/)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Revoke' })).toBeNull();
});

test('a failed grant load is one row with Try again, which reloads the list', async () => {
  let fail = true;
  axios.get.mockImplementation((url) => {
    if (url.includes('/agent-binding/placement')) return Promise.resolve({ data: { boundMachineId: null, requestedMachineId: null, boundMachineRevoked: false, activeMachines: [] } });
    if (url.includes('/grants') && fail) return Promise.reject(new Error('offline'));
    return Promise.resolve({ data: response });
  });
  renderSection();
  // A failed load opens the list by itself, so the alert and Try again are in view.
  const grantsSection = await screen.findByRole('region', { name: 'Connector grants' });
  expect(await within(grantsSection).findByRole('alert')).toHaveTextContent('Could not load connector grants.');
  fail = false;
  fireEvent.click(within(grantsSection).getByRole('button', { name: 'Try again' }));
  expect(await within(grantsSection).findByText(/Work · Granted by Owner/)).toBeInTheDocument();
  expect(within(grantsSection).queryByRole('alert')).toBeNull();
});

test('a failed revoke says so above the rows, keeps the grant revocable and offers no reload', async () => {
  axios.post.mockRejectedValue(new Error('denied'));
  renderSection();
  openGrants();
  await screen.findByText(/Work · Granted by Owner/);
  fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
  fireEvent.click(screen.getByRole('button', { name: 'Yes, revoke it' }));
  const grantsSection = grantsRegion();
  expect(await within(grantsSection).findByRole('alert')).toHaveTextContent('Could not revoke the grant.');
  expect(within(grantsSection).queryByRole('button', { name: 'Try again' })).toBeNull();
  expect(within(grantsSection).getByRole('button', { name: 'Yes, revoke it' })).toBeEnabled();
});

test('the inline confirm swaps back to Revoke on Cancel, and the title counts active and ended grants', async () => {
  axios.get.mockImplementation((url) => Promise.resolve({ data: url.includes('/agent-binding/placement')
    ? { boundMachineId: null, requestedMachineId: null, boundMachineRevoked: false, activeMachines: [] }
    : { grants: [...response.grants, { ...response.grants[0], grantId: 'grant-2', connector: 'sentry', revokedAt: '2026-10-20T00:00:00Z' }] } }));
  renderSection();
  expect(await screen.findByText('1 active · 1 ended')).toBeInTheDocument();
  openGrants();
  expect(screen.getAllByRole('button', { name: 'Revoke' })).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
  expect(screen.queryByRole('button', { name: 'Revoke' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(screen.getByRole('button', { name: 'Revoke' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Yes, revoke it' })).toBeNull();
  expect(axios.post).not.toHaveBeenCalled();
});

test('names a grant by its connector brand, not its id', async () => {
  axios.get.mockImplementation((url) => Promise.resolve({ data: url.includes('/agent-binding/placement')
    ? { boundMachineId: null, requestedMachineId: null, boundMachineRevoked: false, activeMachines: [] }
    : { grants: [{ ...response.grants[0], connector: 'github', tools: ['github.list_issues'] }] } }));
  renderSection();
  openGrants();
  expect(await screen.findByText('GitHub')).toBeInTheDocument();
});

test('Connectors is a row with no heading of its own; its grants list is closed until the toggle opens it', async () => {
  renderSection();
  await screen.findByText('1 active');
  expect(screen.queryAllByRole('heading').filter((node) => node.textContent.includes('Connector grants'))).toHaveLength(0);
  const toggle = screen.getByRole('button', { name: 'Connector grants' });
  expect(toggle).toHaveAttribute('aria-expanded', 'false');
  expect(screen.queryByRole('region', { name: 'Connector grants' })).toBeNull();
  expect(screen.queryByText(/Work · Granted by Owner/)).toBeNull();
  fireEvent.click(toggle);
  expect(toggle).toHaveAttribute('aria-expanded', 'true');
  expect(within(grantsRegion()).getByText(/Work · Granted by Owner/)).toBeInTheDocument();
  fireEvent.click(toggle);
  expect(screen.queryByRole('region', { name: 'Connector grants' })).toBeNull();
});

test('an agent without grants reads None, and the grant link goes to the Connectors page', async () => {
  axios.get.mockImplementation((url) => Promise.resolve({ data: url.includes('/agent-binding/placement')
    ? { boundMachineId: null, requestedMachineId: null, boundMachineRevoked: false, activeMachines: [] }
    : { grants: [] } }));
  renderSection();
  expect(await screen.findByText('None')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Grant a connector' })).toHaveAttribute('href', '/v2/connectors');
});

test('each grant shows its tools as text, so two grants for one connector are told apart', async () => {
  axios.get.mockImplementation((url) => Promise.resolve({ data: url.includes('/agent-binding/placement')
    ? { boundMachineId: null, requestedMachineId: null, boundMachineRevoked: false, activeMachines: [] }
    : { grants: [response.grants[0], { ...response.grants[0], grantId: 'grant-2', tools: ['linear.create_issue', 'linear.update_issue'] }] } }));
  renderSection();
  openGrants();
  expect(await screen.findByText('linear.list_issues')).toBeVisible();
  expect(screen.getByText('linear.create_issue, linear.update_issue')).toBeVisible();
});

test('a revoke error clears on Cancel and when a new confirm opens', async () => {
  axios.post.mockRejectedValue(new Error('denied'));
  renderSection();
  openGrants();
  await screen.findByText(/Work · Granted by Owner/);
  const grantsSection = grantsRegion();
  fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
  fireEvent.click(screen.getByRole('button', { name: 'Yes, revoke it' }));
  expect(await within(grantsSection).findByRole('alert')).toHaveTextContent('Could not revoke the grant.');
  fireEvent.click(within(grantsSection).getByRole('button', { name: 'Cancel' }));
  expect(within(grantsSection).queryByRole('alert')).toBeNull();
});

test('opening another grant\'s confirm clears the last revoke error', async () => {
  axios.post.mockRejectedValue(new Error('denied'));
  axios.get.mockImplementation((url) => Promise.resolve({ data: url.includes('/agent-binding/placement')
    ? { boundMachineId: null, requestedMachineId: null, boundMachineRevoked: false, activeMachines: [] }
    : { grants: [response.grants[0], { ...response.grants[0], grantId: 'grant-2', connector: 'sentry', tools: ['sentry.list_issues'] }] } }));
  renderSection();
  openGrants();
  await screen.findByText('sentry.list_issues');
  const grantsSection = grantsRegion();
  fireEvent.click(screen.getAllByRole('button', { name: 'Revoke' })[0]);
  fireEvent.click(screen.getByRole('button', { name: 'Yes, revoke it' }));
  expect(await within(grantsSection).findByRole('alert')).toHaveTextContent('Could not revoke the grant.');
  fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
  expect(within(grantsSection).queryByRole('alert')).toBeNull();
});

test('a revoked machine and a requested one both show', async () => {
  axios.get.mockImplementation((url) => Promise.resolve({ data: url.includes('/agent-binding/placement')
    ? { boundMachineId: null, requestedMachineId: 'new', boundMachineRevoked: true,
      activeMachines: [{ machineId: 'new', name: 'New Mac' }] } : response }));
  renderSection();
  expect(await screen.findByText('This computer’s key was revoked. Choose another computer to run this agent.')).toBeInTheDocument();
  expect(screen.getByText('Waiting for New Mac to start this agent')).toBeInTheDocument();
});
