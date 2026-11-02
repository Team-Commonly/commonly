import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import V2AgentProfile from '../agents/V2AgentProfile';
import i18n, { i18nReady } from '../../i18n';

// The states drawn in d215 section s-agent-profile: signed-in visitor, owner,
// signed out, not found, and the skills lane's capabilities fallback.

jest.mock('axios', () => {
  const profileClient = { get: jest.fn(), post: jest.fn(), put: jest.fn(), delete: jest.fn() };
  return {
    __esModule: true,
    default: { create: jest.fn(() => profileClient) },
    __profileClient: profileClient,
  };
});
jest.mock('../../utils/avatarUtils', () => ({ presetCharacterOptions: jest.fn(() => []) }));
jest.mock('../utils/avatars', () => ({ characterAvatarFor: jest.fn(() => 'face') }));
jest.mock('../components/V2Avatar', () => ({ __esModule: true, default: () => <span data-testid="hero-avatar" /> }));

type Client = { get: jest.Mock; post: jest.Mock; put: jest.Mock; delete: jest.Mock };
const profileClient = (jest.requireMock('axios') as { __profileClient: Client }).__profileClient;

// V2App passes `shell` when the viewer is signed in; a stand-in marks where it wraps.
const shell = (page: React.ReactNode) => <div data-testid="app-shell">{page}</div>;

const renderProfile = (signedIn: boolean) => render(
  <MemoryRouter initialEntries={['/v2/agent/claude-code/ux-lead']}>
    <Routes>
      <Route path="/v2/agent/:agentName/:instanceId" element={<V2AgentProfile shell={signedIn ? shell : undefined} />} />
    </Routes>
  </MemoryRouter>,
);

const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();

const profile = (overrides: Record<string, unknown> = {}) => ({
  agent: {
    agentName: 'claude-code',
    instanceId: 'ux-lead',
    displayName: 'UX Lead Reviewer',
    profilePicture: 'default',
    runtime: 'claude',
    officialAgent: true,
    description: 'Design and the visual gate.',
    capabilities: ['review', 'walk'],
  },
  skills: [{ name: 'visual-review' }, { name: 'a11y-audit' }],
  pods: {
    count: 7,
    public: [
      { id: 'p-design', name: 'Design reviews', lastActive: hoursAgo(2) },
      { id: 'p-launch', name: 'Launch room', lastActive: hoursAgo(26) },
    ],
  },
  memory: { has: true, entryCount: 8, lastAgentWrite: { kind: 'durable', updatedAt: hoursAgo(3) } },
  activity: [
    { status: 'succeeded', trigger: 'chat.mention', startedAt: hoursAgo(1), turns: 4 },
    { status: 'failed', trigger: 'board.wake', startedAt: hoursAgo(5), turns: 2, errorKind: 'timeout' },
  ],
  ...overrides,
});

const ownerPods = Array.from({ length: 7 }, (_, i) => ({
  id: `own-${i}`,
  name: i === 0 ? 'Sharpen' : `Private pod ${i}`,
  lastActive: hoursAgo(i + 1),
  lastMessage: { snippet: `Last word in pod ${i}` },
}));

const mockApi = ({ payload = profile(), owner = false, notFound = false } = {}) => {
  profileClient.get.mockImplementation((url: string) => {
    if (url.endsWith('/avatar/can-edit')) return Promise.resolve({ data: { canEdit: owner } });
    if (url.startsWith('/api/agent-memory/')) {
      return owner
        ? Promise.resolve({ data: {
          viewerRole: 'owner',
          totalEntries: 8,
          lastAgentWrite: { section: 'long_term', updatedAt: hoursAgo(5 * 24) },
          sections: [
            { key: 'long_term', label: 'Long-term memory', kind: 'durable', notes: [] },
            { key: 'soul', label: 'Identity', kind: 'durable', notes: [] },
            { key: 'daily', label: 'Daily journal', kind: 'durable', notes: [] },
          ],
          pods: ownerPods,
        } })
        : Promise.reject(Object.assign(new Error('403'), { response: { status: 403 } }));
    }
    if (url.includes('/manage-settings')) return Promise.resolve({ data: { writablePodId: null } });
    if (url.startsWith('/api/agent-profile/')) {
      return notFound
        ? Promise.reject(Object.assign(new Error('404'), { response: { status: 404 } }))
        : Promise.resolve({ data: payload });
    }
    return Promise.reject(new Error(`unexpected ${url}`));
  });
};

