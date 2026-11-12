// @ts-nocheck
// D115 agent health page (docs/design/artboards/d115/). It draws only what
// GET /api/agents/health returns: counts, fixed codes and times.
import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import axios from 'axios';
import V2AgentHealthPage, { segmentCounts, roundTokens } from '../components/V2AgentHealthPage';
import { AuthContext } from '../../context/AuthContext';

jest.mock('axios', () => {
  const mock = { get: jest.fn(), post: jest.fn(), defaults: { baseURL: '', headers: { common: {} } }, interceptors: { request: { use: jest.fn() }, response: { use: jest.fn() } } };
  return { __esModule: true, default: mock, ...mock };
});

const user = { _id: 'u1', username: 'viewer', role: 'user' };
const authValue = {
  currentUser: user, user, token: 't', loading: false, error: null, isAuthenticated: true,
  register: jest.fn(), login: jest.fn(), logout: jest.fn(), mergeUser: jest.fn(),
};

const buckets = (over = {}) => ({ total: 0, posted: 0, declined: 0, failed: 0, expired: 0, acknowledged: 0, inFlight: 0, ...over });
const kinds = (over = {}) => ({ mention: 0, heartbeat: 0, chat: 0, decision: 0, joined: 0, ...over });
const row = (over = {}) => ({
  agentName: 'otter', instanceId: 'default', displayName: 'otter',
  pod: { id: 'p1', name: 'On-call', type: 'chat' }, installStatus: 'active', runtime: 'hosted',
  asked: buckets(), heartbeats: buckets(), digests: 0, kinds: kinds(), otherKinds: {},
  runs: null, liveness: null, needsYou: null, ...over,
});
const response = (agents, window = { hours: 24, retentionHours: 168, options: [24, 72, 168] }) => ({ data: { window, agents } });

const Where = () => <div data-testid="where">{useLocation().pathname}{useLocation().search}</div>;
const renderPage = (path = '/v2/agents/health') => render(
  <AuthContext.Provider value={authValue}>
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/v2/agents/health" element={<><V2AgentHealthPage /><Where /></>} />
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>
  </AuthContext.Provider>,
);

afterEach(() => { jest.clearAllMocks(); window.localStorage.clear(); });

