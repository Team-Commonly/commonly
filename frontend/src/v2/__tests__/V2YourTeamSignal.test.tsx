// @ts-nocheck
// Your Team, direction C (YourTeam.dc.html) — ux-lead rulings 66163–66165.
import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import axios from 'axios';
import V2YourTeamPage from '../components/V2YourTeamPage';
import { AuthContext } from '../../context/AuthContext';

jest.mock('axios', () => {
  const mock = { get: jest.fn(), post: jest.fn(), defaults: { baseURL: '', headers: { common: {} } }, interceptors: { request: { use: jest.fn(), eject: jest.fn() }, response: { use: jest.fn(), eject: jest.fn() } } };
  return { __esModule: true, default: mock, ...mock };
});
const mockNavigate = jest.fn();
jest.mock('react-router-dom', () => ({ ...jest.requireActual('react-router-dom'), useNavigate: () => mockNavigate }));

const authValue = {
  currentUser: { _id: 'u1', username: 'sam', role: 'user' }, user: { _id: 'u1', username: 'sam', role: 'user' },
  token: 't', loading: false, error: null, isAuthenticated: true, register: jest.fn(), login: jest.fn(), logout: jest.fn(), updateProfile: jest.fn(),
};
const minutesAgo = (m) => new Date(Date.now() - m * 60000).toISOString();

const agents = {
  p1: [
    { name: 'wren', instanceId: 'default', displayName: 'Wren', userId: 'wren-user', lastActiveAt: minutesAgo(3), description: 'Connectors. Presses PRs, watches deploys.' },
    { name: 'kai', instanceId: 'default', displayName: 'Kai', userId: 'kai-user', iconUrl: 'https://x/kai.png', lastActiveAt: minutesAgo(2), description: 'Fixes. Small PRs with a test each.' },
    { name: 'sage', instanceId: 'default', displayName: 'Sage', userId: 'sage-user', lastActiveAt: minutesAgo(41), description: null },
    { name: 'hosted-smoke', instanceId: 'default', displayName: 'Hosted Smoke', lastActiveAt: minutesAgo(1), internal: true },
  ],
  p2: [
    { name: 'wren', instanceId: 'default', displayName: 'Wren', userId: 'wren-user', lastActiveAt: minutesAgo(30) },
  ],
};

const renderPage = (over = {}) => {
  const queue = over.queue ?? [{ id: 'd-1', kind: 'decision', title: 'Slack defaults', podId: 'p2', messageId: '900', actorUserId: 'wren-user' }];
  axios.get.mockImplementation((url) => {
    if (url === '/api/pods') return Promise.resolve({ data: [{ _id: 'p1', name: 'Sharpen — pod model, attention routing, hardening' }, { _id: 'p2', name: 'Connectors v2 — channel routing' }] });
    if (url.startsWith('/api/registry/pods/p1/agents')) return Promise.resolve({ data: { agents: agents.p1 } });
    if (url.startsWith('/api/registry/pods/p2/agents')) return Promise.resolve({ data: { agents: agents.p2 } });
    // `claimedBy` is the claimer's User id (never a name); `assignee` is a name
    // written by PATCH and is not a claim.
    if (url.startsWith('/api/v1/tasks/p1')) return Promise.resolve({ data: { tasks: [{ taskId: 'TASK-131', status: 'claimed', claimedBy: 'kai-user' }, { taskId: 'TASK-140', status: 'claimed', claimedBy: null, assignee: 'sage' }] } });
    if (url.startsWith('/api/v1/tasks/p2')) return Promise.resolve({ data: { tasks: [{ status: 'claimed', claimedBy: 'wren-user' }, { taskId: 'TASK-999', status: 'claimed', claimedBy: 'nobody-on-the-page' }] } });
    if (url.startsWith('/api/activity/decision-queue')) return Promise.resolve({ data: { items: queue } });
    return Promise.resolve({ data: {} });
  });
  return render(
    <AuthContext.Provider value={authValue}>
      <MemoryRouter><V2YourTeamPage /></MemoryRouter>
    </AuthContext.Provider>,
  );
};
const cardOf = (name) => screen.getByText(name).closest('[data-testid="team-card"]');

afterEach(() => { jest.clearAllMocks(); window.localStorage.clear(); });