const lane = (name: RegExp) => screen.getByRole('region', { name });

describe('V2AgentProfile (d215 s-agent-profile)', () => {
  beforeAll(async () => {
    await i18nReady;
    await i18n.changeLanguage('en');
  });

  beforeEach(() => {
    window.localStorage.clear();
    jest.clearAllMocks();
  });

  it('signed-in visitor: in the shell, public pods only, the full-name key', async () => {
    window.localStorage.setItem('token', 'viewer-token');
    mockApi();
    renderProfile(true);

    const heading = await screen.findByRole('heading', { level: 1, name: 'UX Lead Reviewer' });
    const appShell = screen.getByTestId('app-shell');
    expect(appShell).toContainElement(heading);
    // No public bar inside the shell.
    expect(screen.queryByRole('link', { name: 'Sign up' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'What is Commonly?' })).toBeNull();

    expect(screen.getByRole('button', { name: 'Talk to UX Lead Reviewer' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Settings' })).toBeNull();
    expect(screen.queryByRole('navigation', { name: 'Agent tabs' })).toBeNull();
    expect(screen.getByText('Active in 7 pods · 8 memories')).toBeInTheDocument();

    const pods = lane(/^Public pods/);
    expect(within(pods).getByRole('heading', { level: 2 })).toHaveTextContent('Public pods 2');
    expect(within(pods).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'Design reviewsactive 2h ago',
      'Launch roomactive 1d ago',
    ]);
    expect(within(pods).queryByRole('button', { name: /Remove/ })).toBeNull();
    expect(screen.queryByText(/you see every pod/)).toBeNull();

    expect(within(lane(/^Skills/)).getByText('visual-review')).toBeInTheDocument();
    expect(within(lane(/^Skills/)).queryByText('review')).toBeNull();
    expect(screen.getByTestId('agent-profile-memory')).toHaveTextContent(
      '8 memories, carried into every pod and runtime it joins. Last saved 3h ago.',
    );
    expect(screen.queryByRole('link', { name: 'Open memory' })).toBeNull();
    const activity = within(lane(/^Recent activity/)).getAllByRole('listitem');
    expect(activity.map((li) => li.textContent)).toEqual(['chat.mention4 turns · 1h ago', 'board.wake2 turns · 5h ago']);
    expect(activity[1].querySelector('.v2-aprofile__run-dot--err')).not.toBeNull();
    expect(activity[0].querySelector('.v2-aprofile__run-dot--err')).toBeNull();
  });

  it('owner: tabs, the Settings key, every pod with Remove, the private memory line', async () => {
    window.localStorage.setItem('token', 'owner-token');
    mockApi({ owner: true });
    const confirm = jest.spyOn(window, 'confirm').mockReturnValue(true);
    profileClient.delete.mockResolvedValue({ data: {} });
    renderProfile(true);

    const tabs = await screen.findByRole('navigation', { name: 'Agent tabs' });
    expect(within(tabs).getByText('Profile')).toHaveAttribute('aria-current', 'page');
    expect(within(tabs).getByRole('link', { name: 'Memory' })).toHaveAttribute('href', '/v2/agents/claude-code/ux-lead/memory');

    const keys = screen.getByRole('button', { name: 'Talk to UX Lead Reviewer' }).parentElement as HTMLElement;
    const settings = within(keys).getByRole('link', { name: 'Settings' });
    expect(settings).toHaveAttribute('href', '/v2/agents/claude-code/ux-lead');
    // Settings sits before the ink key.
    expect(keys.firstElementChild).toBe(settings);

    const pods = lane(/^Pods/);
    expect(within(pods).getByRole('heading', { level: 2 })).toHaveTextContent('Pods 7you see every pod');
    // Five rows, then "Show all 7 pods".
    expect(within(pods).getAllByRole('button', { name: /^Remove claude-code from/ })).toHaveLength(5);
    expect(within(pods).getByText('“Last word in pod 0”')).toBeInTheDocument();
    expect(within(pods).queryByText('Private pod 6')).toBeNull();
    fireEvent.click(within(pods).getByRole('button', { name: 'Show all 7 pods' }));
    expect(within(pods).getByText('Private pod 6')).toBeInTheDocument();
    expect(within(pods).queryByRole('button', { name: /Show all/ })).toBeNull();

    const memory = lane(/^Memory/);
    expect(within(memory).getByRole('heading', { level: 2 })).toHaveTextContent('Memoryowner view · private');
    expect(screen.getByTestId('agent-profile-memory')).toHaveTextContent(
      '8 notes in 3 sections, last saved to Long-term memory 5d ago. Only you and admins can read them. Open memory',
    );
    expect(within(memory).getByRole('link', { name: 'Open memory' })).toHaveAttribute('href', '/v2/agents/claude-code/ux-lead/memory');
    // The big-number card is gone.
    expect(document.querySelector('.v2-aprofile__stat-num')).toBeNull();

    fireEvent.click(within(pods).getByRole('button', { name: 'Remove claude-code from Sharpen' }));
    expect(confirm).toHaveBeenCalled();
    await waitFor(() => expect(profileClient.delete).toHaveBeenCalledWith(
      '/api/registry/agents/claude-code/pods/own-0?instanceId=ux-lead',
      { headers: { Authorization: 'Bearer owner-token' } },
    ));
    confirm.mockRestore();
  });

  it('signed out: the public bar, and the key leads to sign-up', async () => {
    mockApi();
    renderProfile(false);

    await screen.findByRole('heading', { level: 1, name: 'UX Lead Reviewer' });
    expect(screen.queryByTestId('app-shell')).toBeNull();
    const bar = document.querySelector('.v2-aprofile__bar') as HTMLElement;
    expect(within(bar).getByRole('link', { name: 'Sign up' })).toHaveAttribute('href', '/v2/register');
    expect(within(bar).getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/v2/login');
    expect(within(bar).getByRole('link', { name: 'What is Commonly?' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Back to Commonly' })).toBeNull();

    expect(screen.getByRole('link', { name: 'Talk to UX Lead Reviewer' })).toHaveAttribute('href', '/v2/register');
    expect(screen.queryByRole('button', { name: /Talk to/ })).toBeNull();
    expect(screen.queryByRole('navigation', { name: 'Agent tabs' })).toBeNull();
    expect(within(lane(/^Public pods/)).getAllByRole('listitem')).toHaveLength(2);
    // No owner index is requested without a token.
    expect(profileClient.get.mock.calls.some(([url]) => url.startsWith('/api/agent-memory/'))).toBe(false);
  });

  it('not found: the public layout, even when signed in', async () => {
    window.localStorage.setItem('token', 'viewer-token');
    mockApi({ notFound: true });
    renderProfile(true);

    expect(await screen.findByRole('heading', { level: 1, name: 'Agent not found' })).toBeInTheDocument();
    expect(screen.queryByTestId('app-shell')).toBeNull();
    expect(screen.getByText('This agent may not exist. Explore what Commonly is, or start your own team.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Start your own team' })).toHaveAttribute('href', '/v2/register');
    const bar = document.querySelector('.v2-aprofile__bar') as HTMLElement;
    expect(within(bar).getByRole('link', { name: 'Sign up' })).toBeInTheDocument();
  });

  it('skills: capabilities stand in when there are no skills, and the lane goes when both are empty', async () => {
    mockApi({ payload: profile({ skills: [] }) });
    const { unmount } = renderProfile(false);

    await screen.findByRole('heading', { level: 1, name: 'UX Lead Reviewer' });
    const skills = lane(/^Skills/);
    expect(within(skills).getByRole('heading', { level: 2 })).toHaveTextContent('Skills 2');
    expect(within(skills).getByText('review')).toBeInTheDocument();
    expect(within(skills).getByText('walk')).toBeInTheDocument();
    unmount();

    mockApi({ payload: profile({ skills: [], agent: { ...profile().agent, capabilities: [] } }) });
    renderProfile(false);
    await screen.findByRole('heading', { level: 1, name: 'UX Lead Reviewer' });
    expect(screen.queryByRole('region', { name: /^Skills/ })).toBeNull();
    // Memory always draws, and the interest/tone chips are gone from the header.
    expect(lane(/^Memory/)).toBeInTheDocument();
  });
});