describe('V2AgentHealthPage', () => {
  test('a busy row: the asked split, heartbeats apart, kinds with a raw type, metered turns', async () => {
    axios.get.mockResolvedValue(response([row({
      asked: buckets({ total: 4, posted: 2, declined: 1, inFlight: 1 }),
      heartbeats: buckets({ total: 18, posted: 2 }),
      kinds: kinds({ mention: 2, heartbeat: 18 }), otherKinds: { 'task.assigned': 2 }, digests: 1,
      runs: { total: 7, succeeded: 6, failed: 0, interrupted: 0, inFlight: 1, empty: 1, meteredTurns: 7, totalTokens: 18400, sandboxSeconds: 40, errorKinds: {} },
    })]));
    renderPage();
    const table = await screen.findByRole('table');
    const r = within(table).getAllByRole('row')[1];
    expect(within(r).getByText('2 of 4 posted')).toBeInTheDocument();
    // Empty is its own outcome beside the decline, never folded into it.
    expect(within(r).getByText('1 declined · 1 empty · 1 in flight')).toBeInTheDocument();
    expect(within(r).getByText('18')).toBeInTheDocument();
    expect(r.textContent).toContain('2 mentions · 18 heartbeats · 2 task.assigned · 1 digest');
    expect(within(r).getByText('task.assigned').tagName).toBe('CODE');
    expect(within(r).getByText('7 turns')).toBeInTheDocument();
    expect(r.textContent).toContain('18k tokens · 40 s sandbox');
    expect(within(r).getByText('Hosted')).toBeInTheDocument();
    expect(screen.getByText('Agents in your pods · 1 install')).toBeInTheDocument();
  });

  test('an agent on someone\'s computer: needs you by its code, cost on their account', async () => {
    axios.get.mockResolvedValue(response([row({
      agentName: 'planner', displayName: 'planner', runtime: 'byo',
      asked: buckets({ total: 4, posted: 1, failed: 3 }), kinds: kinds({ mention: 4 }),
      liveness: { lastSeenAt: new Date().toISOString(), online: true, turnRunning: false, lastSpawnFailure: 'claude-signed-out' },
      needsYou: 'claude-signed-out',
    })]));
    renderPage();
    expect(await screen.findByText('Needs you · Signed out')).toBeInTheDocument();
    expect(screen.getByText('On your account')).toBeInTheDocument();
    expect(screen.getByText('Runs on your computer')).toBeInTheDocument();
    expect(screen.getByText(/1 needs you/)).toBeInTheDocument();
  });

  test('an offline runner says since when; a quiet install keeps its row', async () => {
    axios.get.mockResolvedValue(response([row({
      agentName: 'reviewer', displayName: 'reviewer', runtime: 'byo',
      liveness: { lastSeenAt: '2026-11-10T12:00:00Z', online: false, turnRunning: false, lastSpawnFailure: null },
    })]));
    renderPage();
    expect(await screen.findByText(/^Offline since /)).toBeInTheDocument();
    expect(screen.getByText('No wakes in the last 24 hours')).toBeInTheDocument();
  });

  test('a row opens the agent\'s own page', async () => {
    axios.get.mockResolvedValue(response([row({ asked: buckets({ total: 1, posted: 1 }), kinds: kinds({ mention: 1 }) })]));
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'otter' }));
    expect(screen.getByTestId('where')).toHaveTextContent('/v2/agents/otter/default');
  });

  test('the window offers only what the server offers, and asks for the chosen one', async () => {
    axios.get.mockResolvedValue(response([], { hours: 12, retentionHours: 12, options: [12] }));
    renderPage();
    const group = await screen.findByRole('radiogroup', { name: 'Time span' });
    expect(within(group).getAllByRole('radio').map((b) => b.textContent)).toEqual(['12 hours']);

    axios.get.mockResolvedValue(response([], { hours: 24, retentionHours: 168, options: [24, 72, 168] }));
    renderPage('/v2/agents/health?window=72h');
    await waitFor(() => expect(axios.get).toHaveBeenLastCalledWith('/api/agents/health', expect.objectContaining({ params: { window: '72h' } })));
  });

  test('no agents: one line and Hire an agent', async () => {
    axios.get.mockResolvedValue(response([]));
    renderPage();
    expect(await screen.findByText('No agents in your pods yet')).toBeInTheDocument();
  });

  test('a failed read draws no zeros and retries', async () => {
    axios.get.mockRejectedValueOnce(new Error('network'));
    renderPage();
    expect(await screen.findByRole('alert')).toHaveTextContent('Couldn’t load agent health');
    expect(screen.queryByRole('table')).toBeNull();
    axios.get.mockResolvedValue(response([row({ asked: buckets({ total: 1, posted: 1 }), kinds: kinds({ mention: 1 }) })]));
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('table')).toBeInTheDocument();
  });

  test('the view switch goes back to Agents', async () => {
    axios.get.mockResolvedValue(response([]));
    renderPage();
    const views = await screen.findByRole('radiogroup', { name: 'Your team view' });
    fireEvent.click(within(views).getByRole('radio', { name: 'Agents' }));
    expect(screen.getByTestId('where')).toHaveTextContent('/v2/agents');
  });
});

describe('agent health helpers', () => {
  test('segment counts take empty from runs and nothing else', () => {
    const counts = segmentCounts(row({ asked: buckets({ total: 3, declined: 1, posted: 2 }), runs: { empty: 2 } }));
    expect(counts).toMatchObject({ posted: 2, declined: 1, empty: 2 });
  });
  test('token rounding', () => {
    expect(roundTokens(999)).toBe('999');
    expect(roundTokens(41_400)).toBe('41k');
  });
});
