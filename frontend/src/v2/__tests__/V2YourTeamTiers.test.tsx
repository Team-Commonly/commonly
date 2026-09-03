// @ts-nocheck
/* eslint-disable react/display-name */
// Wren spec §1 (Sam-ruled 2026-08-30): the roster renders as tiers, not a
// wall. Pinned here: featured tier caps and is the ONLY place the liveness
// dot exists; standard cards carry the always-visible talk icon (BEND-2
// fallback, hover-reveal rejected) and no dot; quiet and internal collapse.
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import V2YourTeamPage from '../components/V2YourTeamPage';
import { AuthContext } from '../../context/AuthContext';

jest.mock('axios', () => {
  const mock = {
    get: jest.fn(),
    post: jest.fn(),
    defaults: { baseURL: '', headers: { common: {} } },
    interceptors: {
      request: { use: jest.fn(), eject: jest.fn() },
      response: { use: jest.fn(), eject: jest.fn() },
    },
  };
  return { __esModule: true, default: mock, ...mock };
});

const axios = jest.requireMock('axios').default;

jest.mock('../components/V2Avatar', () => () => <span data-testid="team-avatar" />);

const authValue = {
  currentUser: { _id: 'u1', username: 'sam', role: 'user' },
  user: { _id: 'u1', username: 'sam', role: 'user' },
  token: 'jwt',
  loading: false,
  error: null,
  isAuthenticated: true,
  register: jest.fn(),
  login: jest.fn(),
  logout: jest.fn(),
  updateProfile: jest.fn(),
};

const minutesAgo = (m) => new Date(Date.now() - m * 60000).toISOString();

const agents = [
  { name: 'fable', instanceId: 'lead', displayName: 'Fable', lastActiveAt: minutesAgo(4), lastMessage: { snippet: 'Shipped the fix to main.', at: minutesAgo(4) } },
  { name: 'sage', instanceId: 'default', displayName: 'Sage', lastActiveAt: minutesAgo(2 * 24 * 60) },
  { name: 'dusty', instanceId: 'default', displayName: 'Dusty', lastActiveAt: minutesAgo(30 * 24 * 60) },
  { name: 'ghost', instanceId: 'default', displayName: 'Ghost', lastActiveAt: null },
  // internal comes from the server listing (#1377) — the page must not
  // re-derive it from the name.
  { name: 'hosted-smoke', instanceId: 'default', displayName: 'Hosted Smoke', lastActiveAt: minutesAgo(1), internal: true },
  // Matches the RETIRED client name pattern but carries no server flag — must
  // render like any other agent, proving the page no longer curates names.
  { name: 'smoke-widget', instanceId: 'default', displayName: 'Smoke Widget', lastActiveAt: minutesAgo(3 * 24 * 60) },
];

const renderPage = (agentRows = agents) => {
  axios.get.mockImplementation((url) => {
    if (url === '/api/pods') return Promise.resolve({ data: [{ _id: 'p1', name: 'Workspace' }] });
    if (url.startsWith('/api/registry/pods/p1/agents')) return Promise.resolve({ data: { agents: agentRows } });
    return Promise.resolve({ data: {} });
  });
  return render(
    <AuthContext.Provider value={authValue}>
      <MemoryRouter>
        <V2YourTeamPage />
      </MemoryRouter>
    </AuthContext.Provider>,
  );
};

afterEach(() => {
  jest.clearAllMocks();
  window.localStorage.clear();
});

