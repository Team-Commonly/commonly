// @ts-nocheck
import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import V2Thread from '../components/V2Thread';
import { AuthContext } from '../../context/AuthContext';

const mockGet = jest.fn();
const mockPost = jest.fn();

jest.mock('axios', () => ({
  __esModule: true,
  default: {
    get: (...args) => mockGet(...args),
    post: (...args) => mockPost(...args),
    patch: jest.fn(),
    put: jest.fn(),
    delete: jest.fn(),
    defaults: { baseURL: '', headers: { common: {} } },
    interceptors: {
      request: { use: jest.fn(), eject: jest.fn() },
      response: { use: jest.fn(), eject: jest.fn() },
    },
  },
}));

jest.mock('../../context/SocketContext', () => ({
  useSocket: () => ({ socket: null, connected: false }),
}));

jest.mock('../components/V2Avatar', () => {
  const MockAvatar = () => <span data-testid="avatar" />;
  MockAvatar.displayName = 'MockAvatar';
  return MockAvatar;
});

beforeAll(() => { Element.prototype.scrollIntoView = jest.fn(); });

const auth = {
  currentUser: { _id: 'human-1', username: 'lily' },
  user: { _id: 'human-1', username: 'lily' },
  token: 'token', loading: false, error: null, isAuthenticated: true,
  register: jest.fn(), login: jest.fn(), logout: jest.fn(), updateProfile: jest.fn(),
};

const detail = {
  pod: { _id: 'pod-1', name: 'Sharpen', description: 'Make the next cut', type: 'chat' },
  members: [{ _id: 'human-1', username: 'lily', isBot: false }],
  agents: [],
  messages: [{
    id: '42', pod_id: 'pod-1', user_id: 'agent-1',
    user: { username: 'sprint-impl', isBot: true },
    content: 'Choose one of the following approaches in prose.',
    message_type: 'text', created_at: '2026-09-05T12:00:00.000Z',
  }],
  sendMessage: jest.fn(), loading: false, error: null, sendError: null,
  hasMore: false, loadingOlder: false, loadOlder: jest.fn(), refresh: jest.fn(),
};

