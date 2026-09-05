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
    expect(screen.getByText('Choose the workspace cutover')).toBeInTheDocument();
    expect(screen.queryByText('Choose one of the following approaches in prose.')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Ship the rebuilt workspace' }));
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
});
