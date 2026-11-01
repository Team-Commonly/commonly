/* eslint-disable react/display-name */
import React from 'react';
import {
  fireEvent, render, screen, waitFor, within,
} from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import V2Inspector, { INSPECTOR_OPEN_KEY, threadRowsFrom } from '../components/V2Inspector';
import V2Avatar from '../components/V2Avatar';

const mockNavigate = jest.fn();
const mockGet = jest.fn();
const mockPatch = jest.fn();

jest.mock('react-router-dom', () => {
  const actual = jest.requireActual('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

jest.mock('../hooks/useV2Api', () => ({
  useV2Api: () => ({ get: mockGet, patch: mockPatch }),
}));

const detail = {
  pod: { _id: 'pod-1', name: 'Sharpen', type: 'team' },
  members: [],
  agents: [
    { agentName: 'wren', userId: 'wren-user-id', instanceId: 'default', displayName: 'Wren', status: 'working' },
    { agentName: 'kai', instanceId: 'default', displayName: 'Kai' },
  ],
  messages: [], loading: false, error: null, sendError: null,
  hasMore: false, loadingOlder: false, loadOlder: jest.fn(), refresh: jest.fn(), sendMessage: jest.fn(),
};

const renderInspector = (props: Partial<React.ComponentProps<typeof V2Inspector>> = {}) => render(
  <MemoryRouter>
    <V2Inspector
      detail={detail as any}
      attentionCount={1}
      attentionItems={[{
        id: 'decision-1', kind: 'decision', title: 'Slack default mode', actorName: 'Wren', podId: 'pod-1', messageId: 'message-7',
      }]}
      onOpenInvite={jest.fn()}
      {...props}
    />
  </MemoryRouter>,
);

describe('V2Inspector', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Most cases read a group's content, so they start with every group open.
    // The fold itself is covered by the 'D215 panel fold' cases below.
    sessionStorage.setItem(INSPECTOR_OPEN_KEY, JSON.stringify(['needs-you', 'agents', 'files', 'join']));
    mockPatch.mockResolvedValue({ id: 'pod-1', joinPolicy: 'invite-only' });
    mockGet.mockImplementation((url: string) => {
      if (url === '/api/v1/tasks/pod-1') {
        return Promise.resolve({ tasks: [
          { taskId: 'TASK-131', title: 'Build the card', status: 'in_progress', assignee: 'kai' },
          { taskId: 'TASK-132', title: 'Verify the card', status: 'pending' },
          { taskId: 'TASK-130', title: 'Ship the event', status: 'done' },
        ] });
      }
      if (url.startsWith('/api/artifacts?podId=pod-1')) {
        return Promise.resolve({ items: [
          { id: 'f1', fileName: 'x1.png', name: 'walk-1440.png', kind: 'image', createdAt: new Date(Date.now() - 5 * 60000).toISOString() },
          { id: 'f2', fileName: 'x2.md', name: 'plan.md', kind: 'doc', createdAt: new Date(Date.now() - 3 * 3600000).toISOString() },
        ], total: 7 });
      }
      return Promise.resolve({});
    });
  });

  test('D215 panel fold: every group is one closed row at rest and opens on demand', async () => {
    sessionStorage.removeItem(INSPECTOR_OPEN_KEY);
    renderInspector({
      currentUserId: 'owner-1',
      detail: { ...detail, pod: { ...detail.pod, createdBy: { _id: 'owner-1' }, joinPolicy: 'open' } } as any,
    });
    const folds = ['Needs you', 'Agents', 'Files', 'Who can join']
      .map((name) => screen.getByRole('button', { name: new RegExp(`^${name}`) }));
    folds.forEach((fold) => expect(fold).toHaveAttribute('aria-expanded', 'false'));
    // Counts ride the rows; the content stays out of the DOM until opened.
    expect(folds[0]).toHaveAccessibleName('Needs you 1');
    expect(folds[1]).toHaveAccessibleName('Agents 2');
    expect(await screen.findByRole('button', { name: 'Files 7' })).toBeInTheDocument();
    expect(screen.queryByText('Slack default mode')).not.toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: 'Invite-only' })).not.toBeInTheDocument();

    fireEvent.click(folds[3]);
    expect(folds[3]).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('radio', { name: 'Invite-only' })).toBeInTheDocument();
    fireEvent.click(folds[0]);
    expect(await screen.findByText('Slack default mode')).toBeInTheDocument();
    expect(JSON.parse(sessionStorage.getItem(INSPECTOR_OPEN_KEY) || '[]')).toEqual(['join', 'needs-you']);
    fireEvent.click(folds[0]);
    expect(screen.queryByText('Slack default mode')).not.toBeInTheDocument();
  });

  test('section titles carry no mono captions', () => {
    renderInspector();
    expect(screen.queryByText(/agents in/)).not.toBeInTheDocument();
    expect(screen.queryByText(/files in/)).not.toBeInTheDocument();
    expect(screen.queryByText('pod settings')).not.toBeInTheDocument();
  });

  test('members and manage are icon buttons in the panel head', () => {
    const onOpenInvite = jest.fn();
    renderInspector({ onOpenInvite });
    const members = screen.getByRole('button', { name: 'Members' });
    const manage = screen.getByRole('button', { name: 'Manage agents' });
    expect(members).toHaveAttribute('title', 'Members');
    expect(manage).toHaveAttribute('title', 'Manage agents');
    expect(members.querySelector('svg')).toBeTruthy();
    expect(members.closest('.v2-workspace-inspector__head')).toBeTruthy();
    expect(document.querySelector('.v2-workspace-inspector__foot')).toBeNull();
  });

  test('Who can join is a segment that calls the same join-policy API the radios did', async () => {
    const refresh = jest.fn().mockResolvedValue(undefined);
    renderInspector({
      currentUserId: 'owner-1',
      detail: { ...detail, pod: { ...detail.pod, createdBy: { _id: 'owner-1' }, joinPolicy: 'invite-only' }, refresh } as any,
    });
    const group = screen.getByRole('radiogroup', { name: 'Who can join' });
    expect(group).toHaveClass('v2-seg');
    const open = screen.getByRole('radio', { name: 'Open to join' });
    expect(open).toHaveTextContent('Open');
    expect(screen.getByRole('radio', { name: 'Invite-only' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(open);
    await waitFor(() => expect(mockPatch).toHaveBeenCalledWith('/api/pods/pod-1/join-policy', { joinPolicy: 'open' }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(screen.getByRole('radio', { name: 'Open to join' })).toHaveAttribute('aria-checked', 'true');
  });

  test('owner can make an open pod invite-only in pod settings', async () => {
    const refresh = jest.fn().mockResolvedValue(undefined);
    renderInspector({
      currentUserId: 'owner-1',
      detail: { ...detail, pod: { ...detail.pod, createdBy: { _id: 'owner-1' }, joinPolicy: 'open' }, refresh } as any,
    });
    fireEvent.click(screen.getByRole('radio', { name: 'Invite-only' }));
    await waitFor(() => expect(mockPatch).toHaveBeenCalledWith('/api/pods/pod-1/join-policy', { joinPolicy: 'invite-only' }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  test('pod settings list Open to join before Invite-only', () => {
    renderInspector({
      currentUserId: 'owner-1',
      detail: { ...detail, pod: { ...detail.pod, createdBy: { _id: 'owner-1' }, joinPolicy: 'open' } } as any,
    });
    const join = screen.getByRole('radiogroup', { name: 'Who can join' });
    expect(within(join).getAllByRole('radio').map((radio) => radio.getAttribute('aria-label') || radio.textContent)).toEqual([
      'Open to join',
      'Invite-only',
    ]);
  });

  test('the head switches between the pod and its threads, newest activity first (D215, TASK-734)', () => {
    const messages = [
      { id: '10', content: 'Older root', created_at: '2026-10-31T01:00:00Z', user: { username: 'ada' }, thread_root_id: null },
      { id: '11', content: 'reply', created_at: '2026-10-31T01:05:00Z', user: { username: 'bo' }, thread_root_id: 10 },
      { id: '20', content: 'Newer   root\nsecond line', created_at: '2026-10-31T02:00:00Z', user: { username: 'cy' }, thread_root_id: null },
      { id: '21', content: 'reply', created_at: '2026-10-31T02:10:00Z', user: { username: 'ada' }, thread_root_id: '20' },
      // A reply whose root is outside the loaded window has no text to show.
      { id: '31', content: 'orphan', created_at: '2026-10-31T03:00:00Z', user: { username: 'ada' }, thread_root_id: 30 },
    ];
    expect(threadRowsFrom(messages as any).map((row) => [row.rootId, row.author, row.snippet])).toEqual([
      ['20', 'cy', 'Newer root second line'],
      ['10', 'ada', 'Older root'],
    ]);

    renderInspector({ detail: { ...detail, messages } as any });
    expect(screen.getByRole('heading', { name: /Needs you/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: 'Threads' }));
    expect(screen.queryByRole('heading', { name: /Needs you/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^cy/ }));
    expect(mockNavigate).toHaveBeenCalledWith('/v2/pods/pod-1#message-20');
  });

  test('the threads view says so when the pod has none', () => {
    renderInspector();
    fireEvent.click(screen.getByRole('radio', { name: 'Threads' }));
    expect(screen.getByText('No threads yet.')).toBeInTheDocument();
  });

  test('the open panel carries its own Hide panel key', () => {
    const onClose = jest.fn();
    renderInspector({ onClose });
    fireEvent.click(screen.getByRole('button', { name: 'Hide panel' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test('non-owner cannot see the join-policy controls', () => {
    renderInspector({
      currentUserId: 'another-user',
      detail: { ...detail, pod: { ...detail.pod, createdBy: { _id: 'owner-1' }, joinPolicy: 'open' } } as any,
    });
    expect(screen.queryByRole('radio', { name: 'Invite-only' })).not.toBeInTheDocument();
  });

  test('renders the files pane from the same artifacts query with podId fixed, and links to all of them', async () => {
    renderInspector();
    expect(await screen.findByRole('heading', { name: 'Files 7' })).toBeInTheDocument();
    const row = await screen.findByRole('button', { name: 'walk-1440.png 5m' });
    expect(row).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'plan.md 3h' })).toBeInTheDocument();
    expect(mockGet).toHaveBeenCalledWith('/api/artifacts?podId=pod-1&limit=5');
    fireEvent.click(screen.getByRole('button', { name: 'All 7 files' }));
    expect(mockNavigate).toHaveBeenCalledWith('/v2/artifacts?podId=pod-1');
    // A file row opens the file: an image in the lightbox, not a name search.
    fireEvent.click(row);
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(mockNavigate).not.toHaveBeenCalledWith(expect.stringContaining('q=walk-1440.png'));
  });

  test('says no files yet when the pod has none', async () => {
    mockGet.mockImplementation((url: string) => Promise.resolve(url.startsWith('/api/artifacts') ? { items: [], total: 0 } : {}));
    renderInspector();
    expect(await screen.findByText('no files yet')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /All \d+ files/ })).not.toBeInTheDocument();
  });

  test('renders the same generated agent face as chat', async () => {
    renderInspector();
    await screen.findByText('Slack default mode');
    render(<V2Avatar name="Wren in chat" kind="agent" seed="wren-user-id" tone="flat" />);
    expect(screen.getByRole('img', { name: 'Wren' })).toHaveAttribute(
      'src', screen.getByRole('img', { name: 'Wren in chat' }).getAttribute('src'),
    );
  });

  test('renders the two artboard cards from the pod’s existing data', async () => {
    renderInspector();

    expect(screen.getByRole('heading', { name: 'Agents 2' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Needs you 1' })).toBeInTheDocument();
    // board · today left the inspector (ruling 66311): the board has its own tab.
    expect(screen.queryByRole('heading', { name: 'board · today' })).not.toBeInTheDocument();
    expect(await screen.findByText('Slack default mode')).toBeInTheDocument();
    expect(screen.getByText('needs you · Slack default mode')).toBeInTheDocument();
    expect(screen.getByText('working · Build the card')).toBeInTheDocument();
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
  });

  test('uses the resolved agent label while matching attention under an old profile ID', () => {
    renderInspector({ detail: { ...detail, agents: [{
      agentName: 'scout', instanceId: 'default', displayName: 'Scout',
      profile: { displayName: 'u1a9e5ecede' },
    }] } as any, attentionItems: [{
      id: 'legacy-request', kind: 'decision', title: 'Legacy request',
      actorName: 'u1a9e5ecede', podId: 'pod-1',
    }] });

    expect(screen.getAllByText('Scout')).toHaveLength(2);
    expect(screen.getByRole('button', { name: /Scout needs you · Legacy request/ })).toBeInTheDocument();
    expect(screen.queryByText('u1a9e5ecede')).not.toBeInTheDocument();
  });

  test('labels a per-user agent by its resolved name, never its instance id or agentName', () => {
    renderInspector({ detail: { ...detail, agents: [{
      agentName: 'scout', instanceId: 'ubd1004e0d7', displayName: 'Scout',
    }] } as any, attentionCount: 0, attentionItems: [] });

    expect(screen.getByRole('button', { name: /Scout idle/ })).toBeInTheDocument();
    expect(screen.queryByText('ubd1004e0d7')).not.toBeInTheDocument();
    expect(screen.queryByText('scout')).not.toBeInTheDocument();
  });

  test('labels an agent with no roster name generically, never by its runtime name', () => {
    renderInspector({ detail: { ...detail, agents: [{
      agentName: 'openclaw', instanceId: 'pixel',
    }] } as any, attentionCount: 0, attentionItems: [] });

    expect(screen.getByRole('button', { name: /Agent idle/ })).toBeInTheDocument();
    expect(screen.queryByText('openclaw')).not.toBeInTheDocument();
  });

  test('names a working agent with no roster name generically, never with an empty label', async () => {
    mockGet.mockResolvedValue({ tasks: [] });
    renderInspector({ detail: { ...detail, agents: [{
      agentName: 'openclaw', instanceId: 'pixel', status: 'working',
    }] } as any, attentionCount: 0, attentionItems: [] });

    expect(await screen.findByText('Nothing. Agent is working.')).toBeInTheDocument();
    expect(screen.queryByText(/openclaw/)).not.toBeInTheDocument();
  });

  test('does not assign anonymous attention to an agent without a profile name', () => {
    renderInspector({ detail: { ...detail, agents: [{
      agentName: 'scout', instanceId: 'default', displayName: 'Scout',
    }] } as any, attentionItems: [{
      id: 'human-question', kind: 'decision', title: 'Human question', podId: 'pod-1',
    }] });

    expect(screen.getByText('Human question')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Scout idle/ })).toBeInTheDocument();
  });

  test('names an attention item by the agent it matches, never by its agentName or instance id', () => {
    renderInspector({ detail: { ...detail, agents: [{
      agentName: 'scout', instanceId: 'ubd1004e0d7', displayName: 'Scout',
    }] } as any, attentionItems: [{
      id: 'scout-request', kind: 'decision', title: 'Scout request',
      actorName: 'scout', podId: 'pod-1',
    }] });

    expect(document.querySelector('.v2-workspace-inspector__actor')?.textContent).toBe('Scout');
    expect(screen.queryByText('scout')).not.toBeInTheDocument();
    expect(screen.queryByText('ubd1004e0d7')).not.toBeInTheDocument();
  });

  test('names an unmatched attention actor generically, never by its raw id', () => {
    renderInspector({ detail: { ...detail, agents: [{
      agentName: 'scout', instanceId: 'ubd1004e0d7', displayName: 'Scout',
    }] } as any, attentionItems: [{
      id: 'orphan-request', kind: 'decision', title: 'Orphan request',
      actorName: 'u1a9e5ecede', podId: 'pod-1',
    }] });

    expect(document.querySelector('.v2-workspace-inspector__actor')?.textContent).toBe('Agent');
    expect(screen.queryByText('u1a9e5ecede')).not.toBeInTheDocument();
  });

  test('labels an agent whose profile name is only its agentName generically', () => {
    renderInspector({ detail: { ...detail, agents: [{
      agentName: 'scout', instanceId: 'ubd1004e0d7', profile: { displayName: 'scout' },
    }] } as any, attentionCount: 0, attentionItems: [] });

    expect(screen.getByRole('button', { name: /Agent idle/ })).toBeInTheDocument();
    expect(screen.queryByText('scout')).not.toBeInTheDocument();
  });

  test('does not assign an unowned active task to an agent without a profile name', async () => {
    mockGet.mockImplementation((url: string) => Promise.resolve(url === '/api/v1/tasks/pod-1'
      ? { tasks: [{ taskId: 'TASK-1', title: 'Unowned work', status: 'claimed' }] }
      : { items: [], total: 0 }));
    renderInspector({ detail: { ...detail, agents: [{
      agentName: 'scout', instanceId: 'default', displayName: 'Scout',
    }] } as any, attentionCount: 0, attentionItems: [] });

    await screen.findByText('no files yet');
    expect(screen.getByRole('button', { name: /Scout idle/ })).toBeInTheDocument();
  });

  test('the agents label is a word and a count, never the room name', () => {
    renderInspector({ detail: { ...detail, pod: { ...detail.pod, name: 'Sharpen · decision loop' } } as any });

    expect(screen.getByRole('heading', { name: 'Agents 2' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /decision loop|sharpen/i })).not.toBeInTheDocument();
  });

  test('links attention, profile, invite, and manage exits without legacy tabs', async () => {
    const onOpenInvite = jest.fn();
    renderInspector({ onOpenInvite });

    fireEvent.click(await screen.findByRole('button', { name: 'Slack default mode Wren' }));
    expect(mockNavigate).toHaveBeenCalledWith('/v2/pods/pod-1#message-message-7');

    fireEvent.click(screen.getByRole('button', { name: /Wren needs you/ }));
    expect(mockNavigate).toHaveBeenCalledWith('/v2/agent/wren/default');

    fireEvent.click(screen.getByRole('button', { name: 'Members' }));
    expect(onOpenInvite).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Manage agents' }));
    expect(mockNavigate).toHaveBeenCalledWith('/v2/agents');
  });

  test('does not render a stale attention item from another pod', async () => {
    mockGet.mockResolvedValue({ tasks: [] });
    renderInspector({ attentionCount: 0, attentionItems: [{ id: 'other', kind: 'decision', title: 'Other pod', podId: 'pod-2' }] });
    await waitFor(() => expect(screen.getByText('Nothing. Wren is working.')).toBeInTheDocument());
    expect(screen.queryByText('Other pod')).not.toBeInTheDocument();
  });

  test('uses the settled-workspace empty copy when no agent is working', async () => {
    mockGet.mockImplementation(() => Promise.resolve({ items: [], tasks: [] }));
    renderInspector({ detail: { ...detail, agents: [] } as any, attentionCount: 0, attentionItems: [] });

    expect(await screen.findByText('Nothing open.')).toBeInTheDocument();
  });

  test('does not claim nothing open when this pod falls outside the display cap', async () => {
    renderInspector({ attentionCount: 83, attentionItems: [] });
    fireEvent.click(await screen.findByRole('button', { name: '83 waiting on you' }));
    expect(mockNavigate).toHaveBeenCalledWith('/v2/activity');
    expect(screen.queryByText(/Nothing/)).not.toBeInTheDocument();
  });
});
