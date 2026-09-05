// @ts-nocheck
import React, { useState } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import V2Thread from '../components/V2Thread';
import { AuthContext } from '../../context/AuthContext';

let mockSocketValue = { socket: null, connected: false };
jest.mock('../../context/SocketContext', () => ({
  useSocket: () => mockSocketValue,
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
  mockSocketValue = { socket: null, connected: false };
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

const DEFAULT_AGENTS = [{
  agentName: 'openclaw', instanceId: 'aria', displayName: 'Aria', status: 'active',
}];

const DeliveryHarness = ({ response, sendSpy, agents = DEFAULT_AGENTS }) => {
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
    agents,
    sendMessage,
    loading: false,
    error: null,
    refresh: jest.fn(),
  };
  return <V2Thread detail={detail} />;
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

describe('V2Thread agent delivery hint', () => {
  test('shows a real-agent example after a zero-enqueued send', async () => {
    const response = makeMessage('hello room', {
      enqueued: 0, implicit: [], agentsInPod: 1,
    });
    renderHarness(response);

    sendDraft('hello room');

    const hint = await screen.findByRole('status');
    expect(hint).toHaveTextContent('No agent was notified');
    // A human-chosen instanceId ("aria") IS the identity — it stays the
    // handle; agentName ("openclaw") is the runtime label we never surface.
    expect(hint).toHaveTextContent('@aria');
    expect(sessionStorage.getItem('v2.agentDeliveryHint.pod-1')).toBe('1');
  });

  test('an opaque per-user instance token is never the suggested handle', async () => {
    // The u+sha10 convention (and its legacy long form) is a machine key.
    // The backend resolves the bare agentName for single-install agents, so
    // "@guide" both reads right and lands — "@u3f9c2a1b7d" does neither.
    const response = makeMessage('hello guide', {
      enqueued: 0, implicit: [], agentsInPod: 1,
    });
    render(
      <AuthContext.Provider value={authValue}>
        <MemoryRouter>
          <DeliveryHarness
            response={response}
            sendSpy={jest.fn()}
            agents={[{
              agentName: 'guide', instanceId: 'u3f9c2a1b7d', displayName: 'Guide', status: 'active',
            }]}
          />
        </MemoryRouter>
      </AuthContext.Provider>,
    );

    sendDraft('hello guide');

    const hint = await screen.findByRole('status');
    expect(hint).toHaveTextContent('@guide');
    expect(hint).not.toHaveTextContent('u3f9c2a1b7d');
  });

  test('a persona displayName becomes the suggested handle for opaque-token agents', async () => {
    // Scout (agentName 'guide', displayName 'Scout') — the handle should be
    // the persona slug @scout, not the internal agentName. The backend
    // mention map indexes displaySlug for every installation, so it lands.
    const response = makeMessage('hello scout', {
      enqueued: 0, implicit: [], agentsInPod: 1,
    });
    render(
      <AuthContext.Provider value={authValue}>
        <MemoryRouter>
          <DeliveryHarness
            response={response}
            sendSpy={jest.fn()}
            agents={[{
              agentName: 'guide', instanceId: 'u3f9c2a1b7d', displayName: 'Scout', status: 'active',
            }]}
          />
        </MemoryRouter>
      </AuthContext.Provider>,
    );

    sendDraft('hello scout');

    const hint = await screen.findByRole('status');
    expect(hint).toHaveTextContent('@scout');
    expect(hint).not.toHaveTextContent('u3f9c2a1b7d');
    expect(hint).not.toHaveTextContent('@guide');
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
    ['a wake-on-message agent was woken (#914)', {
      enqueued: 0, implicit: [], agentsInPod: 1, woken: 1,
    }],
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

  test('clears the visible hint the moment an agent starts typing (#914)', async () => {
    const handlers = {};
    mockSocketValue = {
      socket: {
        on: (event, fn) => { handlers[event] = fn; },
        off: jest.fn(),
        emit: jest.fn(),
      },
      connected: true,
    };
    const response = makeMessage('hello room', {
      enqueued: 0, implicit: [], agentsInPod: 1,
    });
    renderHarness(response);

    sendDraft('hello room');
    const hint = await screen.findByRole('status');
    expect(hint).toHaveTextContent('No agent was notified');

    act(() => {
      handlers.agent_typing_start({ podId: 'pod-1', agentName: 'guide', displayName: 'Guide' });
    });

    await waitFor(() => {
      expect(screen.queryByText(/No agent was notified/i)).not.toBeInTheDocument();
    });
  });
});
