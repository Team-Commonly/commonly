// @ts-nocheck
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import axios from 'axios';
import i18n, { i18nReady } from '../../i18n';
import V2ActivityPage from '../components/V2ActivityPage';
import { FIRST_RUN_REOPEN_EVENT } from '../firstRunGuide';

jest.mock('axios');
jest.mock('../components/V2Avatar', () => {
  const MockV2Avatar = ({ name }: { name: string }) => <span>{name} avatar</span>;
  MockV2Avatar.displayName = 'MockV2Avatar';
  return MockV2Avatar;
});

const mockGet = axios.get as jest.Mock;
const mockPost = axios.post as jest.Mock;
const CurrentPath = () => {
  const location = useLocation();
  return <div data-testid="current-path">{location.pathname}{location.search}</div>;
};

// The queue now arrives from /decision-queue (TASK-083) — recap.needsYou is
// only the degrade path when that endpoint fails.
const decisionQueue = {
  items: [
    {
      id: 'mention-1', kind: 'mention', title: 'Review requested', detail: 'A direct mention.',
      podId: 'pod-1', podName: 'Launch pod', createdAt: '2026-08-26T11:00:00.000Z',
    },
    {
      id: 'task_TASK-059', kind: 'press', title: 'Retention ledger', detail: '#1208 held for the human merge press.',
      podId: 'pod-1', podName: 'Launch pod', taskId: 'TASK-059', createdAt: '2026-08-26T10:00:00.000Z',
    },
    {
      id: 'task_TASK-024', kind: 'decision', title: 'DECIDE: eslint scope', detail: 'filed',
      podId: 'pod-1', podName: 'Launch pod', taskId: 'TASK-024', createdAt: '2026-08-26T09:00:00.000Z',
    },
  ],
  count: 3,
};

const recap = {
  pods: [{ id: 'pod-1', name: 'Launch pod' }],
  needsYou: [{
    id: 'mention-1', kind: 'mention', title: 'Review requested', detail: 'A direct mention.',
    podId: 'pod-1', podName: 'Launch pod', timestamp: '2026-08-26T11:00:00.000Z',
  }],
  agents: [{
    id: 'agent-1', name: 'release-agent', lastActiveAt: '2026-08-26T11:00:00.000Z',
    messageCount: 2, recap: 'Posted two updates.', updates: [{
      id: 'update-1', podId: 'pod-1', podName: 'Launch pod', content: 'Checks passed.',
      timestamp: '2026-08-26T11:00:00.000Z',
    }],
  }],
  board: [{
    id: 'board-1', taskId: 'TASK-068', title: 'Activity tab', status: 'claimed',
    podId: 'pod-1', podName: 'Launch pod', updatedAt: '2026-08-26T11:00:00.000Z',
    lastUpdate: { author: 'release-agent', text: 'Implementation began.', createdAt: '2026-08-26T11:00:00.000Z' },
  }],
};

const renderPage = () => render(
  <MemoryRouter initialEntries={['/v2/activity']}>
    <V2ActivityPage />
    <CurrentPath />
  </MemoryRouter>,
);

