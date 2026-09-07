// @ts-nocheck
import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import axios from 'axios';
import i18n, { i18nReady } from '../../i18n';
import V2ActivityPage from '../components/V2ActivityPage';
import { FIRST_RUN_REOPEN_EVENT } from '../firstRunGuide';
import { ATTENTION_CHANGED } from '../hooks/useV2PodAttention';
import { AuthContext } from '../../context/AuthContext';
import { setupFocusManagement } from '../../utils/focusUtils';

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

const renderPageWithAuth = (currentUser: { _id: string } | null) => render(
  <AuthContext.Provider value={{ currentUser, loading: false } as any}>
    <MemoryRouter initialEntries={['/v2/activity']}>
      <V2ActivityPage />
      <CurrentPath />
    </MemoryRouter>
  </AuthContext.Provider>
);

describe('V2ActivityPage', () => {
  beforeAll(async () => { await i18nReady; setupFocusManagement(); });

  beforeEach(async () => {
    jest.clearAllMocks();
    sessionStorage.clear();
    mockGet.mockImplementation((url: string) => {
      if (url === '/api/activity/decision-queue') return Promise.resolve({ data: decisionQueue });
      if (url === '/api/activity/decision-history') return Promise.resolve({ data: { items: [] } });
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
    expect(screen.getByRole('button', { name: 'Rule: Ship now (Recommended)' })).toBeInTheDocument();
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

  test('preserves authored decision order and makes only the first option primary', async () => {
    const authoredOrder = {
      ...decisionQueue,
      items: [{
        ...decisionQueue.items[1],
        options: [
          { label: 'Hold for review', description: 'Wait for a second pass.', recommended: false },
          { label: 'Ship now', description: 'Release the bounded change.', recommended: true },
        ],
      }],
      count: 1,
    };
    mockGet.mockImplementation((url: string) => Promise.resolve({ data: url === '/api/activity/decision-queue' ? authoredOrder : recap }));
    renderPage();

    const first = await screen.findByRole('button', { name: 'Rule: Hold for review' });
    const second = screen.getByRole('button', { name: 'Rule: Ship now (Recommended)' });
    expect(first).toHaveClass('v2-activity__option--primary');
    expect(second).not.toHaveClass('v2-activity__option--primary');
    expect(second).toHaveTextContent('Recommended');
    expect(first).not.toHaveTextContent('Recommended');
    expect(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
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

    fireEvent.click(await screen.findByRole('button', { name: 'Rule: Ship now (Recommended)' }));
    await waitFor(() => expect(mockPost).toHaveBeenCalledWith(
      '/api/activity/decisions/decision-024/choose',
      { value: 'Ship now' },
      expect.objectContaining({ headers: expect.any(Object) }),
    ));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Rule: Ship now (Recommended)' })).not.toBeInTheDocument());
  });

  test('keeps a successful ruling visible when a successful queue refresh omits the settled row', async () => {
    let queueReads = 0;
    mockGet.mockImplementation((url: string) => {
      if (url === '/api/activity/decision-queue') {
        queueReads += 1;
        return queueReads === 1
          ? Promise.resolve({ data: decisionQueue })
          : Promise.resolve({ data: { items: [], count: 0, composePodId: 'pod-1' } });
      }
      if (url === '/api/activity/decision-history') return Promise.resolve({ data: { items: [] } });
      return Promise.resolve({ data: recap });
    });
    mockPost.mockResolvedValue({ data: { ok: true, decision: { ruling: { value: 'Ship now', by: 'You' } } } });
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Rule: Ship now (Recommended)' }));
    expect(await screen.findByText('✓ You ruled: Ship now')).toBeInTheDocument();
  });

  test('restores a settled Activity card from durable history after leave and return', async () => {
    const settled = {
      id: 'decision-024', kind: 'decision', title: 'Choose the eslint scope', detail: 'What should the agent do?',
      podId: 'pod-1', podName: 'Launch pod', messageId: '700', threadRootId: '695',
      options: [{ label: 'Ship now' }, { label: 'Hold for review' }], status: 'ruled',
      ruling: { value: 'Ship now', by: 'You' },
    };
    mockGet.mockImplementation((url: string) => {
      if (url === '/api/activity/decision-queue') return Promise.resolve({ data: { items: [], count: 0, countsByPod: {} } });
      if (url === '/api/activity/decision-history') return Promise.resolve({ data: { items: [settled] } });
      return Promise.resolve({ data: recap });
    });

    const first = renderPage();
    expect(await screen.findByText('✓ You ruled: Ship now')).toBeInTheDocument();
    first.unmount();

    renderPage();
    expect(await screen.findByText('✓ You ruled: Ship now')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Rule:/ })).not.toBeInTheDocument();
  });

  test('loads older settled decisions only when the Activity history control is requested', async () => {
    const newest = {
      id: 'decision-newest', kind: 'decision', title: 'Newest decision', detail: 'A newer ruling',
      podId: 'pod-1', podName: 'Launch pod', messageId: '651', options: [{ label: 'Keep' }], status: 'ruled',
      ruling: { value: 'Keep', by: 'You' },
    };
    const firstPage = [newest, ...Array.from({ length: 49 }, (_, index) => ({
      ...newest,
      id: `decision-${index}`,
      title: `Decision ${index}`,
      messageId: String(650 - index),
    }))];
    const older = {
      id: 'decision-older', kind: 'decision', title: 'Older decision', detail: 'An older ruling',
      podId: 'pod-1', podName: 'Launch pod', messageId: '650', options: [{ label: 'Keep' }], status: 'ruled',
      ruling: { value: 'Keep', by: 'You' },
    };
    let historyReads = 0;
    mockGet.mockImplementation((url: string, config?: any) => {
      if (url === '/api/activity/decision-queue') return Promise.resolve({ data: { items: [], count: 0, countsByPod: {} } });
      if (url === '/api/activity/decision-history') {
        historyReads += 1;
        expect(config?.params?.offset).toBe(historyReads === 1 ? 0 : 50);
        return Promise.resolve({ data: historyReads === 1
          ? { items: firstPage, count: 51, remaining: 1, hasMore: true }
          : { items: [older], count: 51, remaining: 0, hasMore: false } });
      }
      return Promise.resolve({ data: recap });
    });
    renderPage();

    expect(await screen.findByText('Newest decision')).toBeInTheDocument();
    expect(historyReads).toBe(1);
    expect(screen.queryByText('Older decision')).not.toBeInTheDocument();
    const more = screen.getByRole('button', { name: 'Show more settled · 1 remaining' });
    fireEvent.click(more);
    expect(await screen.findByText('Older decision')).toBeInTheDocument();
    await waitFor(() => expect(historyReads).toBe(2));
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

  test('keeps a decision request as an open-thread fact when it has no declared options', async () => {
    const taskQueue = {
      items: [{
        id: 'decision-1', attentionItemId: 'attention-decision-1', kind: 'decision',
        title: 'Choose a deploy shape', detail: 'Blocked on an upstream choice.',
        podId: 'pod-1', podName: 'Launch pod', options: [], source: { type: 'decision_request' }, createdAt: '2026-08-26T11:00:00.000Z',
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

  test('renders a handoff as a handled action, never as a decision', async () => {
    const handoffQueue = {
      items: [{
        id: 'task-1:update-1', attentionItemId: 'attention-handoff-1', kind: 'handoff',
        title: 'Ready for your press', detail: 'The bounded implementation is ready for review.',
        podId: 'pod-1', podName: 'Launch pod', createdAt: '2026-08-26T11:00:00.000Z',
      }],
      count: 1,
      countsByPod: { 'pod-1': 1 },
      countsByKind: { handoff: 1 },
      composePodId: 'pod-1',
    };
    let queueReads = 0;
    mockGet.mockImplementation((url: string) => {
      if (url === '/api/activity/decision-queue') {
        queueReads += 1;
        return Promise.resolve({ data: queueReads === 1 ? handoffQueue : { items: [], count: 0, countsByPod: {}, countsByKind: {} } });
      }
      return Promise.resolve({ data: { ...recap, needsYou: [] } });
    });
    mockPost.mockResolvedValue({ data: { success: true } });
    renderPage();

    expect(await screen.findByText('Ready for your press')).toBeInTheDocument();
    expect(screen.getByText(/Handoff · Launch pod/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Mark handled' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Rule:/ })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Mark handled' }));
    await waitFor(() => expect(mockPost).toHaveBeenCalledWith(
      '/api/activity/attention-handoff-1/acknowledge',
      {},
      expect.objectContaining({ headers: expect.any(Object) }),
    ));
    expect(await screen.findByText('Nothing open.')).toBeInTheDocument();
  });

  test('keeps a failed handoff acknowledgement and retry beside its row', async () => {
    const handoffQueue = {
      items: [{
        id: 'task-1:update-2', attentionItemId: 'attention-handoff-2', kind: 'handoff',
        title: 'Needs a retry', detail: 'The first acknowledgement fails.',
        podId: 'pod-1', podName: 'Launch pod', createdAt: '2026-08-26T11:00:00.000Z',
      }],
      count: 1,
      countsByPod: { 'pod-1': 1 },
      countsByKind: { handoff: 1 },
      composePodId: 'pod-1',
    };
    let queueReads = 0;
    mockGet.mockImplementation((url: string) => {
      if (url === '/api/activity/decision-queue') {
        queueReads += 1;
        return Promise.resolve({ data: queueReads === 1 ? handoffQueue : { items: [], count: 0, countsByPod: {}, countsByKind: {} } });
      }
      return Promise.resolve({ data: { ...recap, needsYou: [] } });
    });
    mockPost
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValueOnce({ data: { success: true } });
    renderPage();

    const row = (await screen.findByText('Needs a retry')).closest('article') as HTMLElement;
    const markHandled = within(row).getByRole('button', { name: 'Mark handled' });
    markHandled.focus();
    fireEvent.click(markHandled);
    expect(mockPost).toHaveBeenCalledTimes(1);
    (document.activeElement as HTMLElement | null)?.blur();

    expect(await within(row).findByRole('alert')).toHaveTextContent(/could not be marked handled/i);
    await waitFor(() => expect(markHandled).toHaveFocus());
    expect(within(row).getByRole('button', { name: 'Mark handled' })).toBeInTheDocument();
    expect(screen.getAllByRole('alert')).toHaveLength(1);

    fireEvent.click(within(row).getByRole('button', { name: 'Mark handled' }));
    await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('Nothing open.')).toBeInTheDocument();
  });

  test('does not steal focus when the user moves during a failed action', async () => {
    let rejectRequest: (error: Error) => void;
    mockPost.mockImplementationOnce(() => new Promise((resolve, reject) => { rejectRequest = reject; }));
    renderPage();
    const acknowledge = await screen.findByRole('button', { name: 'Mark handled' });
    acknowledge.focus();
    fireEvent.click(acknowledge);
    acknowledge.blur(); // Real browsers blur a newly disabled focused button.
    const compose = screen.getByRole('textbox', { name: i18n.t('activity.compose.placeholder') });
    compose.focus();
    await act(async () => { rejectRequest(new Error('temporary failure')); });
    await act(async () => { await new Promise((resolve) => requestAnimationFrame(resolve)); });
    expect(compose).toHaveFocus();
    expect(acknowledge).not.toBeDisabled();
  });

  test('an older failed action does not consume a newer action focus target', async () => {
    const queue = {
      ...decisionQueue,
      items: [
        { ...decisionQueue.items[0], id: 'approval-focus', kind: 'approval', title: 'Approval focus' },
        { ...decisionQueue.items[0], id: 'handoff-focus', attentionItemId: 'handoff-attention', kind: 'handoff', title: 'Handoff focus' },
      ],
    };
    mockGet.mockImplementation((url: string) => Promise.resolve({ data: url === '/api/activity/decision-queue' ? queue : recap }));
    let rejectApproval: (error: Error) => void;
    let rejectHandoff: (error: Error) => void;
    mockPost.mockImplementation((url: string) => {
      (document.activeElement as HTMLElement | null)?.blur();
      return new Promise((resolve, reject) => {
        if (url.endsWith('/approve')) rejectApproval = reject;
        else rejectHandoff = reject;
      });
    });
    renderPage();
    const approve = await screen.findByRole('button', { name: 'Approve' });
    const handled = screen.getByRole('button', { name: 'Mark handled' });
    approve.focus();
    fireEvent.click(approve);
    handled.focus();
    fireEvent.click(handled);
    expect(mockPost).toHaveBeenCalledTimes(2);
    await act(async () => { rejectApproval(new Error('approval failed')); });
    await act(async () => { await new Promise((resolve) => requestAnimationFrame(resolve)); });
    expect(document.body).toHaveFocus();
    expect(handled).toBeDisabled();
    await act(async () => { rejectHandoff(new Error('handoff failed')); });
    await act(async () => { await new Promise((resolve) => requestAnimationFrame(resolve)); });
    expect(handled).toHaveFocus();
    expect(handled).not.toBeDisabled();
  });

  test('keeps a failed reply actionable with reply-specific feedback and focus', async () => {
    mockPost.mockRejectedValueOnce(new Error('reply down'));
    renderPage();

    const row = (await screen.findByText('Review requested')).closest('article') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: 'Reply' }));
    const composer = await within(row).findByRole('textbox', { name: 'Reply in thread…' });
    fireEvent.change(composer, { target: { value: 'please check this' } });
    composer.focus();
    fireEvent.keyDown(composer, { key: 'Enter', ctrlKey: true });
    (document.activeElement as HTMLElement | null)?.blur();

    expect(await within(row).findByRole('alert')).toHaveTextContent(/Your reply could not be sent/i);
    await waitFor(() => expect(composer).toHaveFocus());
  });

  test('does not steal focus when the user moves to another control during a failed action', async () => {
    const handoffQueue = {
      items: [{
        id: 'task-1:update-focus', attentionItemId: 'attention-handoff-focus', kind: 'handoff',
        title: 'Focus-safe handoff', detail: 'Keep the user in control.',
        podId: 'pod-1', podName: 'Launch pod', createdAt: '2026-08-26T11:00:00.000Z',
      }],
      count: 1,
      countsByPod: { 'pod-1': 1 },
      countsByKind: { handoff: 1 },
      composePodId: 'pod-1',
    };
    let rejectAction: ((error: Error) => void) | null = null;
    mockGet.mockImplementation((url: string) => Promise.resolve({ data: url === '/api/activity/decision-queue' ? handoffQueue : { ...recap, needsYou: [] } }));
    mockPost.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectAction = reject; }));
    renderPage();

    const row = (await screen.findByText('Focus-safe handoff')).closest('article') as HTMLElement;
    const markHandled = within(row).getByRole('button', { name: 'Mark handled' });
    const openPod = within(row).getByRole('button', { name: 'Open pod' });
    markHandled.focus();
    fireEvent.click(markHandled);
    await waitFor(() => expect(markHandled).toHaveTextContent('Saving…'));
    openPod.focus();
    await act(async () => { rejectAction?.(new Error('temporary failure')); });

    expect(await within(row).findByRole('alert')).toHaveTextContent(/could not be marked handled/i);
    expect(openPod).toHaveFocus();
  });

  test('keeps concurrent action failures on their own focus requests', async () => {
    const queue = {
      items: [
        {
          id: 'approval-focus', kind: 'approval', title: 'Approve the change', detail: 'A protected action.',
          podId: 'pod-1', podName: 'Launch pod', createdAt: '2026-08-26T11:00:00.000Z',
        },
        {
          id: 'handoff-focus', attentionItemId: 'attention-handoff-focus-2', kind: 'handoff', title: 'Review the change', detail: 'A recipient-owned handoff.',
          podId: 'pod-1', podName: 'Launch pod', createdAt: '2026-08-26T10:00:00.000Z',
        },
      ],
      count: 2,
      countsByPod: { 'pod-1': 2 },
      countsByKind: { approval: 1, handoff: 1 },
      composePodId: 'pod-1',
    };
    let rejectApproval: ((error: Error) => void) | null = null;
    let rejectHandoff: ((error: Error) => void) | null = null;
    mockGet.mockImplementation((url: string) => Promise.resolve({ data: url === '/api/activity/decision-queue' ? queue : { ...recap, needsYou: [] } }));
    mockPost.mockImplementation((url: string) => new Promise((_resolve, reject) => {
      if (url.includes('/approval-focus/')) rejectApproval = reject;
      else rejectHandoff = reject;
    }));
    renderPage();

    const approvalRow = (await screen.findByText('Approve the change')).closest('article') as HTMLElement;
    const handoffRow = (await screen.findByText('Review the change')).closest('article') as HTMLElement;
    const approve = within(approvalRow).getByRole('button', { name: 'Approve' });
    const markHandled = within(handoffRow).getByRole('button', { name: 'Mark handled' });
    approve.focus();
    fireEvent.click(approve);
    markHandled.focus();
    fireEvent.click(markHandled);

    await act(async () => { rejectApproval?.(new Error('approval down')); await Promise.resolve(); });
    expect(await within(approvalRow).findByRole('alert')).toHaveTextContent(/approval could not be updated/i);
    expect(markHandled).toHaveFocus();

    markHandled.blur();
    await act(async () => { rejectHandoff?.(new Error('handoff down')); await Promise.resolve(); });
    expect(await within(handoffRow).findByRole('alert')).toHaveTextContent(/handoff could not be marked handled/i);
    await waitFor(() => expect(markHandled).toHaveFocus());
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

  test('describes the count in the active queue scope without claiming rail/inspector parity', async () => {
    const scopedRecap = { ...recap, pods: [...recap.pods, { id: 'pod-2', name: 'GTM Programs' }] };
    mockGet.mockImplementation((url: string, config: any) => {
      if (url === '/api/activity/decision-queue') {
        return Promise.resolve({ data: config?.params?.podId === 'pod-2'
          ? { items: [], count: 9, remaining: 0, countsByPod: { 'pod-2': 9 } }
          : { ...decisionQueue, count: 56, countsByPod: { 'pod-1': 56 } } });
      }
      return Promise.resolve({ data: scopedRecap });
    });
    renderPage();

    expect(await screen.findByText('Open items across all pods')).toBeInTheDocument();
    expect(screen.getByLabelText('56 waiting on you')).toHaveTextContent('56');
    fireEvent.click(screen.getByRole('button', { name: 'GTM Programs' }));
    expect(await screen.findByText('Open items in this pod')).toBeInTheDocument();
    expect(screen.getByLabelText('9 waiting on you')).toHaveTextContent('9');
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
    await waitFor(() => expect(document.querySelector('[data-activity-item-id="mention-50"]')).toHaveFocus());
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
    expect(screen.getByText('Count unavailable')).toBeInTheDocument();
    expect(screen.queryByText('the same 0 as the rail and the inspector')).not.toBeInTheDocument();
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

  test('does not restore another account\'s queue or drafts before or after revalidation', async () => {
    const privateItem = { ...decisionQueue.items[0], title: 'Private request for account A' };
    mockGet.mockImplementation((url: string) => Promise.resolve({ data: url === '/api/activity/decision-queue'
      ? { ...decisionQueue, items: [privateItem], count: 1 }
      : recap }));
    const accountA = renderPageWithAuth({ _id: 'user-a' });
    await screen.findByText(privateItem.title);
    fireEvent.change(screen.getByRole('textbox', { name: i18n.t('activity.compose.placeholder') }), {
      target: { value: 'Private unsent draft from account A' },
    });
    // Exercise the real snapshot writer, so a shared or constant-account key
    // cannot pass merely because a hardcoded fixture key stopped matching.
    fireEvent.click(screen.getByRole('button', { name: 'Open', exact: true }));
    expect(screen.getByTestId('current-path')).toHaveTextContent('#message-699');
    accountA.unmount();

    const pending: Array<{ url: string; resolve: (value: any) => void }> = [];
    mockGet.mockImplementation((url: string) => new Promise((resolve) => pending.push({ url, resolve })));
    renderPageWithAuth({ _id: 'user-b' });
    await waitFor(() => expect(pending.length).toBeGreaterThanOrEqual(2));
    expect(screen.queryByText(privateItem.title)).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue('Private unsent draft from account A')).not.toBeInTheDocument();

    await act(async () => {
      pending.forEach(({ url, resolve }) => resolve({ data: url === '/api/activity/decision-queue'
        ? { ...decisionQueue, items: [{ ...privateItem, title: 'Fresh request for account B' }], count: 1 }
        : { ...recap, needsYou: [], agents: [], board: [] } }));
    });
    expect(await screen.findByText('Fresh request for account B')).toBeInTheDocument();
    expect(screen.queryByText(privateItem.title)).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue('Private unsent draft from account A')).not.toBeInTheDocument();
  });

  test('does not display the previous scope rows when the new scope fails', async () => {
    const scopedRecap = { ...recap, pods: [...recap.pods, { id: 'pod-2', name: 'GTM Programs' }] };
    mockGet.mockImplementation((url: string, config: any) => {
      if (url !== '/api/activity/decision-queue') return Promise.resolve({ data: scopedRecap });
      if (config?.params?.podId === 'pod-2') return Promise.reject(new Error('scope read failed'));
      return Promise.resolve({ data: decisionQueue });
    });
    renderPage();
    await screen.findByText('Review requested');
    fireEvent.click(screen.getByRole('button', { name: 'GTM Programs', exact: true }));
    await screen.findByRole('button', { name: 'Retry' });
    expect(screen.getByRole('button', { name: 'GTM Programs', exact: true })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByText('Review requested')).not.toBeInTheDocument();
    expect(screen.getByText('Count unavailable')).toBeInTheDocument();
  });

  test('revalidates every loaded page on a same-scope refresh', async () => {
    const firstPage = Array.from({ length: 50 }, (_, index) => ({
      id: `refresh-extent-${index}`, attentionItemId: `refresh-extent-attention-${index}`, kind: 'mention', title: `Extent ${index}`,
      detail: 'Loaded row.', podId: 'pod-1', podName: 'Launch pod', createdAt: '2026-08-26T11:00:00.000Z',
    }));
    const secondPage = Array.from({ length: 6 }, (_, index) => ({
      id: `refresh-extent-${index + 50}`, attentionItemId: `refresh-extent-attention-${index + 50}`, kind: 'mention', title: `Extent ${index + 50}`,
      detail: 'Loaded row.', podId: 'pod-1', podName: 'Launch pod', createdAt: '2026-08-26T10:00:00.000Z',
    }));
    let initial = true;
    mockGet.mockImplementation((url: string, config: any) => {
      if (url !== '/api/activity/decision-queue') return Promise.resolve({ data: recap });
      const offset = config?.params?.offset || 0;
      if (offset === 50) return Promise.resolve({ data: { items: secondPage, count: 56, remaining: 0, countsByPod: { 'pod-1': 56 } } });
      const items = initial ? firstPage : firstPage;
      initial = false;
      return Promise.resolve({ data: { items, count: 56, remaining: 6, countsByPod: { 'pod-1': 56 } } });
    });
    renderPage();
    await screen.findByText('Extent 0');
    fireEvent.click(await screen.findByRole('button', { name: 'Show more · 6 remaining' }));
    expect(await screen.findByText('Extent 55')).toBeInTheDocument();

    await act(async () => { window.dispatchEvent(new Event(ATTENTION_CHANGED)); });
    await waitFor(() => expect(mockGet).toHaveBeenCalledWith('/api/activity/decision-queue', expect.objectContaining({
      params: expect.objectContaining({ offset: 50, limit: 50 }),
    })));
    expect(screen.getByText('Extent 55')).toBeInTheDocument();
  });

  test('retries a failed append at its original offset', async () => {
    const firstPage = Array.from({ length: 50 }, (_, index) => ({
      id: `append-retry-${index}`, attentionItemId: `append-retry-attention-${index}`, kind: 'mention', title: `Append ${index}`,
      detail: 'Loaded row.', podId: 'pod-1', podName: 'Launch pod', createdAt: '2026-08-26T11:00:00.000Z',
    }));
    const secondPage = [{ id: 'append-retry-50', attentionItemId: 'append-retry-attention-50', kind: 'mention', title: 'Append 50', detail: 'Retried row.', podId: 'pod-1', podName: 'Launch pod' }];
    let appendReads = 0;
    mockGet.mockImplementation((url: string, config: any) => {
      if (url !== '/api/activity/decision-queue') return Promise.resolve({ data: recap });
      if (config?.params?.offset === 50) {
        appendReads += 1;
        if (appendReads === 1) return Promise.reject(new Error('page down'));
        return Promise.resolve({ data: { items: secondPage, count: 51, remaining: 0, countsByPod: { 'pod-1': 51 } } });
      }
      return Promise.resolve({ data: { items: firstPage, count: 51, remaining: 1, countsByPod: { 'pod-1': 51 } } });
    });
    renderPage();
    await screen.findByText('Append 0');
    fireEvent.click(await screen.findByRole('button', { name: 'Show more · 1 remaining' }));
    expect(await screen.findByRole('button', { name: 'Retry' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Append 50')).toBeInTheDocument();
    expect(appendReads).toBe(2);
  });

  test('returns focus to the composer picker after selecting a destination', async () => {
    const activityRecap = { ...recap, pods: [...recap.pods, { id: 'pod-2', name: 'GTM Programs' }] };
    mockGet.mockImplementation((url: string) => Promise.resolve({ data: url === '/api/activity/decision-queue' ? decisionQueue : activityRecap }));
    renderPage();
    await screen.findByRole('heading', { name: 'Tell your agents' });
    const picker = document.querySelector<HTMLButtonElement>('.v2-activity__compose-picker-button');
    expect(picker).not.toBeNull();
    fireEvent.click(picker);
    fireEvent.click(within(screen.getByRole('listbox')).getByRole('option', { name: 'GTM Programs' }));
    await waitFor(() => expect(picker).toHaveFocus());
  });

  test('keeps an overflow pod selection visible and returns focus to its trigger', async () => {
    const extraPods = [2, 3, 4].map((id) => ({ id: `pod-${id}`, name: `Pod ${id}` }));
    mockGet.mockImplementation((url: string) => Promise.resolve({ data: url === '/api/activity/decision-queue' ? decisionQueue : { ...recap, pods: [...recap.pods, ...extraPods] } }));
    renderPage();
    const more = await screen.findByRole('button', { name: i18n.t('activity.morePods') });
    fireEvent.click(more);
    const choice = screen.getByRole('button', { name: 'Pod 4', exact: true });
    choice.focus();
    fireEvent.click(choice);
    expect(more).toHaveTextContent('Pod 4');
    expect(more).toHaveAttribute('aria-expanded', 'false');
    expect(more).toHaveFocus();
    fireEvent.click(more);
    fireEvent.keyDown(screen.getByRole('button', { name: 'Pod 3', exact: true }), { key: 'Escape' });
    expect(more).toHaveAttribute('aria-expanded', 'false');
    expect(more).toHaveFocus();
  });

  test('paginates all moved-forward lines in twenty-line batches and retains keyboard focus', async () => {
    const updates = Array.from({ length: 45 }, (_, index) => ({
      id: `moved-${index}`, podId: 'pod-1', podName: 'Launch pod', content: `Moved ${index}`, timestamp: `2026-08-26T11:${String(index).padStart(2, '0')}:00.000Z`,
    }));
    mockGet.mockImplementation((url: string) => Promise.resolve({ data: url === '/api/activity/decision-queue' ? decisionQueue : { ...recap, agents: [{ ...recap.agents[0], updates }] } }));
    renderPage();
    const more = await screen.findByRole('button', { name: '17 more' });
    const group = more.closest('article');
    const lines = () => group.querySelectorAll('.v2-activity__moved-line');
    expect(lines()).toHaveLength(3);
    fireEvent.click(more);
    expect(lines()).toHaveLength(20);
    fireEvent.click(within(group).getByRole('button', { name: '20 more' }));
    expect(lines()).toHaveLength(40);
    const lastMore = within(group).getByRole('button', { name: '6 more' });
    lastMore.focus();
    fireEvent.click(lastMore);
    expect(lines()).toHaveLength(46);
    for (const update of updates) expect(within(group).getByText(update.content)).toBeInTheDocument();
    const less = within(group).getByRole('button', { name: 'Show less' });
    await waitFor(() => expect(less).toHaveFocus());
    fireEvent.click(less);
    expect(lines()).toHaveLength(3);
    await waitFor(() => expect(within(group).getByRole('button', { name: '17 more' })).toHaveFocus());
  });

  test('revalidates the loaded Back extent and preserves the same account draft', async () => {
    const loaded = Array.from({ length: 56 }, (_, index) => ({
      id: `revalidated-${index}`, attentionItemId: `507f1f77bcf86cd7994390${String(index).padStart(2, '0')}`,
      kind: 'mention', title: `Revalidated ${index}`, detail: 'Older row', podId: 'pod-1', podName: 'Launch pod',
      messageId: String(900 + index), threadRootId: '895', createdAt: '2026-08-26T11:00:00.000Z',
    }));
    sessionStorage.setItem('v2:activity:snapshot:user-a', JSON.stringify({
      window: 'today', podId: 'all', recap, queue: loaded, queueCount: 56, queueRemaining: 0,
      queueCountsByPod: { 'pod-1': 56 }, composePodId: 'pod-1', composeDraft: 'draft from account A', focusedItemId: 'revalidated-55', scrollY: 321, savedAt: Date.now(),
    }));
    const scrollTo = jest.spyOn(window, 'scrollTo').mockImplementation(() => {});
    let queueReads = 0;
    mockGet.mockImplementation((url: string) => {
      if (url !== '/api/activity/decision-queue') return Promise.resolve({ data: recap });
      queueReads += 1;
      return Promise.resolve({ data: {
        items: queueReads === 1 ? loaded.slice(0, 50) : loaded.slice(50), count: 56,
        remaining: queueReads === 1 ? 6 : 0, countsByPod: { 'pod-1': 56 }, composePodId: 'pod-1',
      } });
    });
    renderPageWithAuth({ _id: 'user-a' });
    expect(await screen.findByText('Revalidated 55')).toBeInTheDocument();
    expect(screen.getByDisplayValue('draft from account A')).toBeInTheDocument();
    await waitFor(() => expect(document.querySelector('[data-activity-item-id="revalidated-55"]')).toHaveFocus());
    expect(scrollTo).toHaveBeenCalledWith(0, 321);
    expect(mockGet).toHaveBeenCalledWith('/api/activity/decision-queue', expect.objectContaining({
      params: expect.objectContaining({ limit: 50, offset: 50 }),
    }));
    scrollTo.mockRestore();
  });
});