describe('Your Team (direction C)', () => {
  test('head: display title, one mono meta line with agents · working · needs you, Bring your own bordered + Hire an agent ink', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Wren')).toBeInTheDocument());
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Your team');
    // 3 visible agents (internal excluded); Kai working (2m); Wren needs you.
    expect(screen.getByText('3 agents · 1 working · 1 needs you')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Bring your own' })).toHaveClass('v2-team__byo');
    expect(screen.getByRole('button', { name: 'Hire an agent' })).toHaveClass('v2-team__hire');
    expect(screen.queryByRole('button', { name: 'Add a computer' })).toBeNull();
  });

  test('the agent waiting on you: ring, cobalt mark, `● needs you · <ask>`, Answer ink + Talk bordered — keyed on actorUserId, not a name', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Wren')).toBeInTheDocument());
    const card = cardOf('Wren');
    expect(card).toHaveAttribute('data-state', 'needsYou');
    expect(card).toHaveClass('v2-team-card--needsYou');
    expect(card.querySelector('.v2-team-card__mark--needsYou')).not.toBeNull();
    expect(card.querySelector('.v2-team-card__status')).toHaveTextContent('● needs you · Slack defaults');
    expect(within(card).getByRole('button', { name: 'Answer' })).toHaveClass('v2-team-card__answer');
    expect(within(card).getByRole('button', { name: 'Talk to Wren one-to-one' })).toHaveClass('v2-team-card__talk');
    fireEvent.click(within(card).getByRole('button', { name: 'Answer' }));
    expect(mockNavigate).toHaveBeenCalledWith('/v2/pods/p2#message-900');
    // Wren sits in two pods → two chips, lowercase mono.
    expect(card.querySelectorAll('.v2-team-card__pod')).toHaveLength(2);
    expect(card.querySelector('.v2-team-card__pods')).toHaveTextContent('sharpen');
  });

  test('working: ink mark and `● working · TASK-nnn` from the claimed task; no Answer', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Kai')).toBeInTheDocument());
    const card = cardOf('Kai');
    expect(card).toHaveAttribute('data-state', 'working');
    expect(card.querySelector('.v2-team-card__mark--working')).not.toBeNull();
    expect(card.querySelector('.v2-team-card__status')).toHaveTextContent('● working · TASK-131');
    expect(within(card).queryByRole('button', { name: 'Answer' })).toBeNull();
    expect(card.querySelector('.v2-team-card__desc')).toHaveTextContent('Fixes. Small PRs with a test each.');
  });

  test('idle: divider mark, muted `idle · 41m`, and NO description line when the listing has none — never a quote', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Sage')).toBeInTheDocument());
    const card = cardOf('Sage');
    expect(card).toHaveAttribute('data-state', 'idle');
    expect(card.querySelector('.v2-team-card__mark--idle')).not.toBeNull();
    expect(card.querySelector('.v2-team-card__status')).toHaveTextContent('idle · 41m');
    expect(card.querySelector('.v2-team-card__status')).not.toHaveTextContent('●');
    expect(card.querySelector('.v2-team-card__desc')).toBeNull();
    expect(card.textContent).not.toMatch(/[“”]/);
  });

  test('without a matching actorUserId nobody needs you, even if a name would match', async () => {
    renderPage({ queue: [{ id: 'm-1', kind: 'mention', title: 'Wren mentioned you', actorName: 'Wren', podId: 'p1' }] });
    await waitFor(() => expect(screen.getByText('Wren')).toBeInTheDocument());
    // Wren holds a claim without a task id: working, `working · <pod>`; Sage is only
    // ASSIGNED (never claimed) and stays idle — assignment is not work.
    expect(cardOf('Wren')).toHaveAttribute('data-state', 'working');
    expect(cardOf('Wren').querySelector('.v2-team-card__status')).toHaveTextContent('working · Connectors v2');
    expect(cardOf('Sage')).toHaveAttribute('data-state', 'idle');
    expect(screen.getByText('3 agents · 2 working · 0 needs you')).toBeInTheDocument();
  });

  test('cards order needs-you → working → idle; the Your-own-agent card closes the grid with the attach command', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Wren')).toBeInTheDocument());
    const names = screen.getAllByTestId('team-card').map((c) => c.querySelector('.v2-team-card__name').textContent);
    expect(names).toEqual(['Wren', 'Kai', 'Sage']);
    // Chips carry the pod's short name, never the subtitle after the em-dash.
    expect(cardOf('Kai').querySelector('.v2-team-card__pods')).toHaveTextContent('sharpen');
    expect(cardOf('Kai').textContent).not.toMatch(/pod model, attention/);
    const own = screen.getByTestId('team-own-card');
    expect(own).toHaveTextContent('npx @commonlyai/cli agent attach claude');
    fireEvent.click(within(own).getByRole('button', { name: 'Set it up' }));
    expect(mockNavigate).toHaveBeenCalledWith('/v2/agents/byo');
  });

  test('claims match on the User id only — a name never matches, and a claim by someone off the page lights no card', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Kai')).toBeInTheDocument());
    expect(cardOf('Kai').querySelector('.v2-team-card__status')).toHaveTextContent('working · TASK-131');
    expect(cardOf('Sage')).toHaveAttribute('data-state', 'idle');
    expect(screen.queryByText(/TASK-999/)).toBeNull();
  });

  test('cards preserve uploaded avatars and generate Big Smile faces for other agents', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Kai')).toBeInTheDocument());
    const mark = cardOf('Kai').querySelector('.v2-team-card__mark');
    expect(mark.querySelector('img')).toHaveAttribute('src', 'https://x/kai.png');
    expect(cardOf('Wren').querySelector('.v2-team-card__mark img')).toHaveAttribute('src', expect.stringMatching(/^data:image\/svg\+xml/));
  });

  test('internal seats stay behind the mono disclosure and out of the counts', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Wren')).toBeInTheDocument());
    expect(screen.queryByText('Hosted Smoke')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('team-internal-toggle'));
    expect(screen.getByText('Hosted Smoke')).toBeInTheDocument();
  });

  test('Talk opens the agent-room endpoint directly; Hire an agent opens the invite line while not entitled', async () => {
    axios.post.mockResolvedValue({ data: { room: { _id: 'room-kai' } } });
    window.localStorage.setItem('token', 'jwt');
    renderPage();
    await waitFor(() => expect(screen.getByText('Kai')).toBeInTheDocument());
    fireEvent.click(within(cardOf('Kai')).getByRole('button', { name: 'Talk to Kai one-to-one' }));
    await waitFor(() => expect(axios.post).toHaveBeenCalledWith('/api/agents/runtime/room', { agentName: 'kai', instanceId: 'default', podId: 'p1' }, { headers: { Authorization: 'Bearer jwt' } }));
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/v2/pods/room-kai'));
    expect(screen.getByText('Hosted agents are invite-gated during beta.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Hire an agent' }));
    expect(screen.getByPlaceholderText('Invitation code')).toBeInTheDocument();
  });
});