describe('V2Thread decision cards', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGet.mockImplementation((url) => {
      if (url === '/api/activity/decision-queue') {
        return Promise.resolve({ data: { items: [{
          id: 'decision-42', kind: 'decision', podId: 'pod-1', messageId: '42',
          actorName: 'Sprint impl', title: 'Choose the workspace cutover',
          detail: 'Which implementation should ship?',
          options: [{ label: 'Ship the rebuilt workspace', recommended: true }],
        }] } });
      }
      if (url === '/api/activity/decision-history') return Promise.resolve({ data: { items: [] } });
      return Promise.resolve({ data: {} });
    });
    mockPost.mockResolvedValue({ data: { decision: { ruling: {
      value: 'Ship the rebuilt workspace', by: 'Lily', messageId: 'ruling-42', at: '2026-09-05T12:01:00.000Z',
    } } } });
  });

  test('replaces the decision request prose at its durable message position with a live card', async () => {
    const onDecisionSettled = jest.fn();
    render(
      <AuthContext.Provider value={auth}>
        <MemoryRouter><V2Thread detail={detail} onDecisionSettled={onDecisionSettled} /></MemoryRouter>
      </AuthContext.Provider>,
    );

    expect(await screen.findByTestId('decision-card')).toBeInTheDocument();
    expect(mockGet).toHaveBeenCalledWith('/api/activity/decision-queue', expect.objectContaining({
      params: { podId: 'pod-1', limit: 50, offset: 0, messageIds: '42' },
    }));
    expect(mockGet).toHaveBeenCalledWith('/api/activity/decision-history', expect.objectContaining({
      params: { podId: 'pod-1', limit: 50, offset: 0, messageIds: '42' },
    }));
    expect(screen.getByText('Choose the workspace cutover')).toBeInTheDocument();
    expect(screen.queryByText('Choose one of the following approaches in prose.')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Rule: Ship the rebuilt workspace (Recommended)' }));
    await waitFor(() => expect(mockPost).toHaveBeenCalledWith(
      '/api/activity/decisions/decision-42/choose',
      { value: 'Ship the rebuilt workspace' },
      expect.anything(),
    ));
    const ruling = await screen.findByTestId('decision-ruling-row');
    expect(ruling).toHaveTextContent('Lily');
    expect(ruling).toHaveTextContent('ruled');
    expect(ruling).toHaveTextContent('Ship the rebuilt workspace');
    expect(screen.queryByTestId('decision-card')).not.toBeInTheDocument();
    expect(onDecisionSettled).toHaveBeenCalledTimes(1);
  });

  test('restores a settled card from durable history after leave and return', async () => {
    const settled = {
      id: 'decision-42', kind: 'decision', podId: 'pod-1', messageId: '42',
      title: 'Choose the workspace cutover', detail: 'Which implementation should ship?',
      options: [{ label: 'Ship the rebuilt workspace' }, { label: 'Keep the legacy chat' }],
      status: 'ruled', ruling: {
        value: 'Ship the rebuilt workspace', by: 'Lily', messageId: 'ruling-42', at: '2026-09-05T12:01:00.000Z',
      },
    };
    mockGet.mockImplementation((url) => {
      if (url === '/api/activity/decision-queue') return Promise.resolve({ data: { items: [] } });
      if (url === '/api/activity/decision-history') return Promise.resolve({ data: { items: [settled] } });
      return Promise.resolve({ data: {} });
    });

    const first = render(
      <AuthContext.Provider value={auth}>
        <MemoryRouter><V2Thread detail={detail} /></MemoryRouter>
      </AuthContext.Provider>,
    );
    expect(await screen.findByTestId('decision-ruling-row')).toHaveTextContent('Ship the rebuilt workspace');
    first.unmount();

    render(
      <AuthContext.Provider value={auth}>
        <MemoryRouter><V2Thread detail={detail} /></MemoryRouter>
      </AuthContext.Provider>,
    );
    expect(await screen.findByTestId('decision-ruling-row')).toHaveTextContent('Lily');
    expect(screen.queryByTestId('decision-card')).not.toBeInTheDocument();
  });

  test('keeps a settled card visible when a later history refresh fails', async () => {
    const settled = {
      id: 'decision-42', kind: 'decision', podId: 'pod-1', messageId: '42',
      title: 'Choose the workspace cutover', detail: 'Which implementation should ship?',
      options: [{ label: 'Ship the rebuilt workspace' }, { label: 'Keep the legacy chat' }],
      status: 'ruled', ruling: {
        value: 'Ship the rebuilt workspace', by: 'Lily', messageId: 'ruling-42', at: '2026-09-05T12:01:00.000Z',
      },
    };
    let historyReads = 0;
    mockGet.mockImplementation((url) => {
      if (url === '/api/activity/decision-queue') return Promise.resolve({ data: { items: [] } });
      if (url === '/api/activity/decision-history') {
        historyReads += 1;
        return historyReads === 1
          ? Promise.resolve({ data: { items: [settled] } })
          : Promise.reject(new Error('history unavailable'));
      }
      return Promise.resolve({ data: {} });
    });

    jest.useFakeTimers();
    try {
      render(
        <AuthContext.Provider value={auth}>
          <MemoryRouter><V2Thread detail={detail} /></MemoryRouter>
        </AuthContext.Provider>,
      );
      expect(await screen.findByTestId('decision-ruling-row')).toHaveTextContent('Ship the rebuilt workspace');
      expect(historyReads).toBe(1);

      await act(async () => {
        jest.advanceTimersByTime(15_000);
        await Promise.resolve();
      });
      await waitFor(() => expect(historyReads).toBe(2));
      expect(screen.getByTestId('decision-ruling-row')).toHaveTextContent('Lily');
      expect(screen.queryByTestId('decision-card')).not.toBeInTheDocument();
    } finally {
      jest.useRealTimers();
    }
  });

  test('preserves Activity landing when hydration replaces the focused source row', async () => {
    const settled = {
      id: 'decision-42', kind: 'decision', podId: 'pod-1', messageId: '42',
      title: 'Choose the workspace cutover', detail: 'Which implementation should ship?',
      options: [{ label: 'Ship the rebuilt workspace' }], status: 'ruled',
      ruling: {
        value: 'Ship the rebuilt workspace', by: 'Lily', messageId: '43', at: '2026-09-05T12:01:00.000Z',
      },
    };
    const pending = { ...settled, status: 'pending', ruling: undefined };
    let historyReads = 0;
    mockGet.mockImplementation((url) => {
      if (url === '/api/activity/decision-queue') return Promise.resolve({ data: { items: [pending] } });
      if (url === '/api/activity/decision-history') {
        historyReads += 1;
        return historyReads === 1
          ? Promise.resolve({ data: { items: [] } })
          : Promise.resolve({ data: { items: [settled] } });
      }
      return Promise.resolve({ data: {} });
    });
    const settledDetail = {
      ...detail,
      messages: [
        ...detail.messages,
        {
          id: '43', pod_id: 'pod-1', user_id: 'human-1',
          user: { username: 'lily', isBot: false }, content: 'Ship the rebuilt workspace',
          message_type: 'text', created_at: '2026-09-05T12:01:00.000Z',
          thread_root_id: '42',
        },
      ],
    };

    jest.useFakeTimers();
    try {
      const { container } = render(
        <AuthContext.Provider value={auth}>
          <MemoryRouter initialEntries={['/v2/pods/pod-1#message-42']}>
            <V2Thread detail={settledDetail} />
          </MemoryRouter>
        </AuthContext.Provider>,
      );
      expect(await screen.findByTestId('decision-card')).toBeInTheDocument();
      await waitFor(() => expect(container.querySelector('#message-42')).toHaveClass('v2-msg--landed'));
      await waitFor(() => expect(historyReads).toBe(1));

      await act(async () => {
        jest.advanceTimersByTime(15_000);
        await Promise.resolve();
      });
      await waitFor(() => expect(container.querySelector('#message-43')).toHaveClass('v2-msg--landed'));
      expect(document.activeElement).toBe(container.querySelector('#message-43'));
    } finally {
      jest.useRealTimers();
    }
  });

  test('preserves deliberate composer focus through settled hydration', async () => {
    const settled = {
      id: 'decision-42', kind: 'decision', podId: 'pod-1', messageId: '42',
      title: 'Choose the workspace cutover', detail: 'Which implementation should ship?',
      options: [{ label: 'Ship the rebuilt workspace' }], status: 'ruled',
      ruling: {
        value: 'Ship the rebuilt workspace', by: 'Lily', messageId: '43', at: '2026-09-05T12:01:00.000Z',
      },
    };
    const pending = { ...settled, status: 'pending', ruling: undefined };
    let historyReads = 0;
    mockGet.mockImplementation((url) => {
      if (url === '/api/activity/decision-queue') return Promise.resolve({ data: { items: [pending] } });
      if (url === '/api/activity/decision-history') {
        historyReads += 1;
        return historyReads === 1
          ? Promise.resolve({ data: { items: [] } })
          : Promise.resolve({ data: { items: [settled] } });
      }
      return Promise.resolve({ data: {} });
    });
    const settledDetail = {
      ...detail,
      messages: [
        ...detail.messages,
        {
          id: '43', pod_id: 'pod-1', user_id: 'human-1',
          user: { username: 'lily', isBot: false }, content: 'Ship the rebuilt workspace',
          message_type: 'text', created_at: '2026-09-05T12:01:00.000Z',
          thread_root_id: '42',
        },
      ],
    };

    jest.useFakeTimers();
    try {
      const { container } = render(
        <AuthContext.Provider value={auth}>
          <MemoryRouter initialEntries={['/v2/pods/pod-1#message-42']}>
            <V2Thread detail={settledDetail} />
          </MemoryRouter>
        </AuthContext.Provider>,
      );
      expect(await screen.findByTestId('decision-card')).toBeInTheDocument();
      await waitFor(() => expect(container.querySelector('#message-42')).toHaveClass('v2-msg--landed'));
      const composer = container.querySelector('textarea');
      expect(composer).toBeTruthy();
      composer.focus();

      await act(async () => {
        jest.advanceTimersByTime(15_000);
        await Promise.resolve();
      });
      await waitFor(() => expect(historyReads).toBe(2));
      expect(composer).toHaveFocus();
      expect(container.querySelector('#message-43')).not.toHaveClass('v2-msg--landed');
    } finally {
      jest.useRealTimers();
    }
  });

  test('returns focus to a failed custom answer instead of skipping to the composer', async () => {
    mockPost.mockRejectedValueOnce(new Error('temporary failure'));
    render(
      <AuthContext.Provider value={auth}>
        <MemoryRouter><V2Thread detail={detail} /></MemoryRouter>
      </AuthContext.Provider>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Other…' }));
    const input = screen.getByRole('textbox', { name: 'Write your ruling…' });
    fireEvent.change(input, { target: { value: 'Hold for customer evidence' } });
    const send = screen.getByRole('button', { name: 'Send ruling' });
    send.focus();
    fireEvent.click(send);
    (document.activeElement as HTMLElement | null)?.blur();

    expect(await screen.findByRole('alert')).toHaveTextContent(/could not be saved/i);
    await waitFor(() => expect(input).toHaveFocus());
    expect(send).not.toBeDisabled();
  });

  test('keeps a pending card visible when a later queue refresh fails', async () => {
    const pending = {
      id: 'decision-42', kind: 'decision', podId: 'pod-1', messageId: '42',
      actorName: 'Sprint impl', title: 'Choose the workspace cutover', detail: 'Which implementation should ship?',
      options: [{ label: 'Ship the rebuilt workspace' }, { label: 'Keep the legacy chat' }],
    };
    let queueReads = 0;
    mockGet.mockImplementation((url) => {
      if (url === '/api/activity/decision-queue') {
        queueReads += 1;
        return queueReads === 1
          ? Promise.resolve({ data: { items: [pending] } })
          : Promise.reject(new Error('queue unavailable'));
      }
      if (url === '/api/activity/decision-history') return Promise.resolve({ data: { items: [] } });
      return Promise.resolve({ data: {} });
    });

    jest.useFakeTimers();
    try {
      render(
        <AuthContext.Provider value={auth}>
          <MemoryRouter><V2Thread detail={detail} /></MemoryRouter>
        </AuthContext.Provider>,
      );
      expect(await screen.findByTestId('decision-card')).toBeInTheDocument();
      expect(queueReads).toBe(1);

      await act(async () => {
        jest.advanceTimersByTime(15_000);
        await Promise.resolve();
      });
      await waitFor(() => expect(queueReads).toBe(2));
      expect(screen.getByTestId('decision-card')).toBeInTheDocument();
      expect(screen.getByText('Choose the workspace cutover')).toBeInTheDocument();
    } finally {
      jest.useRealTimers();
    }
  });

  test('discovers a loaded decision despite unrelated queue overflow', async () => {
    const target = {
      id: 'decision-overflow', kind: 'decision', podId: 'pod-1', messageId: '42',
      title: 'Overflow decision', detail: 'Which implementation should ship?',
      options: [{ label: 'Ship this one' }, { label: 'Keep looking' }],
    };
    mockGet.mockImplementation((url, config) => {
      if (url === '/api/activity/decision-queue') {
        expect(config?.params?.messageIds).toBe('42');
        const offset = config?.params?.offset;
        expect(offset).toBe(0);
        return Promise.resolve({ data: { items: [target], count: 51, remaining: 0, hasMore: false } });
      }
      if (url === '/api/activity/decision-history') return Promise.resolve({ data: { items: [] } });
      return Promise.resolve({ data: {} });
    });
    render(
      <AuthContext.Provider value={auth}>
        <MemoryRouter><V2Thread detail={detail} /></MemoryRouter>
      </AuthContext.Provider>,
    );
    expect(await screen.findByTestId('decision-card')).toBeInTheDocument();
    expect(screen.getByText('Overflow decision')).toBeInTheDocument();
  });

  test('chunks loaded source ids so decisions at both ends of a long transcript remain discoverable', async () => {
    const messages = Array.from({ length: 202 }, (_, index) => ({
      ...detail.messages[0],
      id: String(index),
    }));
    messages[0] = { ...messages[0], id: 'source-first' };
    messages[201] = { ...messages[201], id: 'source-last' };
    const wideDetail = { ...detail, messages };
    const first = {
      id: 'decision-first', kind: 'decision', podId: 'pod-1', messageId: 'source-first',
      title: 'First source decision', detail: 'Which first-end choice?',
      options: [{ label: 'Keep first' }],
    };
    const last = {
      id: 'decision-last', kind: 'decision', podId: 'pod-1', messageId: 'source-last',
      title: 'Last source decision', detail: 'Which last-end choice?',
      options: [{ label: 'Keep last' }],
    };
    const requests = new Map<string, string[]>();
    mockGet.mockImplementation((url, config) => {
      if (url !== '/api/activity/decision-queue' && url !== '/api/activity/decision-history') return Promise.resolve({ data: {} });
      const ids = String(config?.params?.messageIds || '').split(',').filter(Boolean);
      expect(ids.length).toBeLessThanOrEqual(200);
      expect(new Set(ids).size).toBe(ids.length);
      const key = url.endsWith('decision-queue') ? 'queue' : 'history';
      requests.set(`${key}-${requests.size}`, ids);
      const items = key === 'queue'
        ? [first, last].filter((item) => ids.includes(item.messageId))
        : [];
      return Promise.resolve({ data: { items, hasMore: false } });
    });

    render(
      <AuthContext.Provider value={auth}>
        <MemoryRouter><V2Thread detail={wideDetail} /></MemoryRouter>
      </AuthContext.Provider>,
    );

    expect(await screen.findAllByTestId('decision-card')).toHaveLength(2);
    expect(screen.getByText('First source decision')).toBeInTheDocument();
    expect(screen.getByText('Last source decision')).toBeInTheDocument();
    const queueRequests = [...requests.entries()].filter(([key]) => key.startsWith('queue-'));
    const historyRequests = [...requests.entries()].filter(([key]) => key.startsWith('history-'));
    expect(queueRequests).toHaveLength(2);
    expect(historyRequests).toHaveLength(2);
    expect(queueRequests[0][1]).toContain('source-first');
    expect(queueRequests[1][1]).toContain('source-last');
  });

  test('keeps authored option order while labeling a later recommended option', async () => {
    const authored = {
      id: 'decision-authored-order', kind: 'decision', podId: 'pod-1', messageId: '42',
      title: 'Choose the workspace cutover', detail: 'Which implementation should ship?',
      options: [{ label: 'Hold for review' }, { label: 'Ship the rebuilt workspace', recommended: true }],
    };
    mockGet.mockImplementation((url) => {
      if (url === '/api/activity/decision-queue') return Promise.resolve({ data: { items: [authored] } });
      if (url === '/api/activity/decision-history') return Promise.resolve({ data: { items: [] } });
      return Promise.resolve({ data: {} });
    });

    render(
      <AuthContext.Provider value={auth}>
        <MemoryRouter><V2Thread detail={detail} /></MemoryRouter>
      </AuthContext.Provider>,
    );

    const first = await screen.findByRole('button', { name: 'Hold for review' });
    const second = screen.getByRole('button', { name: 'Rule: Ship the rebuilt workspace (Recommended)' });
    expect(first).toHaveClass('v2-decision-card__choice--primary');
    expect(second).not.toHaveClass('v2-decision-card__choice--primary');
    expect(second).not.toHaveTextContent('Recommended');
    expect(within(second.parentElement as HTMLElement).getByText('Recommended')).toBeInTheDocument();
    expect(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
