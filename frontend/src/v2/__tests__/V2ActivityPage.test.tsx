// @ts-nocheck
import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import axios from 'axios';
import i18n, { i18nReady } from '../../i18n';
import V2ActivityPage, { plainLine } from '../components/V2ActivityPage';
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

// The pod scope is one select key (d215 activity): open it, then pick the pod.
const chooseScope = (name: string) => {
  fireEvent.click(document.querySelector('.v2-activity__scope-button') as HTMLElement);
  fireEvent.click(within(screen.getByRole('listbox', { name: 'Pod scope' })).getByRole('option', { name, exact: true }));
};

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

  test('a needs-you email link opens and focuses its blocked ask', async () => {
    const blocked = {
      id: 'message-45', attentionItemId: 'attention-45', kind: 'blocked',
      title: 'Scout is blocked', detail: 'Needs the staging key',
      podId: 'pod-1', podName: 'Launch pod', createdAt: new Date().toISOString(),
    };
    mockGet.mockImplementation((url: string) => Promise.resolve({
      data: url === '/api/activity/decision-queue'
        ? { items: [blocked], count: 1, countsByPod: { 'pod-1': 1 } }
        : { ...recap, needsYou: [] },
    }));
    HTMLElement.prototype.scrollIntoView = jest.fn();
    render(
      <MemoryRouter initialEntries={['/v2/activity?item=attention-45']}>
        <V2ActivityPage />
      </MemoryRouter>,
    );

    expect(await screen.findByText('Scout is blocked')).toBeInTheDocument();
    await waitFor(() => expect(document.querySelector('[data-attention-id="attention-45"]')).toHaveFocus());
    expect(screen.getByRole('img', { name: 'blocked' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Mark handled' })).toBeInTheDocument();
  });

  test('an email ask overrides a saved filter for another pod', async () => {
    sessionStorage.setItem('v2:activity:snapshot:user-a', JSON.stringify({
      window: 'today', podId: 'pod-a', recap, queue: [], queueCount: 0, queueRemaining: 0,
      composeDraft: 'keep this draft', focusedItemId: 'old-row', scrollY: 400, savedAt: Date.now(),
    }));
    const blocked = {
      id: 'message-46', attentionItemId: 'attention-46', kind: 'blocked',
      title: 'Scout needs the key', detail: 'Pod B is blocked',
      podId: 'pod-b', podName: 'Another pod', createdAt: new Date().toISOString(),
    };
    mockGet.mockImplementation((url: string, config: any) => {
      if (url === '/api/activity/decision-queue') return Promise.resolve({ data: {
        items: config?.params?.podId === 'pod-a' ? [] : [blocked], count: 1,
        countsByPod: { 'pod-b': 1 },
      } });
      if (url === '/api/activity/decision-history') return Promise.resolve({ data: { items: [] } });
      return Promise.resolve({ data: recap });
    });
    HTMLElement.prototype.scrollIntoView = jest.fn();
    render(
      <AuthContext.Provider value={{ currentUser: { _id: 'user-a' }, loading: false } as any}>
        <MemoryRouter initialEntries={['/v2/activity?item=attention-46']}>
          <V2ActivityPage />
        </MemoryRouter>
      </AuthContext.Provider>,
    );

    expect(await screen.findByText('Scout needs the key')).toBeInTheDocument();
    await waitFor(() => expect(document.querySelector('[data-attention-id="attention-46"]')).toHaveFocus());
    expect(mockGet).toHaveBeenCalledWith('/api/activity/decision-queue', expect.objectContaining({
      params: expect.not.objectContaining({ podId: 'pod-a' }),
    }));
    expect(screen.getByDisplayValue('keep this draft')).toBeInTheDocument();
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

  test('preserves authored decision order; every choice is a raised key inside the row (d215 activity)', async () => {
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
    // No cobalt primary: the frame draws every option as the same raised key, Other… quiet.
    for (const key of [first, second]) expect(key).toHaveClass('v2p-b', 'v2p-b-s');
    expect(screen.getByRole('button', { name: 'Other…' })).toHaveClass('v2p-b-g');
    // "recommended" rides inside its own key, in mono, not as a caption under it.
    expect(second).toHaveTextContent('Recommended');
    expect(first).not.toHaveTextContent('Recommended');
    expect(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The keys sit in the decision row itself, which is the one open row.
    const row = first.closest('article') as HTMLElement;
    expect(row).toHaveClass('v2-activity__queue-row--open');
    expect(row).toContainElement(second);
  });

  test('keeps long decision labels and descriptions readable when the recommendation is second', async () => {
    const longCopyQueue = {
      ...decisionQueue,
      items: [{
        ...decisionQueue.items[1],
        title: 'Scope of the five-post daily X cap',
        detail: '@Sam should we keep the five-post daily cap across every account post, or change it to count only squad-drafted sends?',
        options: [
          {
            label: 'Keep account-wide cap',
            description: 'Recommended default: retain five total X posts per day, including casual replies. Simple to count and limits total volume; casual use reduces squad capacity.',
            recommended: false,
          },
          {
            label: 'Change to squad-drafted only',
            description: 'Change the current rule to five squad-drafted sends per day, excluding Sam’s casual replies. Preserves squad capacity but permits more than five total posts and requires identifying draft origin.',
            recommended: true,
          },
          {
            label: 'Use a rolling seven-day cap for all sends',
            description: 'Spread the same total volume across a longer window while retaining one auditable limit.',
            recommended: false,
          },
        ],
      }],
      count: 1,
    };
    mockGet.mockImplementation((url: string) => Promise.resolve({ data: url === '/api/activity/decision-queue' ? longCopyQueue : recap }));
    renderPage();

    const first = await screen.findByRole('button', { name: 'Rule: Keep account-wide cap' });
    const second = screen.getByRole('button', { name: 'Rule: Change to squad-drafted only (Recommended)' });
    const third = screen.getByRole('button', { name: 'Rule: Use a rolling seven-day cap for all sends' });
    expect(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(second.compareDocumentPosition(third) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText('Recommended default: retain five total X posts per day, including casual replies. Simple to count and limits total volume; casual use reduces squad capacity.')).toBeInTheDocument();
    expect(screen.getByText('Change the current rule to five squad-drafted sends per day, excluding Sam’s casual replies. Preserves squad capacity but permits more than five total posts and requires identifying draft origin.')).toBeInTheDocument();
    expect(second).toHaveTextContent('Recommended');
    expect(second).toHaveAttribute('aria-describedby', expect.stringContaining('description'));
  });

  test('clamps long queue details until the reader expands them', async () => {
    const detail = 'This queue detail is intentionally long so the compact Activity row can reveal the complete context on demand.';
    const queueWithLongDetail = {
      ...decisionQueue,
      items: [{ ...decisionQueue.items[0], detail }],
      count: 1,
    };
    mockGet.mockImplementation((url: string) => Promise.resolve({ data: url === '/api/activity/decision-queue' ? queueWithLongDetail : recap }));
    renderPage();

    const detailButton = await screen.findByRole('button', { name: detail });
    expect(detailButton).toHaveClass('v2-activity__queue-detail');
    expect(detailButton).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(detailButton);
    expect(detailButton).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(detailButton);
    expect(detailButton).toHaveAttribute('aria-expanded', 'false');
  });

  test('a keyboard user with focus on the detail collapses it on the second toggle', async () => {
    const detail = 'Keyboard focus must not hold a queue detail open after the second Enter.';
    const queueWithLongDetail = {
      ...decisionQueue,
      items: [{ ...decisionQueue.items[0], detail }],
      count: 1,
    };
    mockGet.mockImplementation((url: string) => Promise.resolve({ data: url === '/api/activity/decision-queue' ? queueWithLongDetail : recap }));
    renderPage();

    const detailButton = await screen.findByRole('button', { name: detail });
    // Focus stays on the button across both toggles, as it does for Enter on a focused control.
    detailButton.focus();
    fireEvent.click(detailButton);
    expect(detailButton).toHaveClass('v2-activity__queue-detail--expanded');
    fireEvent.click(detailButton);
    expect(detailButton).not.toHaveClass('v2-activity__queue-detail--expanded');
    expect(detailButton).toHaveClass('v2-activity__queue-detail--dismissed');
    expect(detailButton).toHaveAttribute('aria-expanded', 'false');

    // Blur clears the dismissal, so a later Tab-in previews the full copy again.
    fireEvent.blur(detailButton);
    expect(detailButton).not.toHaveClass('v2-activity__queue-detail--dismissed');
  });

  test('changes the read window and opens the source pod from a factual queue row', async () => {
    renderPage();
    await screen.findByText('Review requested');

    fireEvent.click(screen.getByRole('radio', { name: '7 days' }));
    // toHaveBeenCalledWith, not Last: the decision-queue request now fires
    // alongside recap, so "last call" is no longer the recap by construction.
    await waitFor(() => expect(mockGet).toHaveBeenCalledWith('/api/activity/recap', expect.objectContaining({
      params: { window: '7d' },
    })));

    // findAll: the window change reloads both requests and the rows remount.
    // Oldest waiting first (66311) decides row order, so aim at the row itself.
    const row = (await screen.findByText('Review requested')).closest('article') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: 'Open' }));
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
    expect(await screen.findByText('Nothing needs you.')).toBeInTheDocument();
  });

  test('keeps an empty Needs you state honest', async () => {
    mockGet.mockImplementation((url: string) => Promise.resolve({ data: url === '/api/activity/decision-queue'
      ? { items: [], count: 0, countsByPod: {} } : recap }));
    renderPage();

    expect(await screen.findByText('Nothing needs you.')).toBeInTheDocument();
    expect(screen.queryByText(/0 needs you/i)).not.toBeInTheDocument();
  });

  test('day zero: Get started is its own card above Needs you, the composer hides until an agent exists, and steps leave one by one (66658/66666)', async () => {
    const empty = { ...recap, hasEverHadAttention: false, needsYou: [], agents: [], board: [] };
    // Facts come from the registry's per-pod agent list (what Your Team reads), never from the
    // 24h recap window (sprint-review 66671): a hired seat that has not acted is absent from recap.
    // Step 2 is the caller's own act (#1648, ux-lead 67071): the route says whether this account
    // has said anything in the pod (`callerSpoke`); a seat's `lastMessage` never closes it.
    const mockFor = (seats, connectors, callerSpoke = false) => (url: string) => {
      if (url === '/api/activity/decision-queue') return Promise.resolve({ data: { items: [], count: 0, countsByPod: {} } });
      if (url === '/api/integrations/user/all') return Promise.resolve({ data: connectors });
      if (url.startsWith('/api/registry/pods/')) return Promise.resolve({ data: { agents: seats, callerSpoke } });
      return Promise.resolve({ data: empty });
    };
    mockGet.mockImplementation(mockFor([], []));
    const first = renderPage();
    expect(await screen.findByRole('heading', { name: 'Get started' })).toBeInTheDocument();
    expect(await screen.findByText('3 steps')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Hire an agent' })).toHaveClass('v2-activity__start-cta--current');
    expect(screen.getByRole('button', { name: 'Open Launch pod' })).not.toHaveClass('v2-activity__start-cta--current');
    expect(screen.getByRole('button', { name: 'Add a connector' })).toBeInTheDocument();
    // Needs you still renders its panel underneath, with no count.
    expect(screen.getByText('Nothing needs you.')).toBeInTheDocument();
    expect(screen.queryByLabelText(/waiting on you/)).not.toBeInTheDocument();
    // Nobody to wake: the composer is hidden while step 1 is open.
    expect(screen.queryByRole('textbox', { name: i18n.t('activity.compose.placeholder') })).not.toBeInTheDocument();
    const card = screen.getByRole('heading', { name: 'Get started' }).closest('section') as HTMLElement;
    expect(card.compareDocumentPosition(screen.getByRole('heading', { name: 'Needs you' })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Hire an agent' }));
    expect(screen.getByTestId('current-path')).toHaveTextContent('/v2/agents');
    first.unmount();

    // An agent exists, the account has not spoken, no connector: steps 2 and 3, composer back,
    // step 2 is the ink act. The seat has already posted its install intro (lastMessage set) and
    // is alive (lastActiveAt from runtime-token use): neither is the person speaking (#1648).
    const introSeat = { name: 'scout', displayName: 'Scout', lastActiveAt: '2026-09-08T10:00:00.000Z', lastMessage: { content: 'Hi, I am Scout.', createdAt: '2026-09-08T10:00:01.000Z' } };
    mockGet.mockImplementation(mockFor([introSeat, { name: 'hosted-smoke', internal: true }], [], false));
    const second = renderPage();
    expect(await screen.findByText('2 steps')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Hire an agent' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open Launch pod' })).toHaveClass('v2-activity__start-cta--current');
    expect(screen.getByRole('textbox', { name: i18n.t('activity.compose.placeholder') })).toBeInTheDocument();
    second.unmount();

    // The account spoke, reply or not: step 2 leaves — with the connector row too, no card at all.
    const silentSeat = { name: 'scout', displayName: 'Scout', lastActiveAt: '2026-09-08T10:00:00.000Z', lastMessage: null };
    mockGet.mockImplementation(mockFor([silentSeat], [{ status: 'active' }], true));
    renderPage();
    expect(await screen.findByText('Nothing needs you.')).toBeInTheDocument();
    // The card holds its place while the roster is in flight (d215), then drops when no step is left.
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Get started' })).not.toBeInTheDocument());
  });

  test('day zero: Get started holds its place while the roster and connectors are in flight, then becomes the card (d215 s-activity)', async () => {
    const empty = { ...recap, hasEverHadAttention: false, needsYou: [], agents: [], board: [] };
    const seat = { name: 'scout', displayName: 'Scout' };
    const deferred = () => {
      let release: (value: unknown) => void = () => {};
      const promise = new Promise((resolve) => { release = resolve; });
      return { promise, release };
    };
    const mockWith = (registry: Promise<unknown>, connectors: Promise<unknown>, recapData = empty) => (url: string) => {
      if (url === '/api/activity/decision-queue') return Promise.resolve({ data: { items: [], count: 0, countsByPod: {} } });
      if (url === '/api/integrations/user/all') return connectors;
      if (url.startsWith('/api/registry/pods/')) return registry;
      return Promise.resolve({ data: recapData });
    };

    // In flight: the real head with "checking…", two rows of bars, aria-busy, no step act yet.
    const roster = deferred();
    const connectors = deferred();
    mockGet.mockImplementation(mockWith(roster.promise, connectors.promise));
    const first = renderPage();
    const pending = await screen.findByTestId('activity-start-pending');
    expect(pending).toHaveAttribute('aria-busy', 'true');
    expect(within(pending).getByRole('heading', { name: 'Get started' })).toBeInTheDocument();
    expect(within(pending).getByText('checking…')).toBeInTheDocument();
    expect(pending.querySelectorAll('.v2-activity__start-row')).toHaveLength(2);
    expect(within(pending).queryByRole('button')).not.toBeInTheDocument();
    // It sits where the card will sit: above Needs you.
    expect(pending.compareDocumentPosition(screen.getByRole('heading', { name: 'Needs you' })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The roster alone is not enough — the connector count still decides whether step 3 is a row.
    await act(async () => { roster.release({ data: { agents: [seat], callerSpoke: false } }); });
    expect(screen.getByTestId('activity-start-pending')).toBeInTheDocument();
    await act(async () => { connectors.release({ data: [] }); });
    await waitFor(() => expect(screen.queryByTestId('activity-start-pending')).not.toBeInTheDocument());
    const card = screen.getByRole('heading', { name: 'Get started' }).closest('section') as HTMLElement;
    expect(card).not.toHaveAttribute('aria-busy');
    expect(within(card).getByText('2 steps')).toBeInTheDocument();
    expect(within(card).getByText("Say hello in the pod where it lives. If it doesn't answer, @mention it.")).toBeInTheDocument();
    first.unmount();

    // Steps come back empty: the placeholder drops and no card replaces it.
    const roster2 = deferred();
    mockGet.mockImplementation(mockWith(roster2.promise, Promise.resolve({ data: [{ status: 'active' }] })));
    const second = renderPage();
    expect(await screen.findByTestId('activity-start-pending')).toBeInTheDocument();
    await act(async () => { roster2.release({ data: { agents: [seat], callerSpoke: true } }); });
    await waitFor(() => expect(screen.queryByTestId('activity-start-pending')).not.toBeInTheDocument());
    expect(screen.queryByRole('heading', { name: 'Get started' })).not.toBeInTheDocument();
    second.unmount();

    // Fail-closed: an account that has had an ask, or whose history is unknown, never reserves the slot.
    for (const hasEverHadAttention of [true, null]) {
      const never = deferred();
      mockGet.mockImplementation(mockWith(never.promise, never.promise, { ...empty, hasEverHadAttention }));
      const view = renderPage();
      expect(await screen.findByText('Nothing needs you.')).toBeInTheDocument();
      expect(screen.queryByTestId('activity-start-pending')).not.toBeInTheDocument();
      expect(screen.queryByRole('heading', { name: 'Get started' })).not.toBeInTheDocument();
      view.unmount();
    }
  });

  test('Moved forward names its window when empty (d215 s-activity)', async () => {
    mockGet.mockImplementation((url: string) => Promise.resolve({ data: url === '/api/activity/decision-queue'
      ? { items: [], count: 0, countsByPod: {} } : { ...recap, needsYou: [], agents: [], board: [] } }));
    renderPage();
    expect(await screen.findByText('Nothing yet today.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: '7 days' }));
    expect(await screen.findByText('Nothing moved in the last 7 days.')).toBeInTheDocument();
    expect(screen.queryByText('Nothing yet today.')).not.toBeInTheDocument();

    await act(async () => { await i18n.changeLanguage('zh-CN'); });
    expect(await screen.findByText('最近7天没有新进展。')).toBeInTheDocument();
  });

  test('day zero: a roster without the field, or a roster that fails, never reads as spoken (#1648)', async () => {
    const empty = { ...recap, pods: [{ id: 'pod-2', name: 'GTM Programs' }, ...recap.pods], hasEverHadAttention: false, needsYou: [], agents: [], board: [] };
    const seat = { name: 'scout', displayName: 'Scout', lastMessage: { content: 'Hi, I am Scout.' } };
    // A roster that predates the field (frontend and backend rolling out apart): step 2 stays open.
    mockGet.mockImplementation((url: string) => {
      if (url === '/api/activity/decision-queue') return Promise.resolve({ data: { items: [], count: 0, countsByPod: {} } });
      if (url === '/api/integrations/user/all') return Promise.resolve({ data: [{ status: 'active' }] });
      if (url === '/api/registry/pods/pod-1/agents') return Promise.resolve({ data: { agents: [seat] } });
      if (url.startsWith('/api/registry/pods/')) return Promise.resolve({ data: { agents: [] } });
      return Promise.resolve({ data: empty });
    });
    const first = renderPage();
    expect(await screen.findByText('1 step')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open Launch pod' })).toHaveClass('v2-activity__start-cta--current');
    first.unmount();

    // One pod's roster fails: it counts for nothing — neither a seat nor speech — and the card
    // still answers from the pods that did load.
    mockGet.mockImplementation((url: string) => {
      if (url === '/api/activity/decision-queue') return Promise.resolve({ data: { items: [], count: 0, countsByPod: {} } });
      if (url === '/api/integrations/user/all') return Promise.resolve({ data: [{ status: 'active' }] });
      if (url === '/api/registry/pods/pod-2/agents') return Promise.reject(new Error('roster down'));
      if (url === '/api/registry/pods/pod-1/agents') return Promise.resolve({ data: { agents: [seat], callerSpoke: false } });
      return Promise.resolve({ data: empty });
    });
    renderPage();
    expect(await screen.findByText('1 step')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open Launch pod' }));
    expect(screen.getByTestId('current-path')).toHaveTextContent('/v2/pods/pod-1');
  });

  test('day zero: speaking in a pod with no seat does not close step 2, and step 2 opens the pod that has one (#1648)', async () => {
    const empty = { ...recap, pods: [{ id: 'pod-2', name: 'GTM Programs' }, ...recap.pods], hasEverHadAttention: false, needsYou: [], agents: [], board: [] };
    mockGet.mockImplementation((url: string) => {
      if (url === '/api/activity/decision-queue') return Promise.resolve({ data: { items: [], count: 0, countsByPod: {} } });
      if (url === '/api/integrations/user/all') return Promise.resolve({ data: [{ status: 'active' }] });
      // pod-2: the account posted, but nobody is there to hear it. pod-1: a seat, and silence from the account.
      if (url === '/api/registry/pods/pod-2/agents') return Promise.resolve({ data: { agents: [], callerSpoke: true } });
      if (url === '/api/registry/pods/pod-1/agents') return Promise.resolve({ data: { agents: [{ name: 'scout', displayName: 'Scout', lastMessage: { content: 'Hi, I am Scout.' } }], callerSpoke: false } });
      return Promise.resolve({ data: empty });
    });
    renderPage();
    expect(await screen.findByText('1 step')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open Launch pod' }));
    expect(screen.getByTestId('current-path')).toHaveTextContent('/v2/pods/pod-1');
  });

  test('an agent action proposal is decided through /api/approvals, not the Activity verbs (#1650)', async () => {
    const approvalQueue = {
      items: [{
        id: 'appr-1', kind: 'approval', sourceType: 'approval_action', title: 'Scout requests approval', detail: 'May I open a room?',
        podId: 'pod-1', podName: 'Launch pod', createdAt: '2026-09-10T11:00:00.000Z',
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
    mockPost.mockResolvedValue({ data: { ok: true } });
    renderPage();

    // It rings, counts and badges like any ask (ux-lead on #1650).
    expect(await screen.findByLabelText('1 waiting on you')).toHaveTextContent('1');
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }));
    await waitFor(() => expect(mockPost).toHaveBeenCalledWith(
      '/api/approvals/appr-1/resolve',
      { decision: 'declined' },
      expect.anything(),
    ));
    expect(mockPost).not.toHaveBeenCalledWith(expect.stringContaining('/api/activity/appr-1'), expect.anything(), expect.anything());
  });

  describe('a parked tool call is reviewed on its card (F215)', () => {
    const toolQueue = (extra: Record<string, unknown>) => ({
      items: [{
        id: 'appr-2', kind: 'approval', sourceType: 'approval_action', title: 'Scout requests approval',
        detail: 'Update an issue (approval required)', podId: 'pod-1', podName: 'Launch pod',
        createdAt: '2026-09-10T11:00:00.000Z', messageId: 77, ...extra,
      }],
      count: 1,
      composePodId: 'pod-1',
    });
    const serve = (queue: unknown) => mockGet.mockImplementation((url: string) => (
      url === '/api/activity/decision-queue'
        ? Promise.resolve({ data: queue })
        : Promise.resolve({ data: { ...recap, needsYou: [] } })
    ));

    test('it offers Review, which opens the card, and no Approve', async () => {
      serve(toolQueue({ reviewOnCard: true }));
      renderPage();
      fireEvent.click(await screen.findByRole('button', { name: 'Review' }));
      expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
      expect(screen.getByTestId('current-path')).toHaveTextContent('/v2/pods/pod-1');
      expect(mockPost).not.toHaveBeenCalled();
    });

    test('it can still be denied from the row', async () => {
      serve(toolQueue({ reviewOnCard: true }));
      mockPost.mockResolvedValue({ data: { ok: true } });
      renderPage();
      await screen.findByRole('button', { name: 'Review' });
      fireEvent.click(screen.getByRole('button', { name: 'Deny' }));
      await waitFor(() => expect(mockPost).toHaveBeenCalledWith(
        '/api/approvals/appr-2/resolve', { decision: 'declined' }, expect.anything(),
      ));
    });

    test('a row filed before this change tells the owner to open it when the server refuses', async () => {
      serve(toolQueue({}));
      mockPost.mockRejectedValue({ response: { status: 409, data: { error: 'approval_needs_review' } } });
      renderPage();
      fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
      expect(await screen.findByText('Open this request and check it before you approve.')).toBeInTheDocument();
    });
  });

  test('hides Get started after any historical attention item, even with unfinished steps', async () => {
    const handledAskRecap = { ...recap, hasEverHadAttention: true, needsYou: [], agents: [], board: [] };
    let releaseRegistry: ((value: { data: { agents: unknown[] } }) => void) | null = null;
    const registryResponse = new Promise<{ data: { agents: unknown[] } }>((resolve) => { releaseRegistry = resolve; });
    const mockFor = (url: string) => {
      if (url === '/api/activity/decision-queue') return Promise.resolve({ data: { items: [], count: 0, countsByPod: {} } });
      if (url === '/api/integrations/user/all') return Promise.resolve({ data: [] });
      if (url.startsWith('/api/registry/pods/')) return registryResponse;
      return Promise.resolve({ data: handledAskRecap });
    };
    mockGet.mockImplementation(mockFor);

    renderPage();

    expect(await screen.findByRole('textbox', { name: i18n.t('activity.compose.placeholder') })).toBeInTheDocument();
    await act(async () => { releaseRegistry?.({ data: { agents: [] } }); });
    await waitFor(() => expect(screen.queryByRole('textbox', { name: i18n.t('activity.compose.placeholder') })).not.toBeInTheDocument());
    expect(screen.queryByRole('heading', { name: 'Get started' })).not.toBeInTheDocument();
    expect(screen.getByText('Nothing needs you.')).toBeInTheDocument();
  });

  test('fails closed when attention history is unavailable', async () => {
    const unknownAskRecap = { ...recap, hasEverHadAttention: null, needsYou: [], agents: [], board: [] };
    let releaseRegistry: ((value: { data: { agents: unknown[] } }) => void) | null = null;
    const registryResponse = new Promise<{ data: { agents: unknown[] } }>((resolve) => { releaseRegistry = resolve; });
    mockGet.mockImplementation((url: string) => {
      if (url === '/api/activity/decision-queue') return Promise.resolve({ data: { items: [], count: 0, countsByPod: {} } });
      if (url === '/api/integrations/user/all') return Promise.resolve({ data: [] });
      if (url.startsWith('/api/registry/pods/')) return registryResponse;
      return Promise.resolve({ data: unknownAskRecap });
    });

    renderPage();

    expect(await screen.findByRole('textbox', { name: i18n.t('activity.compose.placeholder') })).toBeInTheDocument();
    await act(async () => { releaseRegistry?.({ data: { agents: [] } }); });
    await waitFor(() => expect(screen.queryByRole('textbox', { name: i18n.t('activity.compose.placeholder') })).not.toBeInTheDocument());
    expect(screen.queryByRole('heading', { name: 'Get started' })).not.toBeInTheDocument();
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
    expect(await screen.findByText('Nothing needs you.')).toBeInTheDocument();
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
    expect(await screen.findByText('You ruled: Ship now')).toBeInTheDocument();
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
    expect(await screen.findByText('You ruled: Ship now')).toBeInTheDocument();
    first.unmount();

    renderPage();
    expect(await screen.findByText('You ruled: Ship now')).toBeInTheDocument();
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
    const newestArrival = {
      ...newest, id: 'decision-newest-arrival', title: 'Newest arrival', messageId: '652',
    };
    let historyReads = 0;
    mockGet.mockImplementation((url: string, config?: any) => {
      if (url === '/api/activity/decision-queue') return Promise.resolve({ data: { items: [], count: 0, countsByPod: {} } });
      if (url === '/api/activity/decision-history') {
        historyReads += 1;
        expect(config?.params?.offset).toBe(historyReads === 2 ? 50 : 0);
        return Promise.resolve({ data: historyReads === 1
          ? { items: firstPage, count: 51, remaining: 1, hasMore: true }
          : historyReads === 2
            ? { items: [older], count: 51, remaining: 0, hasMore: false }
            : { items: [newestArrival, ...firstPage.slice(0, 49)], count: 52, remaining: 2, hasMore: true } });
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
    await waitFor(() => expect(document.querySelector('[data-activity-item-id="decision-older"]')).toHaveFocus());
    globalThis.window.dispatchEvent(new Event(ATTENTION_CHANGED));
    await waitFor(() => expect(historyReads).toBe(3));
    expect(screen.getByText('Newest arrival')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Show more settled/ })).not.toBeInTheDocument();
    expect(screen.getByText('Older decision')).toBeInTheDocument();
  });

  test('does not revive More after a newest ruling arrives before older history is requested', async () => {
    const firstPage = Array.from({ length: 50 }, (_, index) => ({
      id: `decision-initial-${index}`, kind: 'decision', title: `Initial decision ${index}`, detail: 'A ruling',
      podId: 'pod-1', podName: 'Launch pod', messageId: String(900 - index), options: [{ label: 'Keep' }], status: 'ruled',
      ruling: { value: 'Keep', by: 'You' },
    }));
    const newestArrival = {
      ...firstPage[0], id: 'decision-newest-arrival', title: 'Newest arrival', messageId: '901',
    };
    let historyReads = 0;
    mockGet.mockImplementation((url: string) => {
      if (url === '/api/activity/decision-queue') return Promise.resolve({ data: { items: [], count: 0, countsByPod: {} } });
      if (url === '/api/activity/decision-history') {
        historyReads += 1;
        return historyReads === 1
          ? Promise.resolve({ data: { items: firstPage, count: 50, remaining: 0, hasMore: false } })
          : Promise.resolve({ data: { items: [newestArrival, ...firstPage.slice(0, 49)], count: 51, remaining: 1, hasMore: true } });
      }
      return Promise.resolve({ data: recap });
    });
    renderPage();

    expect(await screen.findByText('Initial decision 0')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Show more settled/ })).not.toBeInTheDocument();
    await act(async () => { window.dispatchEvent(new Event(ATTENTION_CHANGED)); });
    await waitFor(() => expect(historyReads).toBe(2));
    expect(await screen.findByText('Newest arrival')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Show more settled/ })).not.toBeInTheDocument();
  });

  test('returns focus to the settled-history Retry control after a failed page load', async () => {
    const newest = {
      id: 'decision-newest', kind: 'decision', title: 'Newest decision', detail: 'A newer ruling',
      podId: 'pod-1', podName: 'Launch pod', messageId: '651', options: [{ label: 'Keep' }], status: 'ruled',
      ruling: { value: 'Keep', by: 'You' },
    };
    let historyReads = 0;
    mockGet.mockImplementation((url: string) => {
      if (url === '/api/activity/decision-queue') return Promise.resolve({ data: { items: [], count: 0, countsByPod: {} } });
      if (url === '/api/activity/decision-history') {
        historyReads += 1;
        return historyReads === 1
          ? Promise.resolve({ data: { items: [newest], count: 51, remaining: 1, hasMore: true } })
          : Promise.reject(new Error('history unavailable'));
      }
      return Promise.resolve({ data: recap });
    });
    renderPage();

    const more = await screen.findByRole('button', { name: 'Show more settled · 1 remaining' });
    more.focus();
    fireEvent.click(more);
    more.blur();
    const retry = await screen.findByRole('button', { name: 'Retry' });
    await waitFor(() => expect(retry).toHaveFocus());
  });

  test('keeps an unseen older ruling available after a newest ruling arrives', async () => {
    const firstPage = Array.from({ length: 50 }, (_, index) => ({
      id: `decision-visible-${index}`, kind: 'decision', title: `Visible decision ${index}`, detail: 'A ruling',
      podId: 'pod-1', podName: 'Launch pod', messageId: String(800 - index), options: [{ label: 'Keep' }], status: 'ruled',
      ruling: { value: 'Keep', by: 'You' },
    }));
    const priorOlder = {
      id: 'decision-prior-older', kind: 'decision', title: 'Prior older decision', detail: 'A ruling',
      podId: 'pod-1', podName: 'Launch pod', messageId: '749', options: [{ label: 'Keep' }], status: 'ruled',
      ruling: { value: 'Keep', by: 'You' },
    };
    const newestArrival = { ...firstPage[0], id: 'decision-arrival', title: 'Newest arrival', messageId: '801' };
    const unseenOlder = {
      id: 'decision-unseen-older', kind: 'decision', title: 'Unseen older decision', detail: 'A ruling',
      podId: 'pod-1', podName: 'Launch pod', messageId: '700', options: [{ label: 'Keep' }], status: 'ruled',
      ruling: { value: 'Keep', by: 'You' },
    };
    let historyReads = 0;
    mockGet.mockImplementation((url: string, config?: any) => {
      if (url === '/api/activity/decision-queue') return Promise.resolve({ data: { items: [], count: 0, countsByPod: {} } });
      if (url === '/api/activity/decision-history') {
        historyReads += 1;
        if (historyReads === 1) return Promise.resolve({ data: { items: firstPage, count: 51, remaining: 1, hasMore: true } });
        if (historyReads === 2) return Promise.resolve({ data: { items: [priorOlder], count: 51, remaining: 0, hasMore: false } });
        if (historyReads === 3) return Promise.resolve({ data: { items: [newestArrival, ...firstPage.slice(0, 49)], count: 53, remaining: 3, hasMore: true } });
        expect(config?.params?.offset).toBe(51);
        return Promise.resolve({ data: { items: [unseenOlder], count: 53, remaining: 0, hasMore: false } });
      }
      return Promise.resolve({ data: recap });
    });
    renderPage();

    expect(await screen.findByText('Visible decision 0')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show more settled · 1 remaining' }));
    expect(await screen.findByText('Prior older decision')).toBeInTheDocument();
    globalThis.window.dispatchEvent(new Event(ATTENTION_CHANGED));
    expect(await screen.findByRole('button', { name: 'Show more settled · 1 remaining' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show more settled · 1 remaining' }));
    expect(await screen.findByText('Unseen older decision')).toBeInTheDocument();
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

  test('0 open asks with a ruled history item: the dashed panel and its time line render first, the settled card under it, no kicker', async () => {
    const ruledAt = new Date(Date.now() - 41 * 60000).toISOString();
    mockGet.mockImplementation((url: string) => {
      if (url === '/api/activity/decision-queue') return Promise.resolve({ data: { items: [], count: 0, countsByPod: {}, remaining: 0 } });
      if (url === '/api/activity/decision-history') return Promise.resolve({ data: { items: [
        { id: 'd-old', kind: 'decision', title: 'Settled earlier', detail: 'x', podId: 'pod-1', podName: 'Launch pod', options: [{ label: 'A' }], status: 'ruled', ruling: { value: 'A', by: 'sam', at: ruledAt }, createdAt: ruledAt },
      ], count: 1, remaining: 0 } });
      return Promise.resolve({ data: recap });
    });
    renderPage();
    const panel = (await screen.findByText('Nothing needs you.')).closest('.v2-activity__empty') as HTMLElement;
    expect(within(panel).getByText('The last ask was answered 41m ago.')).toBeInTheDocument();
    const settled = await screen.findByText('Settled earlier');
    // Panel first, settled card under it.
    expect(panel.compareDocumentPosition(settled) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByText(/oldest first/)).not.toBeInTheDocument();
  });

  test('every ask carries one line mark named by its kind, never a filled square (d215 activity)', async () => {
    renderPage();
    await screen.findByText('Review requested');
    const marks = [...document.querySelectorAll('.v2-activity__queue-mark')];
    expect(marks).toHaveLength(2);
    expect(screen.getByRole('img', { name: 'mention' })).toHaveClass('v2-activity__queue-mark');
    expect(screen.getByRole('img', { name: 'decision' })).toHaveClass('v2-activity__queue-mark');
    for (const mark of marks) expect(mark.className).toBe('v2-activity__queue-mark');
    // Both asks are rows of one list, not a stack of cards.
    expect(document.querySelectorAll('.v2-activity__queue > article')).toHaveLength(2);
  });

  test('a desktop row keeps its secondary acts in the hover cluster beside its one key', async () => {
    const approval = { id: 'approval-9', kind: 'approval', title: 'Approval requested', detail: 'Deploy.', podId: 'pod-1', podName: 'Launch pod', createdAt: '2026-08-26T08:00:00.000Z' };
    mockGet.mockImplementation((url: string) => Promise.resolve({ data: url === '/api/activity/decision-queue'
      ? { ...decisionQueue, items: [...decisionQueue.items, approval], count: 3 } : recap }));
    renderPage();
    const mention = (await screen.findByText('Review requested')).closest('article') as HTMLElement;
    const cluster = mention.querySelector('.v2-activity__hv') as HTMLElement;
    expect(within(cluster).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual(['Mark handled', 'Open']);
    // The key follows the cluster in the DOM, so Tab reaches Reply first; CSS draws the cluster before it.
    const reply = within(mention).getByRole('button', { name: 'Reply' });
    expect(reply.compareDocumentPosition(cluster) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const approvalRow = screen.getByText('Approval requested').closest('article') as HTMLElement;
    expect(within(approvalRow.querySelector('.v2-activity__hv') as HTMLElement).getAllByRole('button').map((b) => b.getAttribute('aria-label')))
      .toEqual(['Deny', 'Open pod']);
    expect(within(approvalRow).getByRole('button', { name: 'Approve' })).toHaveClass('v2p-b-s');
    // No ⋯ menu at desktop, and the decision row's Open sits beside the row, not in a cluster.
    expect(screen.queryByRole('button', { name: 'More actions' })).not.toBeInTheDocument();
    const decision = screen.getByText('Choose the eslint scope').closest('article') as HTMLElement;
    expect(decision.querySelector('.v2-activity__hv')).toBeNull();
    expect(within(decision).getByRole('button', { name: 'Open' })).toBeInTheDocument();
  });

  test('the composer is one line until its text area takes focus, and stays open while it holds a draft', async () => {
    renderPage();
    const box = await screen.findByRole('textbox', { name: i18n.t('activity.compose.placeholder') });
    const composer = box.closest('section') as HTMLElement;
    expect(composer).not.toHaveClass('v2-activity__compose--open');
    expect(box).toHaveAttribute('rows', '1');
    fireEvent.focus(box);
    expect(composer).toHaveClass('v2-activity__compose--open');
    expect(box).toHaveAttribute('rows', '2');
    fireEvent.blur(box, { relatedTarget: document.body });
    expect(composer).not.toHaveClass('v2-activity__compose--open');
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: 'Draft' } });
    fireEvent.blur(box, { relatedTarget: document.body });
    expect(composer).toHaveClass('v2-activity__compose--open');
    // Focus moving to the destination key inside the composer keeps it open.
    fireEvent.change(box, { target: { value: '' } });
    fireEvent.focus(box);
    fireEvent.blur(box, { relatedTarget: composer.querySelector('.v2-activity__compose-picker-button') });
    expect(composer).toHaveClass('v2-activity__compose--open');
  });

  test('the ruled line is text only, with no ✓ glyph', async () => {
    expect(i18n.t('activity.decision.ruled', { by: 'You', value: 'Ship now', lng: 'en' })).toBe('You ruled: Ship now');
    expect(i18n.t('activity.decision.ruled', { by: 'sam', value: 'A', lng: 'zh-CN' })).toBe('sam 已裁定：A');
  });

  describe('at phone width', () => {
    let original: typeof window.matchMedia;
    beforeEach(() => {
      original = window.matchMedia;
      window.matchMedia = ((query: string) => ({
        matches: query === '(max-width: 760px)', media: query, onchange: null,
        addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
      })) as unknown as typeof window.matchMedia;
    });
    afterEach(() => { window.matchMedia = original; });

    test('the head holds only the title and count; the window and scope are one row in the page', async () => {
      renderPage();
      await screen.findByText('Review requested');
      const head = screen.getByRole('heading', { name: 'Activity' }).closest('header') as HTMLElement;
      expect(within(head).queryByRole('radiogroup')).not.toBeInTheDocument();
      const controls = screen.getByRole('group', { name: 'Activity controls' });
      expect(head).not.toContainElement(controls);
      expect(within(controls).getByRole('radio', { name: 'Today' })).toBeInTheDocument();
      expect(controls.querySelector('.v2-activity__scope-button')).toHaveTextContent('All pods');
      // The order text gives way on a phone; the count stays.
      expect(screen.getByLabelText('2 waiting on you')).toBeInTheDocument();
      expect(screen.queryByText('· oldest first')).not.toBeInTheDocument();
    });

    test('a row\'s secondary acts live behind its ⋯ key, and the menu runs them', async () => {
      let reads = 0;
      mockGet.mockImplementation((url: string) => Promise.resolve({ data: url === '/api/activity/decision-queue'
        ? (++reads === 1 ? { ...decisionQueue, items: [decisionQueue.items[0]], count: 1 } : { items: [], count: 0, countsByPod: {} })
        : recap }));
      mockPost.mockResolvedValue({ data: { success: true } });
      renderPage();
      const row = (await screen.findByText('Review requested')).closest('article') as HTMLElement;
      expect(row.querySelector('.v2-activity__hv')).toBeNull();
      expect(within(row).queryByRole('button', { name: 'Mark handled' })).not.toBeInTheDocument();
      const more = within(row).getByRole('button', { name: 'More actions' });
      expect(more).toHaveAttribute('aria-expanded', 'false');
      fireEvent.click(more);
      const menu = within(row).getByRole('menu');
      expect(within(menu).getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Mark handled', 'Open']);
      fireEvent.keyDown(menu, { key: 'Escape' });
      expect(within(row).queryByRole('menu')).not.toBeInTheDocument();
      expect(more).toHaveFocus();
      fireEvent.click(more);
      fireEvent.click(within(within(row).getByRole('menu')).getByRole('menuitem', { name: 'Mark handled' }));
      await waitFor(() => expect(mockPost).toHaveBeenCalledWith('/api/activity/attention-1/acknowledge', {}, expect.anything()));
    });
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
    // The kind is a mark now (direction A): its word is the mark's accessible name; the kicker is pod · time.
    expect(screen.getByRole('img', { name: 'handoff' })).toBeInTheDocument();
    expect(screen.getByText(/^launch pod · /)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Mark handled' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Rule:/ })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Mark handled' }));
    await waitFor(() => expect(mockPost).toHaveBeenCalledWith(
      '/api/activity/attention-handoff-1/acknowledge',
      {},
      expect.objectContaining({ headers: expect.any(Object) }),
    ));
    expect(await screen.findByText('Nothing needs you.')).toBeInTheDocument();
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
    expect(await screen.findByText('Nothing needs you.')).toBeInTheDocument();
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

  test('counts the active queue scope beside its label, with the order and no hint', async () => {
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

    // The order rides the label's right edge as plain text; no (i) hint carries it any more.
    expect(await screen.findByText('· oldest first')).toBeInTheDocument();
    expect(screen.getByLabelText('56 waiting on you')).toHaveTextContent('56');
    expect(screen.queryByRole('button', { name: /about/i })).not.toBeInTheDocument();
    chooseScope('GTM Programs');
    expect(await screen.findByLabelText('9 waiting on you')).toHaveTextContent('9');
    expect(document.querySelector('.v2-activity__scope-button')).toHaveTextContent('GTM Programs');
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
    // Needs you never folds (66311): the second page loads itself, with no
    // Show more control and no focus move — the reader did not ask for it.
    expect(await screen.findByText('Mention 55')).toBeInTheDocument();
    expect(document.querySelector('[data-activity-item-id="mention-50"]')).not.toHaveFocus();
    expect(screen.queryByRole('button', { name: /Show more/ })).not.toBeInTheDocument();
    expect(document.querySelectorAll('.v2-activity__queue-row')).toHaveLength(56);
    // Between pages no control renders either: the fetch stays under the fold (66405 miss 8).
    expect(document.querySelector('.v2-activity__queue-more')).toBeNull();
    // The one count: the rendered rows equal the ledger's number.
    expect(screen.getByLabelText('56 waiting on you')).toHaveTextContent('56');
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
    chooseScope('GTM Programs');
    expect(await screen.findByText('GTM 8')).toBeInTheDocument();
    expect(screen.queryByText('Nothing needs you.')).not.toBeInTheDocument();
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
    chooseScope('GTM Programs');
    await waitFor(() => expect(resolveScoped).not.toBeNull());
    chooseScope('All pods');
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
    expect(screen.queryByText('Nothing needs you.')).not.toBeInTheDocument();
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
    chooseScope('GTM Programs');
    await screen.findByRole('button', { name: 'Retry' });
    expect(document.querySelector('.v2-activity__scope-button')).toHaveTextContent('GTM Programs');
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
    expect(await screen.findByRole('button', { name: 'Retry' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Append 50')).toBeInTheDocument();
    expect(appendReads).toBe(2);
  });

  test('returns focus to the composer picker after selecting a destination', async () => {
    const activityRecap = { ...recap, pods: [...recap.pods, { id: 'pod-2', name: 'GTM Programs' }] };
    mockGet.mockImplementation((url: string) => Promise.resolve({ data: url === '/api/activity/decision-queue' ? decisionQueue : activityRecap }));
    renderPage();
    await screen.findByRole('textbox', { name: i18n.t('activity.compose.placeholder') });
    const picker = document.querySelector<HTMLButtonElement>('.v2-activity__compose-picker-button');
    expect(picker).not.toBeNull();
    fireEvent.click(picker);
    fireEvent.click(within(screen.getByRole('listbox')).getByRole('option', { name: 'GTM Programs' }));
    await waitFor(() => expect(picker).toHaveFocus());
  });

  test('supports keyboard destination selection without losing the draft', async () => {
    const activityRecap = { ...recap, pods: [...recap.pods, { id: 'pod-2', name: 'GTM Programs' }] };
    mockGet.mockImplementation((url: string) => Promise.resolve({ data: url === '/api/activity/decision-queue' ? decisionQueue : activityRecap }));
    renderPage();
    const compose = await screen.findByRole('textbox', { name: i18n.t('activity.compose.placeholder') });
    fireEvent.change(compose, { target: { value: 'Keep this draft' } });
    const picker = document.querySelector<HTMLButtonElement>('.v2-activity__compose-picker-button');
    expect(picker).not.toBeNull();
    fireEvent.keyDown(picker, { key: 'ArrowDown' });
    const options = within(screen.getByRole('listbox')).getAllByRole('option');
    await waitFor(() => expect(options[0]).toHaveFocus());
    fireEvent.keyDown(options[0], { key: 'ArrowDown' });
    await waitFor(() => expect(options[1]).toHaveFocus());
    fireEvent.keyDown(options[1], { key: 'Enter' });
    await waitFor(() => expect(picker).toHaveFocus());
    expect(picker).toHaveTextContent('GTM Programs');
    expect(compose).toHaveValue('Keep this draft');
  });

  test('closes the destination menu on Escape without blurring its trigger', async () => {
    const activityRecap = { ...recap, pods: [...recap.pods, { id: 'pod-2', name: 'GTM Programs' }] };
    mockGet.mockImplementation((url: string) => Promise.resolve({ data: url === '/api/activity/decision-queue' ? decisionQueue : activityRecap }));
    renderPage();
    await screen.findByRole('textbox', { name: i18n.t('activity.compose.placeholder') });
    const picker = document.querySelector<HTMLButtonElement>('.v2-activity__compose-picker-button');
    expect(picker).not.toBeNull();
    fireEvent.click(picker);
    const option = within(screen.getByRole('listbox')).getByRole('option', { name: 'GTM Programs' });
    option.focus();
    fireEvent.keyDown(option, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(picker).toHaveFocus();
  });

  test('keeps the trigger focused when Escape closes an open destination menu', async () => {
    const activityRecap = { ...recap, pods: [...recap.pods, { id: 'pod-2', name: 'GTM Programs' }] };
    mockGet.mockImplementation((url: string) => Promise.resolve({ data: url === '/api/activity/decision-queue' ? decisionQueue : activityRecap }));
    renderPage();
    await screen.findByRole('textbox', { name: i18n.t('activity.compose.placeholder') });
    const picker = document.querySelector<HTMLButtonElement>('.v2-activity__compose-picker-button');
    expect(picker).not.toBeNull();
    picker.focus();
    fireEvent.click(picker);
    fireEvent.keyDown(picker, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(picker).toHaveFocus();
  });

  test('closes the destination menu on an outside mouse or touch press', async () => {
    const activityRecap = { ...recap, pods: [...recap.pods, { id: 'pod-2', name: 'GTM Programs' }] };
    mockGet.mockImplementation((url: string) => Promise.resolve({ data: url === '/api/activity/decision-queue' ? decisionQueue : activityRecap }));
    renderPage();
    await screen.findByRole('textbox', { name: i18n.t('activity.compose.placeholder') });
    const picker = document.querySelector<HTMLButtonElement>('.v2-activity__compose-picker-button');
    expect(picker).not.toBeNull();
    fireEvent.click(picker);
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    fireEvent.click(picker);
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    fireEvent.touchStart(document.body);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  test('every pod is in the one scope select, and a choice returns focus to it (d215 activity)', async () => {
    const extraPods = [2, 3, 4].map((id) => ({ id: `pod-${id}`, name: `Pod ${id}` }));
    mockGet.mockImplementation((url: string) => Promise.resolve({ data: url === '/api/activity/decision-queue' ? decisionQueue : { ...recap, pods: [...recap.pods, ...extraPods] } }));
    renderPage();
    await screen.findByText('Review requested');
    const scope = document.querySelector('.v2-activity__scope-button') as HTMLButtonElement;
    expect(scope).toHaveTextContent('All pods');
    expect(scope).toHaveAttribute('aria-haspopup', 'listbox');
    // No pill row: the pods are not buttons in the head until the select opens.
    expect(screen.queryByRole('button', { name: 'Pod 4', exact: true })).not.toBeInTheDocument();
    fireEvent.click(scope);
    const list = screen.getByRole('listbox', { name: 'Pod scope' });
    expect(within(list).getAllByRole('option').map((option) => option.textContent)).toEqual(['All pods', 'Launch pod', 'Pod 2', 'Pod 3', 'Pod 4']);
    const choice = within(list).getByRole('option', { name: 'Pod 4' });
    choice.focus();
    fireEvent.click(choice);
    expect(scope).toHaveTextContent('Pod 4');
    expect(scope).toHaveAttribute('aria-expanded', 'false');
    await waitFor(() => expect(scope).toHaveFocus());
    await waitFor(() => expect(mockGet).toHaveBeenCalledWith('/api/activity/recap', expect.objectContaining({ params: { window: 'today', podId: 'pod-4' } })));
    fireEvent.click(scope);
    fireEvent.keyDown(within(screen.getByRole('listbox', { name: 'Pod scope' })).getByRole('option', { name: 'Pod 3' }), { key: 'Escape' });
    expect(scope).toHaveAttribute('aria-expanded', 'false');
    expect(scope).toHaveFocus();
  });

  test('paginates all moved-forward lines in twenty-line batches and retains keyboard focus', async () => {
    const updates = Array.from({ length: 45 }, (_, index) => ({
      id: `moved-${index}`, podId: 'pod-1', podName: 'Launch pod', content: `Moved ${index}`, timestamp: `2026-08-26T11:${String(index).padStart(2, '0')}:00.000Z`,
    }));
    mockGet.mockImplementation((url: string) => Promise.resolve({ data: url === '/api/activity/decision-queue' ? decisionQueue : { ...recap, agents: [{ ...recap.agents[0], updates }] } }));
    renderPage();
    const more = await screen.findByRole('button', { name: '17 more in launch pod' });
    const group = more.closest('article');
    const lines = () => group.querySelectorAll('.v2-activity__moved-line');
    expect(lines()).toHaveLength(3);
    fireEvent.click(more);
    expect(lines()).toHaveLength(20);
    fireEvent.click(within(group).getByRole('button', { name: '20 more in launch pod' }));
    expect(lines()).toHaveLength(40);
    const lastMore = within(group).getByRole('button', { name: '6 more in launch pod' });
    lastMore.focus();
    fireEvent.click(lastMore);
    expect(lines()).toHaveLength(46);
    for (const update of updates) expect(within(group).getByText(update.content)).toBeInTheDocument();
    const less = within(group).getByRole('button', { name: 'Show less' });
    await waitFor(() => expect(less).toHaveFocus());
    fireEvent.click(less);
    expect(lines()).toHaveLength(3);
    await waitFor(() => expect(within(group).getByRole('button', { name: '17 more in launch pod' })).toHaveFocus());
  });

  test('a Moved forward line reads an agent post as one plain line, not raw markdown', async () => {
    expect(plainLine('F82 walk — **correction:** the [Atlassian tools](https://x.test) are *on*\n\n- one\n- `two`')).toBe('F82 walk — correction: the Atlassian tools are on one two');
    expect(plainLine('## Shipped\n> quoted __done__ ~~old~~')).toBe('Shipped quoted done old');
    expect(plainLine('see ```js\nconst a = 1;\n``` then 2 * 3 = 6')).toBe('see then 2 * 3 = 6');
    expect(plainLine('snake_case_name stays')).toBe('snake_case_name stays');
    // The recap clips at 180: a clipped post drops the half-open mark and ends on an ellipsis.
    const clipped = `What I saw:\n- \`atlassian_search ${'x'.repeat(200)}`.slice(0, 180);
    expect(plainLine(clipped)).toMatch(/^What I saw: atlassian_search x+…$/);
    expect(plainLine('Short and done.')).toBe('Short and done.');
    expect(plainLine('What I saw: - `atla')).toBe('What I saw: atla');
    expect(plainLine('pages 2 - 4 moved')).toBe('pages 2 - 4 moved');
    // The shape agent posts arrive in: whitespace already folded by the recap.
    expect(plainLine('Done: - a - b - c ## Shipped **ok**')).toBe('Done: a - b - c Shipped ok');
    expect(plainLine('```\nlog line\n```')).toBe('log line');
    // Folded, as agent posts arrive: the fence ends where its closing marks are, not at the end.
    expect(plainLine('Before ```js code ``` after')).toBe('Before after');
    expect(plainLine('```sh npm test```')).toBe('npm test');
    expect(plainLine('中_文_字 and __init__.py stay')).toBe('中_文_字 and __init__.py stay');
    const link = `${'y'.repeat(160)} see [the doc](https://example.com/aaaaaaaaaaaa`.slice(0, 180);
    expect(plainLine(link)).toMatch(/ see the doc…$/);
    const emoji = `${'x'.repeat(179)}🎉`.slice(0, 180);
    expect(plainLine(emoji)).toBe(`${'x'.repeat(179)}…`);
    const updates = [{ id: 'md-1', podId: 'pod-1', podName: 'Launch pod', content: '**Walked** the [connectors](https://x.test) page\n\n- all green', timestamp: '2026-08-26T11:00:00.000Z' }];
    mockGet.mockImplementation((url: string) => Promise.resolve({ data: url === '/api/activity/decision-queue' ? decisionQueue : { ...recap, agents: [{ ...recap.agents[0], updates }], board: [] } }));
    renderPage();
    expect(await screen.findByText('Walked the connectors page all green')).toBeInTheDocument();
    expect(screen.queryByText(/\*\*/)).toBeNull();
    // The clamp hides the end of a long line; the whole line stays in the title.
    expect(screen.getByText('Walked the connectors page all green').closest('.v2-activity__moved-text')).toHaveAttribute('title', expect.stringContaining('Walked the connectors page all green'));
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