describe('Your Team tiers', () => {
  test('recently active agents render featured — and only they carry the dot', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Fable')).toBeInTheDocument());
    const featured = screen.getAllByTestId('team-featured-card');
    expect(featured).toHaveLength(1);
    expect(featured[0]).toHaveTextContent('Fable');
    // The dot exists exactly once on the page: in the featured tier.
    expect(screen.getAllByTestId('team-dot')).toHaveLength(1);
    // Line 2 quotes what the agent last said (server-trimmed snippet).
    expect(featured[0]).toHaveTextContent('“Shipped the fix to main.”');
  });

  test('a live seat without recent output says UNVERIFIABLE instead of reading as quiet', async () => {
    renderPage([
      ...agents,
      {
        name: 'silent-but-live', instanceId: 'default', displayName: 'Silent but live',
        lastActiveAt: minutesAgo(2), outputState: 'unverifiable',
      },
    ]);

    const card = (await screen.findByText('Silent but live')).closest('.v2-team-feature');
    expect(card).toHaveTextContent('UNVERIFIABLE — no message in the last 30 minutes');
    expect(card).not.toHaveTextContent('Quiet');
  });

  test('standard cards carry the always-visible talk icon, no dot, no button pair', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Sage')).toBeInTheDocument());
    const sageCard = screen.getByText('Sage').closest('.v2-team-card');
    // Always-visible icon action (BEND-2 fallback) — present without hover.
    expect(sageCard.querySelector('button.v2-team-card__talk-icon')).not.toBeNull();
    // No dot and no old text-button pair on the standard tier.
    expect(sageCard.querySelector('[data-testid="team-dot"]')).toBeNull();
    expect(sageCard.querySelector('.v2-team-card__talk')).toBeNull();
  });

  test('quiet agents collapse behind a count when more than 3, expand on toggle', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Fable')).toBeInTheDocument());
    // Two quiet agents (Dusty 30d, Ghost never) → ≤3 so default open.
    expect(screen.getByRole('button', { name: 'Quiet (2)' })).toBeInTheDocument();
    expect(screen.getAllByTestId('team-quiet-row').length).toBeGreaterThanOrEqual(2);
    fireEvent.click(screen.getByRole('button', { name: 'Quiet (2)' }));
    expect(screen.queryByText('Dusty')).not.toBeInTheDocument();
  });

  test('internal seats hide behind a collapsed disclosure regardless of activity', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Fable')).toBeInTheDocument());
    // hosted-smoke was active 1 minute ago and still must NOT be featured.
    expect(screen.queryByText('Hosted Smoke')).not.toBeInTheDocument();
    const toggle = screen.getByTestId('team-internal-toggle');
    expect(toggle).toHaveTextContent('Connected agents (1)');
    // smoke-widget matches the old client-side name pattern but has no server
    // flag: it stays on the open roster, not behind the disclosure.
    expect(screen.getByText('Smoke Widget')).toBeInTheDocument();
    fireEvent.click(toggle);
    expect(screen.getByText('Hosted Smoke')).toBeInTheDocument();
  });

  test('the invite-gated notice stays a quiet line with its code link', async () => {
    renderPage();
    const noticeText = await screen.findByText('Hosted agents are invite-gated during beta.');
    const notice = noticeText.closest('.v2-team__entitlement-notice');

    expect(notice).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Have an invitation code?' })).toBeInTheDocument();
  });

  test('header kicker reports real numbers: total and active this week, internal excluded', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Fable')).toBeInTheDocument());
    // 6 agents total; active this week = Fable + Sage + Smoke Widget
    // (hosted-smoke internal, excluded).
    expect(screen.getByText('6 agents · 3 active this week')).toBeInTheDocument();
  });

  test('header offers exactly hire + add-a-computer — channels have no CTA here (Sam 2026-09-01)', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Fable')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Hire an agent' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add a computer' })).toBeInTheDocument();
    // "Connect" (the channels page) must not sit next to an agent-runtime CTA
    // — same verb, different concept was the confusion being removed.
    expect(screen.queryByRole('button', { name: 'Connect' })).toBeNull();
    expect(screen.queryByText('Connect your own agent')).toBeNull();
  });

  test('Talk to opens the agent-room endpoint directly instead of routing through the profile', async () => {
    axios.post.mockResolvedValue({ data: { room: { _id: 'room-fable' } } });
    window.localStorage.setItem('token', 'jwt');
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Talk to' }));

    await waitFor(() => expect(axios.post).toHaveBeenCalledWith(
      '/api/agents/runtime/room',
      { agentName: 'fable', instanceId: 'lead', podId: 'p1' },
      { headers: { Authorization: 'Bearer jwt' } },
    ));
  });
});
