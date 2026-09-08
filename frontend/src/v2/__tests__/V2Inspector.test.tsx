/* eslint-disable react/display-name */
import React from 'react';
import {
  fireEvent, render, screen, waitFor,
} from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import V2Inspector from '../components/V2Inspector';

const mockNavigate = jest.fn();
const mockGet = jest.fn();

jest.mock('react-router-dom', () => {
  const actual = jest.requireActual('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

jest.mock('../hooks/useV2Api', () => ({
  useV2Api: () => ({ get: mockGet }),
}));

jest.mock('../components/V2Avatar', () => ({ name }: { name: string }) => <span data-testid="avatar">{name}</span>);

const detail = {
  pod: { _id: 'pod-1', name: 'Sharpen', type: 'team' },
  members: [],
  agents: [
    { agentName: 'wren', instanceId: 'default', displayName: 'Wren', status: 'working' },
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

  test('renders the files pane from the same artifacts query with podId fixed, and links to all of them', async () => {
    renderInspector();
    expect(screen.getByRole('heading', { name: 'files in sharpen' })).toBeInTheDocument();
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

  test('renders the three artboard cards from the pod’s existing data', async () => {
    renderInspector();

    expect(screen.getByRole('heading', { name: 'agents in sharpen' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'needs you' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'board · today' })).toBeInTheDocument();
    expect(await screen.findByText('Slack default mode')).toBeInTheDocument();
    expect(screen.getByText('1 open · 1 in progress · 1 done')).toBeInTheDocument();
    expect(screen.getByText('needs you · Slack default mode')).toBeInTheDocument();
    expect(screen.getByText('working · Build the card')).toBeInTheDocument();
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
  });

  test('uses the short lowercase room name in the single-line agents label', () => {
    renderInspector({ detail: { ...detail, pod: { ...detail.pod, name: 'Sharpen · decision loop' } } as any });

    expect(screen.getByRole('heading', { name: 'agents in sharpen' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /decision loop/i })).not.toBeInTheDocument();
  });

  test('links attention, board, profile, invite, and manage exits without legacy tabs', async () => {
    const onOpenInvite = jest.fn();
    renderInspector({ onOpenInvite });

    fireEvent.click(await screen.findByRole('button', { name: 'Slack default mode Wren' }));
    expect(mockNavigate).toHaveBeenCalledWith('/v2/pods/pod-1#message-message-7');

    fireEvent.click(screen.getByRole('button', { name: '1 open · 1 in progress · 1 done' }));
    expect(mockNavigate).toHaveBeenCalledWith('/v2/pods/pod-1/board');

    fireEvent.click(screen.getByRole('button', { name: /Wren needs you/ }));
    expect(mockNavigate).toHaveBeenCalledWith('/v2/agent/wren/default');

    fireEvent.click(screen.getByRole('button', { name: 'members' }));
    expect(onOpenInvite).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'manage' }));
    expect(mockNavigate).toHaveBeenCalledWith('/v2/agents/manage?podId=pod-1');
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
