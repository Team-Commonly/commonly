// @ts-nocheck
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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
      params: { podId: 'pod-1' },
    }));
    expect(mockGet).toHaveBeenCalledWith('/api/activity/decision-history', expect.objectContaining({
      params: { podId: 'pod-1', limit: 50, offset: 0 },
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

  test('discovers a decision in the selected pod beyond the global queue page', async () => {
    const target = {
      id: 'decision-overflow', kind: 'decision', podId: 'pod-1', messageId: '42',
      title: 'Overflow decision', detail: 'Which implementation should ship?',
      options: [{ label: 'Ship this one' }, { label: 'Keep looking' }],
    };
    mockGet.mockImplementation((url, config) => {
      if (url === '/api/activity/decision-queue') {
        expect(config).toEqual(expect.objectContaining({ params: { podId: 'pod-1' } }));
        return Promise.resolve({ data: { items: [target], count: 1, remaining: 0 } });
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
    expect(second).toHaveTextContent('Recommended');
    expect(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
