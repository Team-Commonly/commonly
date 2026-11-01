import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import V2AgentControlSection, { AgentControlLoader } from '../components/V2AgentControlSection';
import i18n, { i18nReady } from '../../i18n';

jest.mock('../../utils/axiosConfig', () => ({
  __esModule: true,
  default: { get: jest.fn() },
}));
const api = jest.requireMock('../../utils/axiosConfig').default;

beforeAll(async () => { await i18nReady; await i18n.changeLanguage('en'); });

const show = (state: 'revoked' | 'stale' | 'never' | 'connected') => render(
  <MemoryRouter><V2AgentControlSection agentName="local" instanceId="default" podId="pod-1" runtimeType="wrapper"
    connection={{ state, lastSeenAt: state === 'stale' ? new Date(Date.now() - 7 * 60000).toISOString() : null }} />
  </MemoryRouter>,
);

it('shows a revoked wrapper key and its one reconnect route', () => {
  show('revoked');
  expect(screen.getByTestId('agent-control-section')).toHaveTextContent('Disconnected: key revoked');
  expect(screen.getByRole('link', { name: 'Reconnect' }))
    .toHaveAttribute('href', '/v2/agents/byo?pod=pod-1&name=local&instanceId=default&reconnect=1&mode=machine');
});

it('keeps a never-connected key off the reconnect path', () => {
  show('never');
  expect(screen.getByTestId('agent-control-section')).toHaveTextContent('Not connected yet');
  expect(screen.queryByRole('link', { name: 'Reconnect' })).toBeNull();
});

it('offers the connected wrapper one owner-directed key regeneration route', () => {
  show('connected');
  expect(screen.getByRole('link', { name: 'Regenerate key' }))
    .toHaveAttribute('href', '/v2/agents/byo?pod=pod-1&name=local&instanceId=default&reconnect=1&mode=machine');
  expect(screen.queryByRole('link', { name: 'Reconnect' })).toBeNull();
});

it('keeps a nondefault instance on the connected wrapper key route', () => {
  render(<MemoryRouter><V2AgentControlSection agentName="local" instanceId="alpha" podId="pod-1"
    runtimeType="wrapper" connection={{ state: 'connected', lastSeenAt: new Date().toISOString() }} />
  </MemoryRouter>);
  expect(screen.getByRole('link', { name: 'Regenerate key' }))
    .toHaveAttribute('href', '/v2/agents/byo?pod=pod-1&name=local&instanceId=alpha&reconnect=1&mode=machine');
});

it('loads connection state from an installer-owned pod', async () => {
  const onConnectionState = jest.fn();
  api.get.mockImplementation((url: string) => {
    if (url.endsWith('/manage-settings')) return Promise.resolve({ data: {
      installations: [{ podId: 'read-only-pod' }], writablePodId: 'owned-pod',
    } });
    if (url === '/api/registry/pods/owned-pod/agents') return Promise.resolve({ data: { agents: [{
      name: 'local', instanceId: 'default', runtime: { runtimeType: 'wrapper' },
      connection: { state: 'revoked', lastSeenAt: null },
    }] } });
    return Promise.reject(new Error('Unexpected request'));
  });
  render(<MemoryRouter><AgentControlLoader agentName="local" instanceId="default"
    onConnectionState={onConnectionState} /></MemoryRouter>);
  expect(await screen.findByRole('link', { name: 'Reconnect' }))
    .toHaveAttribute('href', '/v2/agents/byo?pod=owned-pod&name=local&instanceId=default&reconnect=1&mode=machine');
  expect(api.get).toHaveBeenCalledWith('/api/registry/agents/local/manage-settings',
    { params: { instanceId: 'default' } });
  expect(onConnectionState).toHaveBeenCalledWith('revoked', { state: 'revoked', lastSeenAt: null });
});

it('refreshes the header after a key change and drops the old connected state', async () => {
  let revoked = false;
  api.get.mockImplementation((url: string) => {
    if (url.endsWith('/manage-settings')) return Promise.resolve({ data: { writablePodId: 'owned-pod' } });
    if (url === '/api/registry/pods/owned-pod/agents') return Promise.resolve({ data: { agents: [{
      name: 'local', instanceId: 'default', runtime: { runtimeType: 'webhook' },
      connection: { state: revoked ? 'revoked' : 'connected', lastSeenAt: revoked ? null : new Date().toISOString() },
    }] } });
    return Promise.reject(new Error('Unexpected request'));
  });
  const renderLoader = (refreshNonce: number) => <MemoryRouter><AgentControlLoader
    agentName="local" instanceId="default" refreshNonce={refreshNonce} /></MemoryRouter>;
  const view = render(renderLoader(0));
  expect(await screen.findByText('Connected')).toBeInTheDocument();
  revoked = true;
  view.rerender(renderLoader(1));
  expect(await screen.findByText('Disconnected: key revoked')).toBeInTheDocument();
  expect(screen.queryByText('Connected')).toBeNull();
});

