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

const DeliveryHarness = ({ response, sendSpy, agents = DEFAULT_AGENTS, podType = 'chat', onOpenInvite }) => {
  const [messages, setMessages] = useState([]);
  const sendMessage = async (...args) => {
    sendSpy(...args);
    setMessages((current) => [...current, response]);
    return response;
  };
  const detail = {
    pod: { _id: 'pod-1', name: 'Launch Room', type: podType },
    members: [{ _id: 'u1', username: 'alice', isBot: false }],
    messages,
    agents,
    sendMessage,
    loading: false,
    error: null,
    refresh: jest.fn(),
  };
  return <V2Thread detail={detail} onOpenInvite={onOpenInvite} />;
};

const harnessElement = (response, sendSpy = jest.fn(), extra = {}) => (
  <AuthContext.Provider value={authValue}>
    <MemoryRouter>
      <DeliveryHarness response={response} sendSpy={sendSpy} {...extra} />
    </MemoryRouter>
  </AuthContext.Provider>
);

const renderHarness = (response, sendSpy = jest.fn(), extra = {}) => render(
  harnessElement(response, sendSpy, extra),
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

  test('a pod with no agent at all says why the send went quiet, and offers the step', async () => {
    const onOpenInvite = jest.fn();
    renderHarness(
      makeMessage('anyone there', { enqueued: 0, implicit: [], agentsInPod: 0 }),
      jest.fn(),
      { agents: [], onOpenInvite },
    );

    sendDraft('anyone there');

    const kicker = await screen.findByText('no agent in this pod');
    expect(screen.getByText(/Nobody here answers yet/)).toBeInTheDocument();
    // The other branch would tell the user to @mention nobody: it needs a
    // handle to suggest, which is exactly why `agentsInPod > 0` gates it.
    expect(screen.queryByText(/No agent was notified/i)).not.toBeInTheDocument();
    // The row sits under the message it is about, not at the end of the pod.
    const row = kicker.closest('.v2-chat__no-agents');
    expect(row.previousElementSibling.textContent).toContain('anyone there');

    fireEvent.click(screen.getByRole('button', { name: 'Add an agent' }));
    // The same sheet the starter panel opens, on its agent tab.
    expect(onOpenInvite).toHaveBeenCalledWith('agent');
    expect(sessionStorage.getItem('v2.noAgentsHint.pod-1')).toBe('1');
  });

  test('the no-agent row shows at most once per pod per browser session', async () => {
    const first = renderHarness(
      makeMessage('first silent send', { enqueued: 0, implicit: [], agentsInPod: 0 }),
      jest.fn(),
      { agents: [], onOpenInvite: jest.fn() },
    );
    sendDraft('first silent send');
    await screen.findByText('no agent in this pod');
    first.unmount();

    renderHarness(
      makeMessage('second silent send', { enqueued: 0, implicit: [], agentsInPod: 0 }),
      jest.fn(),
      { agents: [], onOpenInvite: jest.fn() },
    );
    sendDraft('second silent send');
    await screen.findByText('second silent send');

    expect(screen.queryByText('no agent in this pod')).not.toBeInTheDocument();
  });

  test('the row goes as soon as an agent joins the pod', async () => {
    const view = render(harnessElement(
      makeMessage('anyone there', { enqueued: 0, implicit: [], agentsInPod: 0 }),
      jest.fn(),
      { agents: [], onOpenInvite: jest.fn() },
    ));

    sendDraft('anyone there');
    await screen.findByText('no agent in this pod');

    // The pod detail re-reads on join; no second send, so the row cannot be
    // waiting for one to notice. It goes because its premise is gone.
    view.rerender(harnessElement(
      makeMessage('anyone there', { enqueued: 0, implicit: [], agentsInPod: 0 }),
      jest.fn(),
      { agents: DEFAULT_AGENTS, onOpenInvite: jest.fn() },
    ));

    await waitFor(() => {
      expect(screen.queryByText('no agent in this pod')).not.toBeInTheDocument();
    });
  });

  test.each([['agent-dm'], ['agent-room']])(
    'stays hidden in a DM pod (%s) — its empty state already says who is missing',
    async (podType) => {
      renderHarness(
        makeMessage('dm send', { enqueued: 0, implicit: [], agentsInPod: 0 }),
        jest.fn(),
        { agents: [], podType, onOpenInvite: jest.fn() },
      );

      sendDraft('dm send');
      await screen.findByText('dm send');

      expect(screen.queryByText('no agent in this pod')).not.toBeInTheDocument();
    },
  );

  test('stays hidden when the shell has no way to add an agent', async () => {
    // The row's whole shape is the explanation plus the one step. Without the
    // step it would be a sentence pointing at nothing the user can do.
    renderHarness(
      makeMessage('anyone there', { enqueued: 0, implicit: [], agentsInPod: 0 }),
      jest.fn(),
      { agents: [] },
    );

    sendDraft('anyone there');
    await screen.findByText('anyone there');

    expect(screen.queryByText('no agent in this pod')).not.toBeInTheDocument();
  });

  test('an agent joining does not suppress the mention hint in the same session', async () => {
    // Same pod, same session: the no-agent row first, then an agent joins, then
    // a send that reaches nobody. Separate session keys, so the second hint is
    // not cancelled by the first.
    const view = render(harnessElement(
      makeMessage('before the join', { enqueued: 0, implicit: [], agentsInPod: 0 }),
      jest.fn(),
      { agents: [], onOpenInvite: jest.fn() },
    ));
    sendDraft('before the join');
    await screen.findByText('no agent in this pod');

    view.rerender(harnessElement(
      makeMessage('hello room', { enqueued: 0, implicit: [], agentsInPod: 1 }),
      jest.fn(),
      { agents: DEFAULT_AGENTS, onOpenInvite: jest.fn() },
    ));
    sendDraft('hello room');

    const hint = await screen.findByText(/No agent was notified/);
    expect(hint).toHaveTextContent('@aria');
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