describe('V2ActivityPage', () => {
  beforeAll(async () => { await i18nReady; });

  beforeEach(async () => {
    jest.clearAllMocks();
    // Default: the decision-queue endpoint FAILS, exercising the designed
    // degrade path (fall back to recap.needsYou) — which also keeps the
    // pre-existing tests' order-based mockResolvedValueOnce chains valid,
    // since their Once values feed the recap call and this implementation
    // catches the queue call. The first test overrides with real items.
    mockGet.mockImplementation((url: string) => {
      if (url === '/api/activity/decision-queue') return Promise.reject(new Error('queue down'));
      return Promise.resolve({ data: recap });
    });
    await act(async () => { await i18n.changeLanguage('en'); });
  });

  test('projects existing activity, direct interrupts, and board changes without inventing a queue count', async () => {
    mockGet.mockImplementation((url: string) => {
      if (url === '/api/activity/decision-queue') return Promise.resolve({ data: decisionQueue });
      return Promise.resolve({ data: recap });
    });
    renderPage();

    expect(await screen.findByRole('heading', { name: 'Activity' })).toBeInTheDocument();
    // findBy, not getBy: the header renders unconditionally, so awaiting it
    // proves nothing about data arrival — and the queue+recap Promise.all
    // adds a microtask hop the old single-request race happened to win.
    expect(await screen.findByRole('heading', { name: 'Needs you' })).toBeInTheDocument();
    expect(screen.getByText('Review requested')).toBeInTheDocument();
    // TASK-083: board facts land in the queue — a human-press handoff and a
    // DECIDE row, each with an Open board action.
    expect(screen.getByText('Retention ledger')).toBeInTheDocument();
    expect(screen.getByText('Ready for your press')).toBeInTheDocument();
    expect(screen.getByText('DECIDE: eslint scope')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Open board' })).toHaveLength(2);
    expect(mockGet).toHaveBeenCalledWith('/api/activity/decision-queue', expect.anything());
    expect(screen.getByRole('heading', { name: 'What your agents did' })).toBeInTheDocument();
    expect(screen.getByText('release-agent')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Board' })).toBeInTheDocument();
    expect(screen.getByText('TASK-068')).toBeInTheDocument();
    expect(mockGet).toHaveBeenCalledWith('/api/activity/recap', expect.objectContaining({
      params: { window: 'today' },
    }));
  });

  test('changes the read window and opens the source pod from a factual queue row', async () => {
    renderPage();
    await screen.findByText('Review requested');

    fireEvent.click(screen.getByRole('button', { name: '7 days' }));
    // toHaveBeenCalledWith, not Last: the decision-queue request now fires
    // alongside recap, so "last call" is no longer the recap by construction.
    await waitFor(() => expect(mockGet).toHaveBeenCalledWith('/api/activity/recap', expect.objectContaining({
      params: { window: '7d' },
    })));

    // findAll: the window change reloads both requests and the rows remount.
    fireEvent.click((await screen.findAllByRole('button', { name: 'Open thread' }))[0]);
    expect(screen.getByTestId('current-path')).toHaveTextContent('/v2/pods/pod-1');
  });

  test('acknowledges a mention explicitly instead of treating a feed read as acknowledgement', async () => {
    mockGet
      .mockResolvedValueOnce({ data: recap })
      .mockResolvedValue({ data: { ...recap, needsYou: [] } });
    mockPost.mockResolvedValue({ data: { success: true } });
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Acknowledge' }));
    await waitFor(() => expect(mockPost).toHaveBeenCalledWith(
      '/api/activity/mention-1/acknowledge',
      {},
      expect.objectContaining({ headers: expect.any(Object) }),
    ));
    expect(await screen.findByText('Nothing is waiting on you')).toBeInTheDocument();
  });

  test('keeps an empty Needs you state honest', async () => {
    mockGet.mockResolvedValue({ data: { ...recap, needsYou: [] } });
    renderPage();

    expect(await screen.findByText('Nothing is waiting on you')).toBeInTheDocument();
    expect(screen.queryByText(/0 needs you/i)).not.toBeInTheDocument();
  });

  test('turns a truly empty workspace into the three factual onboarding rows', async () => {
    mockGet.mockResolvedValue({ data: { ...recap, needsYou: [], agents: [], board: [] } });
    const onGuide = jest.fn();
    window.addEventListener(FIRST_RUN_REOPEN_EVENT, onGuide);
    renderPage();

    expect(await screen.findByRole('button', { name: 'Meet your Guide' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Hire your first agent' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create a task' })).toBeInTheDocument();
    expect(screen.queryByText('Nothing is waiting on you')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Meet your Guide' }));
    expect(onGuide).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Create a task' }));
    expect(screen.getByTestId('current-path')).toHaveTextContent('/v2/pods/pod-1/board?createTask=1');
    window.removeEventListener(FIRST_RUN_REOPEN_EVENT, onGuide);
  });

  test('keeps an approval actionable and refreshes the fact after approval', async () => {
    const approvalRecap = {
      ...recap,
      needsYou: [{
        id: 'approval-1', kind: 'approval', title: 'Approval requested', detail: 'Deploy the change.',
        podId: 'pod-1', podName: 'Launch pod', timestamp: '2026-08-26T11:00:00.000Z',
      }],
    };
    mockGet
      .mockResolvedValueOnce({ data: approvalRecap })
      .mockResolvedValue({ data: { ...approvalRecap, needsYou: [] } });
    mockPost.mockResolvedValue({ data: { success: true } });
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(mockPost).toHaveBeenCalledWith(
      '/api/activity/approval-1/approve',
      { notes: 'Approved via Activity' },
      expect.objectContaining({ headers: expect.any(Object) }),
    ));
    expect(await screen.findByText('Nothing is waiting on you')).toBeInTheDocument();
  });

  test('offers Reject as the approval secondary action', async () => {
    const approvalRecap = {
      ...recap,
      needsYou: [{
        id: 'approval-2', kind: 'approval', title: 'Approval requested', detail: 'Deploy the change.',
        podId: 'pod-1', podName: 'Launch pod', timestamp: '2026-08-26T11:00:00.000Z',
      }],
    };
    mockGet.mockResolvedValue({ data: approvalRecap });
    mockPost.mockResolvedValue({ data: { success: true } });
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Reject' }));
    await waitFor(() => expect(mockPost).toHaveBeenCalledWith(
      '/api/activity/approval-2/reject',
      { notes: 'Rejected via Activity' },
      expect.objectContaining({ headers: expect.any(Object) }),
    ));
  });
});
