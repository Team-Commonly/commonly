// @ts-nocheck
import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import axios from 'axios';
import i18n, { i18nReady } from '../../i18n';
import V2ActivityPage from '../components/V2ActivityPage';
import { FIRST_RUN_REOPEN_EVENT } from '../firstRunGuide';
import { ATTENTION_CHANGED } from '../hooks/useV2PodAttention';

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
  return <div data-testid="current-path">{location.pathname}{location.search}{location.hash}</div>;
};

// Only the queue endpoint supplies attention; recap is not a fallback.
const decisionQueue = {
  items: [
    {
      id: 'mention-1', attentionItemId: 'attention-1', kind: 'mention', title: 'Review requested', detail: 'A direct mention.',
      podId: 'pod-1', podName: 'Launch pod', messageId: '699', threadRootId: '695', createdAt: '2026-08-26T11:00:00.000Z',
    },
    {
      id: 'decision-024', kind: 'decision', title: 'Choose the eslint scope', detail: 'What should the agent do?',
      podId: 'pod-1', podName: 'Launch pod', messageId: '700', threadRootId: '695', options: [
        { label: 'Ship now', description: 'Release the bounded change.', recommended: true },
        { label: 'Hold for review', description: 'Wait for a second pass.' },
      ], createdAt: '2026-08-26T09:00:00.000Z',
    },
  ],
  count: 2,
  countsByPod: { 'pod-1': 2 },
  composePodId: 'pod-1',
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
    sessionStorage.removeItem('v2:activity:snapshot');
    mockGet.mockImplementation((url: string) => {
      if (url === '/api/activity/decision-queue') return Promise.resolve({ data: decisionQueue });
      return Promise.resolve({ data: recap });
    });
    await act(async () => { await i18n.changeLanguage('en'); });
  });

  test('projects the needs-you queue and moved-forward groups without inventing a count', async () => {
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
    // Queue rows are only durable source facts; task handoff prose never
    // creates a card. DecisionRequest cards use declared alternatives.
    expect(screen.getByText('Choose the eslint scope')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Rule: Ship now' })).toBeInTheDocument();
    expect(screen.getByText('Release the bounded change.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Other…' })).toBeInTheDocument();
    expect(mockGet).toHaveBeenCalledWith('/api/activity/decision-queue', expect.anything());
    expect(screen.getByRole('heading', { name: 'Moved forward' })).toBeInTheDocument();
    expect(screen.getAllByText('release-agent').length).toBeGreaterThan(0);
    expect(screen.getByText('Checks passed.')).toBeInTheDocument();
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
    fireEvent.click((await screen.findAllByRole('button', { name: 'Open' }))[0]);
    expect(screen.getByTestId('current-path')).toHaveTextContent('/v2/pods/pod-1#message-699');
  });

  test('marks a mention handled explicitly instead of treating a feed read as acknowledgement', async () => {
    let reads = 0;
    mockGet.mockImplementation((url: string) => Promise.resolve({ data: url === '/api/activity/decision-queue'
      ? (++reads === 1 ? { ...decisionQueue, items: [decisionQueue.items[0]], count: 1 } : { items: [], count: 0, countsByPod: {} })
      : recap }));
    mockPost.mockResolvedValue({ data: { success: true } });
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Mark handled' }));
    await waitFor(() => expect(mockPost).toHaveBeenCalledWith(
      '/api/activity/attention-1/acknowledge',
      {},
      expect.objectContaining({ headers: expect.any(Object) }),
    ));
    expect(await screen.findByText('Nothing open.')).toBeInTheDocument();
  });

  test('keeps an empty Needs you state honest', async () => {
    mockGet.mockImplementation((url: string) => Promise.resolve({ data: url === '/api/activity/decision-queue'
      ? { items: [], count: 0, countsByPod: {} } : recap }));
    renderPage();

    expect(await screen.findByText('Nothing open.')).toBeInTheDocument();
    expect(screen.queryByText(/0 needs you/i)).not.toBeInTheDocument();
  });

  test('turns a truly empty workspace into the three factual onboarding rows', async () => {
    mockGet.mockImplementation((url: string) => Promise.resolve({ data: url === '/api/activity/decision-queue'
      ? { items: [], count: 0, countsByPod: {} } : { ...recap, needsYou: [], agents: [], board: [] } }));
    const onGuide = jest.fn();
    window.addEventListener(FIRST_RUN_REOPEN_EVENT, onGuide);
    renderPage();

    expect(await screen.findByRole('button', { name: 'Meet your Guide' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Hire your first agent' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create a task' })).toBeInTheDocument();
    expect(screen.queryByText('Nothing open.')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Meet your Guide' }));
    expect(onGuide).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Create a task' }));
    expect(screen.getByTestId('current-path')).toHaveTextContent('/v2/pods/pod-1/board?createTask=1');
    window.removeEventListener(FIRST_RUN_REOPEN_EVENT, onGuide);
  });

  test('keeps an approval actionable and refreshes the fact after approval', async () => {
    const approvalQueue = {
      items: [{
        id: 'approval-1', kind: 'approval', title: 'Approval requested', detail: 'Deploy the change.',
        podId: 'pod-1', podName: 'Launch pod', createdAt: '2026-08-26T11:00:00.000Z',
      }],
      count: 1,
      composePodId: 'pod-1',
    };
    let queueReads = 0;
    mockGet.mockImplementation((url: string) => {
      if (url === '/api/activity/decision-queue') {
        queueReads += 1;
        return Promise.resolve({ data: queueReads === 1 ? approvalQueue : { items: [], count: 0, composePodId: 'pod-1' } });
      }
      return Promise.resolve({ data: { ...recap, needsYou: [] } });
    });
    mockPost.mockResolvedValue({ data: { success: true } });
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(mockPost).toHaveBeenCalledWith(
      '/api/activity/approval-1/approve',
      { notes: 'Approved via Activity' },
      expect.objectContaining({ headers: expect.any(Object) }),
    ));
    expect(await screen.findByText('Nothing open.')).toBeInTheDocument();
  });

  test('offers Reject as the approval secondary action', async () => {
    const approvalQueue = {
      items: [{
        id: 'approval-2', kind: 'approval', title: 'Approval requested', detail: 'Deploy the change.',
        podId: 'pod-1', podName: 'Launch pod', createdAt: '2026-08-26T11:00:00.000Z',
      }],
      count: 1,
      composePodId: 'pod-1',
    };
    mockGet.mockImplementation((url: string) => Promise.resolve({ data: url === '/api/activity/decision-queue' ? approvalQueue : { ...recap, needsYou: [] } }));
    mockPost.mockResolvedValue({ data: { success: true } });
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Deny' }));
    await waitFor(() => expect(mockPost).toHaveBeenCalledWith(
      '/api/activity/approval-2/reject',
      { notes: 'Rejected via Activity' },
      expect.objectContaining({ headers: expect.any(Object) }),
    ));
  });

  test('posts a one-tap decision ruling and refreshes the factual queue', async () => {
    let queueReads = 0;
    mockGet.mockImplementation((url: string) => {
      if (url === '/api/activity/decision-queue') {
        queueReads += 1;
        return Promise.resolve({ data: queueReads === 1 ? decisionQueue : { items: [], count: 0, composePodId: 'pod-1' } });
      }
      return Promise.resolve({ data: recap });
    });
    mockPost.mockResolvedValue({ data: { ok: true } });
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Rule: Ship now' }));
    await waitFor(() => expect(mockPost).toHaveBeenCalledWith(
      '/api/activity/decisions/decision-024/choose',
      { value: 'Ship now' },
      expect.objectContaining({ headers: expect.any(Object) }),
    ));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Rule: Ship now' })).not.toBeInTheDocument());
  });

  test('sends an Other ruling verbatim to the same DecisionRequest endpoint', async () => {
    mockGet.mockImplementation((url: string) => Promise.resolve({
      data: url === '/api/activity/decision-queue' ? decisionQueue : recap,
    }));
    mockPost.mockResolvedValue({ data: { ok: true } });
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Other…' }));
    const input = screen.getByRole('textbox', { name: 'Write your ruling…' });
    fireEvent.change(input, { target: { value: 'Hold for customer evidence' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send ruling' }));

    await waitFor(() => expect(mockPost).toHaveBeenCalledWith(
      '/api/activity/decisions/decision-024/choose',
      { value: 'Hold for customer evidence' },
      expect.objectContaining({ headers: expect.any(Object) }),
    ));
  });

  test('keeps a task attention row as an open-thread fact when it has no declared options', async () => {
    const taskQueue = {
      items: [{
        id: 'task-1:blocked', attentionItemId: 'attention-task-1', kind: 'decision',
        title: 'Choose a deploy shape', detail: 'Blocked on an upstream choice.',
        podId: 'pod-1', podName: 'Launch pod', options: [], createdAt: '2026-08-26T11:00:00.000Z',
      }],
      count: 1,
      composePodId: null,
    };
    mockGet.mockImplementation((url: string) => Promise.resolve({
      data: url === '/api/activity/decision-queue' ? taskQueue : { ...recap, needsYou: [] },
    }));
    renderPage();

    expect(await screen.findByText('Choose a deploy shape')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Other…' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Rule:/ })).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Open pod' })).not.toHaveLength(0);
  });

  test('opens an inline reply and posts it into the source thread', async () => {
    mockPost.mockResolvedValue({ data: { id: 123 } });
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Reply' }));
    const composer = await screen.findByRole('textbox', { name: 'Reply in thread…' });
    fireEvent.change(composer, { target: { value: 'please check this' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(mockPost).toHaveBeenCalledWith(
      '/api/messages/pod-1',
      { content: 'please check this', threadRootId: '695', replyToMessageId: '699' },
      expect.objectContaining({ headers: expect.any(Object) }),
    ));
    expect(composer).toHaveValue('');
  });

  test('renders the uncapped count, not the displayed card count', async () => {
    mockGet.mockImplementation((url: string) => Promise.resolve({ data: url === '/api/activity/decision-queue'
      ? { ...decisionQueue, count: 91, countsByPod: { 'pod-1': 91 } } : recap }));
    renderPage();
    expect(await screen.findByLabelText('91 waiting on you')).toHaveTextContent('91');
  });

  test('appends the next server page without losing the existing rows', async () => {
    const firstPage = Array.from({ length: 50 }, (_, index) => ({
      id: `mention-${index}`, attentionItemId: `attention-${index}`, kind: 'mention', title: `Mention ${index}`, detail: 'Needs a reply.',
      podId: 'pod-1', podName: 'Launch pod', createdAt: `2026-08-26T11:${String(index).padStart(2, '0')}:00.000Z`,
    }));
    const secondPage = Array.from({ length: 6 }, (_, index) => ({
      id: `mention-${index + 50}`, attentionItemId: `attention-${index + 50}`, kind: 'mention', title: `Mention ${index + 50}`, detail: 'Needs a reply.',
      podId: 'pod-1', podName: 'Launch pod', createdAt: `2026-08-26T10:${String(index).padStart(2, '0')}:00.000Z`,
    }));
    mockGet.mockImplementation((url: string, config: any) => {
      if (url === '/api/activity/decision-queue') {
        return Promise.resolve({ data: {
          items: config?.params?.offset === 50 ? secondPage : firstPage,
          count: 56,
          remaining: config?.params?.offset === 50 ? 0 : 6,
          hasMore: config?.params?.offset !== 50,
          countsByPod: { 'pod-1': 56 },
          composePodId: 'pod-1',
        } });
      }
      return Promise.resolve({ data: recap });
    });
    renderPage();

    expect(await screen.findByText('Mention 0')).toBeInTheDocument();
    const more = await screen.findByRole('button', { name: 'Show more · 6 remaining' });
    fireEvent.click(more);
    expect(await screen.findByText('Mention 55')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Show more · 6 remaining' })).not.toBeInTheDocument();
    expect(mockGet).toHaveBeenCalledWith('/api/activity/decision-queue', expect.objectContaining({
      params: expect.objectContaining({ limit: 50, offset: 50 }),
    }));
  });

  test('discards a late page after a same-scope refresh resets the queue', async () => {
    const firstPage = Array.from({ length: 50 }, (_, index) => ({
      id: `refresh-${index}`, attentionItemId: `refresh-attention-${index}`, kind: 'mention', title: `Refresh ${index}`, detail: 'First page.',
      podId: 'pod-1', podName: 'Launch pod', createdAt: '2026-08-26T11:00:00.000Z',
    }));
    const refreshedPage = [{
      id: 'refreshed-row', attentionItemId: 'refreshed-attention', kind: 'mention', title: 'Refreshed row', detail: 'New first page.',
      podId: 'pod-1', podName: 'Launch pod', createdAt: '2026-08-26T12:00:00.000Z',
    }];
    const stalePage = [{
      id: 'stale-row', attentionItemId: 'stale-attention', kind: 'mention', title: 'Stale page row', detail: 'Old page.',
      podId: 'pod-1', podName: 'Launch pod', createdAt: '2026-08-26T10:00:00.000Z',
    }];
    let queueReads = 0;
    let resolveMore: ((value: any) => void) | null = null;
    mockGet.mockImplementation((url: string, config: any) => {
      if (url !== '/api/activity/decision-queue') return Promise.resolve({ data: recap });
      if (config?.params?.offset === 50) {
        return new Promise((resolve) => { resolveMore = resolve; });
      }
      queueReads += 1;
      return Promise.resolve({ data: queueReads === 1
        ? { items: firstPage, count: 51, remaining: 1, countsByPod: { 'pod-1': 51 } }
        : { items: refreshedPage, count: 1, remaining: 0, countsByPod: { 'pod-1': 1 } } });
    });
    renderPage();
    await screen.findByText('Refresh 0');
    fireEvent.click(await screen.findByRole('button', { name: 'Show more · 1 remaining' }));
    await waitFor(() => expect(resolveMore).not.toBeNull());

    await act(async () => { window.dispatchEvent(new Event(ATTENTION_CHANGED)); });
    expect(await screen.findByText('Refreshed row')).toBeInTheDocument();
    await act(async () => { resolveMore?.({ data: { items: stalePage, count: 51, remaining: 0, countsByPod: { 'pod-1': 51 } } }); });
    expect(screen.queryByText('Stale page row')).not.toBeInTheDocument();
  });

  test('passes pod scope to the server before pagination', async () => {
    const scopedRecap = { ...recap, pods: [...recap.pods, { id: 'pod-2', name: 'GTM Programs' }] };
    const scopedItems = Array.from({ length: 9 }, (_, index) => ({
      id: `gtm-${index}`, attentionItemId: `gtm-attention-${index}`, kind: 'mention', title: `GTM ${index}`, detail: 'Scoped item.',
      podId: 'pod-2', podName: 'GTM Programs', createdAt: '2026-08-26T11:00:00.000Z',
    }));
    mockGet.mockImplementation((url: string, config: any) => {
      if (url === '/api/activity/decision-queue') {
        const scoped = config?.params?.podId === 'pod-2';
        return Promise.resolve({ data: scoped
          ? { items: scopedItems, count: 9, remaining: 0, countsByPod: { 'pod-2': 9 }, composePodId: 'pod-2' }
          : { ...decisionQueue, count: 56, remaining: 54, items: decisionQueue.items } });
      }
      return Promise.resolve({ data: scopedRecap });
    });
    renderPage();
    await screen.findByText('Review requested');
    fireEvent.click(screen.getByRole('button', { name: 'GTM Programs' }));
    expect(await screen.findByText('GTM 8')).toBeInTheDocument();
    expect(screen.queryByText('Nothing open.')).not.toBeInTheDocument();
    expect(mockGet).toHaveBeenCalledWith('/api/activity/decision-queue', expect.objectContaining({
      params: expect.objectContaining({ podId: 'pod-2', limit: 50, offset: 0 }),
    }));
  });

  test('discards a late scoped response after the user switches scope again', async () => {
    const scopedRecap = { ...recap, pods: [...recap.pods, { id: 'pod-2', name: 'GTM Programs' }] };
    const scopedItems = [{
      id: 'late-gtm', attentionItemId: 'late-gtm-attention', kind: 'mention', title: 'Late GTM item', detail: 'Stale response.',
      podId: 'pod-2', podName: 'GTM Programs', createdAt: '2026-08-26T11:00:00.000Z',
    }];
    let resolveScoped: ((value: any) => void) | null = null;
    mockGet.mockImplementation((url: string, config: any) => {
      if (url === '/api/activity/decision-queue' && config?.params?.podId === 'pod-2') {
        return new Promise((resolve) => { resolveScoped = resolve; });
      }
      return Promise.resolve({ data: url === '/api/activity/decision-queue'
        ? decisionQueue
        : scopedRecap });
    });
    renderPage();
    await screen.findByText('Review requested');
    fireEvent.click(screen.getByRole('button', { name: 'GTM Programs' }));
    await waitFor(() => expect(resolveScoped).not.toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'All pods' }));
    await screen.findByText('Review requested');

    await act(async () => {
      resolveScoped?.({ data: {
        items: scopedItems, count: 1, remaining: 0, countsByPod: { 'pod-2': 1 }, composePodId: 'pod-2',
      } });
    });
    expect(screen.queryByText('Late GTM item')).not.toBeInTheDocument();
  });

  test('uses Open pod when a decision has no source message', async () => {
    const sourceLess = {
      items: [{ id: 'decision-source-less', kind: 'decision', title: 'Old decision', detail: 'No originating message.', podId: 'pod-1', podName: 'Launch pod', options: [] }],
      count: 1, remaining: 0, countsByPod: { 'pod-1': 1 }, composePodId: null,
    };
    mockGet.mockImplementation((url: string) => Promise.resolve({ data: url === '/api/activity/decision-queue' ? sourceLess : recap }));
    renderPage();
    expect(await screen.findByText('Old decision')).toBeInTheDocument();
    const queue = document.querySelector('.v2-activity__queue');
    expect(queue).not.toBeNull();
    expect(within(queue as HTMLElement).getByRole('button', { name: 'Open pod' })).toBeInTheDocument();
    expect(within(queue as HTMLElement).queryByRole('button', { name: 'Open' })).not.toBeInTheDocument();
    fireEvent.click(within(queue as HTMLElement).getByRole('button', { name: 'Open pod' }));
    expect(screen.getByTestId('current-path')).toHaveTextContent('/v2/pods/pod-1');
    expect(screen.getByTestId('current-path')).not.toHaveTextContent('#message-');
  });

  test('does not substitute recap attention or claim empty on queue failure', async () => {
    mockGet.mockImplementation((url: string) => url === '/api/activity/decision-queue'
      ? Promise.reject(new Error('queue down')) : Promise.resolve({ data: recap }));
    renderPage();
    expect(await screen.findByRole('status')).toBeInTheDocument();
    expect(screen.queryByText('Review requested')).not.toBeInTheDocument();
    expect(screen.queryByText('Nothing open.')).not.toBeInTheDocument();
  });

  test('retains rows and offers Retry when a refresh fails', async () => {
    let reads = 0;
    mockGet.mockImplementation((url: string) => {
      if (url !== '/api/activity/decision-queue') return Promise.resolve({ data: recap });
      reads += 1;
      if (reads === 1) return Promise.resolve({ data: decisionQueue });
      if (reads === 2) return Promise.reject(new Error('queue down'));
      return Promise.resolve({ data: { items: [], count: 0, countsByPod: {} } });
    });
    renderPage();
    expect(await screen.findByText('Review requested')).toBeInTheDocument();
    await act(async () => { window.dispatchEvent(new Event(ATTENTION_CHANGED)); });
    expect(await screen.findByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.getByText('Review requested')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByText('Review requested')).not.toBeInTheDocument());
  });
});