it('keeps Control steady while a key-change refresh is pending', async () => {
  let resolveRefresh: ((value: unknown) => void) | undefined;
  let rosterReads = 0;
  api.get.mockImplementation((url: string) => {
    if (url.endsWith('/manage-settings')) return Promise.resolve({ data: { writablePodId: 'owned-pod' } });
    if (url === '/api/registry/pods/owned-pod/agents') {
      rosterReads += 1;
      if (rosterReads === 2) return new Promise((resolve) => { resolveRefresh = resolve; });
      return Promise.resolve({ data: { agents: [{
        name: 'local', instanceId: 'default', runtime: { runtimeType: 'wrapper' },
        connection: { state: 'connected', lastSeenAt: new Date().toISOString() },
      }] } });
    }
    return Promise.reject(new Error('Unexpected request'));
  });
  const renderLoader = (refreshNonce: number) => <MemoryRouter><AgentControlLoader
    agentName="local" instanceId="default" refreshNonce={refreshNonce} /></MemoryRouter>;
  const view = render(renderLoader(0));
  expect(await screen.findByRole('link', { name: 'Regenerate key' })).toBeInTheDocument();
  view.rerender(renderLoader(1));
  await waitFor(() => expect(rosterReads).toBe(2));
  expect(screen.getByRole('link', { name: 'Regenerate key' })).toBeInTheDocument();
  expect(screen.queryByText('Checking connection…')).toBeNull();
  resolveRefresh?.({ data: { agents: [{
    name: 'local', instanceId: 'default', runtime: { runtimeType: 'wrapper' },
    connection: { state: 'revoked', lastSeenAt: null },
  }] } });
  expect(await screen.findByRole('link', { name: 'Reconnect' })).toBeInTheDocument();
});

it('uses unavailable only when the roster has no connection signal', async () => {
  api.get.mockImplementation((url: string) => {
    if (url.endsWith('/manage-settings')) return Promise.resolve({ data: { writablePodId: 'owned-pod' } });
    if (url === '/api/registry/pods/owned-pod/agents') return Promise.resolve({ data: { agents: [{
      name: 'local', instanceId: 'default', runtime: { runtimeType: 'native' },
    }] } });
    return Promise.reject(new Error('Unexpected request'));
  });
  render(<MemoryRouter><AgentControlLoader agentName="local" instanceId="default" /></MemoryRouter>);
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Connection status unavailable'));
});

describe('hideWhenConnected (Settings reports a healthy connection in its header)', () => {
  const showHidden = (state: 'revoked' | 'connected', runtimeType = 'webhook') => render(
    <MemoryRouter><V2AgentControlSection agentName="local" instanceId="default" podId="pod-1" runtimeType={runtimeType}
      hideWhenConnected connection={{ state, lastSeenAt: null }} /></MemoryRouter>,
  );

  it('renders nothing for a connected webhook agent', () => {
    showHidden('connected');
    expect(screen.queryByTestId('agent-control-section')).toBeNull();
  });

  it('keeps the row for a revoked agent, with its Reconnect action', () => {
    showHidden('revoked');
    expect(screen.getByTestId('agent-control-section')).toHaveTextContent('Disconnected: key revoked');
    expect(screen.getByRole('link', { name: 'Reconnect' })).toBeInTheDocument();
  });

  it('keeps a connected wrapper row, whose machine-key regeneration lives only there', () => {
    showHidden('connected', 'wrapper');
    expect(screen.getByRole('link', { name: 'Regenerate key' })).toBeInTheDocument();
  });

  it('shows nothing while the first read is in flight, and the unavailable alert after a failure', async () => {
    api.get.mockImplementation(() => new Promise(() => {}));
    const view = render(<MemoryRouter><AgentControlLoader agentName="local" instanceId="default" hideWhenConnected /></MemoryRouter>);
    expect(screen.queryByTestId('agent-control-section')).toBeNull();
    view.unmount();
    api.get.mockImplementation(() => Promise.reject(new Error('offline')));
    render(<MemoryRouter><AgentControlLoader agentName="local" instanceId="default" hideWhenConnected /></MemoryRouter>);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Connection status unavailable'));
  });
});
