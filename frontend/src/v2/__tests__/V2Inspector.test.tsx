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
      return Promise.resolve({});
    });
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
    renderInspector({ attentionItems: [{ id: 'other', kind: 'decision', title: 'Other pod', podId: 'pod-2' }] });
    await waitFor(() => expect(screen.getByText('Nothing. Wren is working.')).toBeInTheDocument());
    expect(screen.queryByText('Other pod')).not.toBeInTheDocument();
  });

  test('uses the settled-workspace empty copy when no agent is working', async () => {
    mockGet.mockImplementation(() => Promise.resolve({ items: [], tasks: [] }));
    renderInspector({ detail: { ...detail, agents: [] } as any });

    expect(await screen.findByText('Nothing open.')).toBeInTheDocument();
  });
});
