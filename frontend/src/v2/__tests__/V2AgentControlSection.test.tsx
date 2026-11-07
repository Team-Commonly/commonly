import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import V2AgentControlSection, { AgentControlLoader } from '../components/V2AgentControlSection';
import i18n, { i18nReady } from '../../i18n';

jest.mock('../../utils/axiosConfig', () => ({
  __esModule: true,
  default: { get: jest.fn() },
}));
const api = jest.requireMock('../../utils/axiosConfig').default;

beforeAll(async () => { await i18nReady; await i18n.changeLanguage('en'); });

const showFix = (fixCommand?: string, state: 'never' | 'connected' = 'never', runtimeType = 'webhook') => render(
  <MemoryRouter><V2AgentControlSection agentName="maple" instanceId="default" podId="pod-1" runtimeType={runtimeType} actionsOnly
    connection={{ state, lastSeenAt: null }} fixCommand={fixCommand} /></MemoryRouter>,
);

describe('a never-connected agent on Settings', () => {
  test('shows its owner the command, with a way to copy it', async () => {
    const writeText = jest.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    showFix('commonly agent run maple');
    expect(screen.getByTestId('agent-connect-command')).toHaveTextContent('commonly agent run maple');
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    expect(writeText).toHaveBeenCalledWith('commonly agent run maple');
    expect(await screen.findByRole('button', { name: 'Copied!' })).toBeInTheDocument();
  });

  test('links to the page that hands out the key the command needs, keeping the agent\'s name', () => {
    showFix('commonly agent run maple');
    expect(screen.getByRole('link', { name: 'Connect' })).toHaveAttribute('href',
      '/v2/agents/byo?pod=pod-1&name=maple&instanceId=default&reconnect=1');
  });

  test('a second instance keeps its command and gets no link: the page would install a sibling', () => {
    render(<MemoryRouter><V2AgentControlSection agentName="maple" instanceId="nova" podId="pod-1" runtimeType="webhook"
      connection={{ state: 'never', lastSeenAt: null }} fixCommand="commonly agent run maple" /></MemoryRouter>);
    expect(screen.getByTestId('agent-connect-command')).toHaveTextContent('commonly agent run maple');
    expect(screen.queryByRole('link', { name: 'Connect' })).not.toBeInTheDocument();
  });

  test('a wrapper gets no link, because that page would offer it Reconnect', () => {
    showFix('commonly agent run maple', 'never', 'wrapper');
    expect(screen.getByTestId('agent-connect-command')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Connect' })).not.toBeInTheDocument();
  });

  test('a webhook gets its sentence and nothing to copy', () => {
    showFix('Run the program behind your webhook URL.');
    expect(screen.queryByRole('link', { name: 'Connect' })).not.toBeInTheDocument();
    expect(screen.getByTestId('agent-control-section')).toHaveTextContent('Run the program behind your webhook URL.');
    expect(screen.queryByRole('button', { name: 'Copy' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('agent-connect-command')).not.toBeInTheDocument();
  });

  test('someone who did not install it gets no row', () => {
    showFix(undefined);
    expect(screen.queryByTestId('agent-control-section')).not.toBeInTheDocument();
  });

  test('a connected agent does not show the command', () => {
    showFix('commonly agent run maple', 'connected');
    expect(screen.queryByTestId('agent-connect-command')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Connect' })).not.toBeInTheDocument();
  });

  test('the loader passes the roster command through', async () => {
    api.get.mockImplementation((url: string) => {
      if (url.endsWith('/manage-settings')) return Promise.resolve({ data: { writablePodId: 'pod-9' } });
      if (url === '/api/registry/pods/pod-9/agents') return Promise.resolve({ data: { agents: [{
        name: 'maple', instanceId: 'default', runtime: { runtimeType: 'wrapper' },
        connection: { state: 'never', lastSeenAt: null }, fixCommand: 'commonly agent run maple',
      }] } });
      return Promise.reject(new Error('Unexpected request'));
    });
    render(<MemoryRouter><AgentControlLoader agentName="maple" instanceId="default" actionsOnly /></MemoryRouter>);
    expect(await screen.findByTestId('agent-connect-command')).toHaveTextContent('commonly agent run maple');
  });
});

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

describe('actionsOnly (Settings reports the connection in its head)', () => {
  const showHidden = (state: 'revoked' | 'connected' | 'available' | 'never', runtimeType = 'webhook') => render(
    <MemoryRouter><V2AgentControlSection agentName="local" instanceId="default" podId="pod-1" runtimeType={runtimeType}
      actionsOnly connection={{ state, lastSeenAt: null }} /></MemoryRouter>,
  );

  it('renders nothing for a connected webhook agent', () => {
    showHidden('connected');
    expect(screen.queryByTestId('agent-control-section')).toBeNull();
  });

  it.each(['available', 'never'] as const)('renders nothing for %s, which has no action', (state) => {
    showHidden(state, 'internal');
    expect(screen.queryByTestId('agent-control-section')).toBeNull();
  });

  it('keeps the row for a revoked agent, with its Reconnect action', () => {
    showHidden('revoked');
    expect(screen.getByTestId('agent-control-section')).toHaveTextContent('Disconnected: key revoked');
    expect(screen.getByRole('link', { name: 'Reconnect' })).toBeInTheDocument();
  });

  it('keeps a connected wrapper row, whose machine-key regeneration lives there', () => {
    showHidden('connected', 'wrapper');
    expect(screen.getByRole('link', { name: 'Regenerate key' })).toBeInTheDocument();
  });

  it('shows nothing while the first read is in flight, and the unavailable alert after a failure', async () => {
    api.get.mockImplementation(() => new Promise(() => {}));
    const view = render(<MemoryRouter><AgentControlLoader agentName="local" instanceId="default" actionsOnly /></MemoryRouter>);
    expect(screen.queryByTestId('agent-control-section')).toBeNull();
    view.unmount();
    api.get.mockImplementation(() => Promise.reject(new Error('offline')));
    render(<MemoryRouter><AgentControlLoader agentName="local" instanceId="default" actionsOnly /></MemoryRouter>);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Connection status unavailable'));
  });
});
