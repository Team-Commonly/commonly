// @ts-nocheck
import React, { useState } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import V2PodChat from '../components/V2PodChat';
import { AuthContext } from '../../context/AuthContext';

jest.mock('../../context/SocketContext', () => ({
  useSocket: () => ({ socket: null, connected: false }),
}));

jest.mock('axios', () => {
  const mock = {
    get: jest.fn(() => Promise.resolve({ data: {} })),
    post: jest.fn(() => Promise.resolve({ data: {} })),
    patch: jest.fn(),
    delete: jest.fn(),
    defaults: { baseURL: '', headers: { common: {} } },
    interceptors: {
      request: { use: jest.fn(), eject: jest.fn() },
      response: { use: jest.fn(), eject: jest.fn() },
    },
  };
  return { __esModule: true, default: mock, ...mock };
});

beforeAll(() => {
  Element.prototype.scrollIntoView = jest.fn();
});

beforeEach(() => {
  sessionStorage.clear();
});

const authValue = {
  currentUser: { _id: 'u1', username: 'alice' },
  user: { _id: 'u1', username: 'alice' },
  token: 't',
  loading: false,
  error: null,
  isAuthenticated: true,
  register: jest.fn(),
  login: jest.fn(),
  logout: jest.fn(),
  updateProfile: jest.fn(),
};

const makeMessage = (content, agentDelivery) => ({
  id: `message-${content}`,
  pod_id: 'pod-1',
  user_id: 'u1',
  content,
  message_type: 'text',
  created_at: '2026-07-22T12:00:00.000Z',
  user: { username: 'alice' },
  ...(agentDelivery ? { agentDelivery } : {}),
});

const DeliveryHarness = ({ response, sendSpy }) => {
  const [messages, setMessages] = useState([]);
  const sendMessage = async (...args) => {
    sendSpy(...args);
    setMessages((current) => [...current, response]);
    return response;
  };
  const detail = {
    pod: { _id: 'pod-1', name: 'Launch Room', type: 'chat' },
    members: [{ _id: 'u1', username: 'alice', isBot: false }],
    messages,
    agents: [{
      agentName: 'openclaw', instanceId: 'aria', displayName: 'Aria', status: 'active',
    }],
    sendMessage,
    loading: false,
    error: null,
    refresh: jest.fn(),
  };
  return <V2PodChat detail={detail} />;
};

const renderHarness = (response, sendSpy = jest.fn()) => render(
  <AuthContext.Provider value={authValue}>
    <MemoryRouter>
      <DeliveryHarness response={response} sendSpy={sendSpy} />
    </MemoryRouter>
  </AuthContext.Provider>,
);

const sendDraft = (content) => {
  fireEvent.change(screen.getByPlaceholderText(/message launch room/i), {
    target: { value: content },
  });
  fireEvent.click(screen.getByRole('button', { name: /send message/i }));
};

describe('V2PodChat agent delivery hint', () => {
  test('shows a real-agent example after a zero-enqueued send', async () => {
    const response = makeMessage('hello room', {
      enqueued: 0, implicit: [], agentsInPod: 1,
    });
    renderHarness(response);

    sendDraft('hello room');

    const hint = await screen.findByRole('status');
    expect(hint).toHaveTextContent('No agent was notified');
    expect(hint).toHaveTextContent('@aria');
    expect(sessionStorage.getItem('v2.agentDeliveryHint.pod-1')).toBe('1');
  });

  test('shows at most once per pod per browser session', async () => {
    const first = renderHarness(makeMessage('first send', {
      enqueued: 0, implicit: [], agentsInPod: 1,
    }));
    sendDraft('first send');
    await screen.findByRole('status');
    first.unmount();

    renderHarness(makeMessage('second send', {
      enqueued: 0, implicit: [], agentsInPod: 1,
    }));
    sendDraft('second send');
    await screen.findByText('second send');

    expect(screen.queryByText(/No agent was notified/i)).not.toBeInTheDocument();
  });

  test.each([
    ['an agent was enqueued', { enqueued: 1, implicit: [], agentsInPod: 1 }],
    ['the backend omits delivery metadata', undefined],
  ])('stays hidden when %s', async (_label, agentDelivery) => {
    const response = makeMessage('ordinary send', agentDelivery);
    const sendSpy = jest.fn();
    renderHarness(response, sendSpy);

    sendDraft('ordinary send');
    await waitFor(() => expect(sendSpy).toHaveBeenCalledTimes(1));
    await screen.findByText('ordinary send');

    expect(screen.queryByText(/No agent was notified/i)).not.toBeInTheDocument();
  });
});
