// @ts-nocheck
// Scout's starts: the first session's direction B (ruled 2026-10-15). Scout's
// welcome carries its starts in a server-composed payload, the thread renders
// them as buttons under that message, and a click sends the start as the
// person's own message. A start goes away only once this person has sent it,
// so nothing else in the pod (a join row, Scout's follow-ups, another member)
// can take the offer away before it is seen.
import React, { useState } from 'react';
import {
  cleanup,
  fireEvent, render, screen, waitFor, within,
} from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import axios from 'axios';
import V2Thread from '../components/V2Thread';
import { resetByoStepsForTest } from '../utils/byoTelemetry';
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
  currentUser: { _id: 'u1', username: 'maya' },
  user: { _id: 'u1', username: 'maya' },
  token: 't',
  loading: false,
  error: null,
  isAuthenticated: true,
  register: jest.fn(),
  login: jest.fn(),
  logout: jest.fn(),
  updateProfile: jest.fn(),
};

const CONNECT = 'Connect an agent I already use';
const POD_START = 'Start a pod for a project';

const at = (minute) => `2026-10-15T10:${String(minute).padStart(2, '0')}:00.000Z`;

const welcome = {
  id: 'welcome',
  pod_id: 'pod-1',
  user_id: 'scout-1',
  content: "I'm Scout. Pick a start or tell me your goal.",
  message_type: 'text',
  created_at: at(0),
  user: { username: 'scout', isBot: true },
  payload: {
    kind: 'starts',
    starts: [
      { id: 'connect-agent', label: CONNECT },
      { id: 'start-pod', label: POD_START },
    ],
  },
};

const message = (id, userId, username, content, minute, extra = {}) => ({
  id,
  pod_id: 'pod-1',
  user_id: userId,
  content,
  message_type: 'text',
  created_at: at(minute),
  user: { username },
  ...extra,
});

const OWN_POD = { _id: 'pod-1', name: 'My Workspace', type: 'chat', createdBy: 'u1' };

const Harness = ({ initial, sendSpy, onOpenInvite = undefined, pod = OWN_POD }) => {
  const [messages, setMessages] = useState(initial);
  const sendMessage = async (...args) => {
    sendSpy(...args);
    const sent = message(`sent-${args[0]}`, 'u1', 'maya', args[0], 30);
    setMessages((current) => [...current, sent]);
    return sent;
  };
  const detail = {
    pod,
    members: [{ _id: 'u1', username: 'maya', isBot: false }],
    messages,
    agents: [{ agentName: 'scout', instanceId: 'u1a2b3c4d5e', displayName: 'Scout', status: 'active' }],
    sendMessage,
    loading: false,
    error: null,
    refresh: jest.fn(),
  };
  return <V2Thread detail={detail} onOpenInvite={onOpenInvite} />;
};

const LocationProbe = () => {
  const location = useLocation();
  return <output data-testid="location">{`${location.pathname}${location.search}`}</output>;
};

const renderThread = (initial, sendSpy = jest.fn(), { onOpenInvite = undefined, pod = OWN_POD } = {}) => {
  render(
    <AuthContext.Provider value={authValue}>
      <MemoryRouter>
        <Harness initial={initial} sendSpy={sendSpy} onOpenInvite={onOpenInvite} pod={pod} />
        <LocationProbe />
      </MemoryRouter>
    </AuthContext.Provider>,
  );
  return sendSpy;
};

const startsGroup = () => screen.queryByRole('group', { name: 'Ways to start' });

describe("V2Thread — Scout's starts", () => {
  test("Scout's welcome shows its starts as buttons, as one labelled group", () => {
    renderThread([welcome]);

    const group = startsGroup();
    expect(group).toBeInTheDocument();
    expect(within(group).getAllByRole('button').map((button) => button.textContent))
      .toEqual([CONNECT, POD_START]);
  });

  test('a click sends the start as a root message, leaves the draft alone, and that start goes away', async () => {
    const sendSpy = renderThread([welcome]);
    const composer = screen.getByPlaceholderText(/message my workspace/i);
    fireEvent.change(composer, { target: { value: 'half typed' } });

    fireEvent.click(within(startsGroup()).getByRole('button', { name: POD_START }));

    expect(await screen.findByText(POD_START, { selector: '.v2-msg *' })).toBeInTheDocument();
    expect(sendSpy).toHaveBeenCalledWith(POD_START, 'text', undefined, undefined);
    expect(composer).toHaveValue('half typed');
    const group = startsGroup();
    expect(within(group).queryByRole('button', { name: POD_START })).not.toBeInTheDocument();
    expect(within(group).getByRole('button', { name: CONNECT })).toBeInTheDocument();
  });

  test('a join row, Scout following up, or another member does not take the starts away', () => {
    renderThread([
      welcome,
      message('join', 'commonly-bot', 'commonly-bot', 'lee joined the pod', 1, { user: { username: 'commonly-bot', isBot: true } }),
      message('follow-up', 'scout-1', 'scout', 'Still here when you want me.', 2, { user: { username: 'scout', isBot: true } }),
      message('other-human', 'u2', 'lee', CONNECT, 3),
    ]);

    expect(within(startsGroup()).getAllByRole('button').map((button) => button.textContent))
      .toEqual([CONNECT, POD_START]);
  });

  test('typing something else leaves the starts in place, so connecting stays one click away', async () => {
    const sendSpy = renderThread([welcome]);
    fireEvent.change(screen.getByPlaceholderText(/message my workspace/i), { target: { value: 'hello' } });
    fireEvent.click(screen.getByRole('button', { name: /send message/i }));

    expect(await screen.findByText('hello', { selector: '.v2-msg *' })).toBeInTheDocument();
    expect(sendSpy).toHaveBeenCalledWith('hello', 'text', undefined, undefined);
    expect(within(startsGroup()).getByRole('button', { name: CONNECT })).toBeInTheDocument();
  });

  test('a start this person already sent stays gone after a reload', () => {
    renderThread([welcome, message('sent', 'u1', 'maya', CONNECT, 4)]);

    // The welcome's group comes first; the sent connect start carries its own.
    const [group] = screen.getAllByRole('group', { name: 'Ways to start' });
    expect(within(group).queryByRole('button', { name: CONNECT })).not.toBeInTheDocument();
    expect(within(group).getByRole('button', { name: POD_START })).toBeInTheDocument();
  });

  test('both starts sent: only the Bring your own link is left', () => {
    renderThread([
      welcome,
      message('sent-1', 'u1', 'maya', CONNECT, 4),
      message('sent-2', 'u1', 'maya', POD_START, 5),
    ]);

    expect(within(startsGroup()).getAllByRole('button').map((button) => button.textContent))
      .toEqual([OPEN_BYO]);
  });

  test('a message without starts shows no buttons, including an older welcome', () => {
    renderThread([
      message('old-welcome', 'scout-1', 'scout', "Welcome — I'm Scout. This workspace is yours, and I live here.", 0, { user: { username: 'scout', isBot: true } }),
    ]);

    expect(startsGroup()).not.toBeInTheDocument();
  });
});

// Scout's reply to the connect start is a prompt and cannot be relied on
// to link Bring your own, so the thread links it under the person's own
// message, from the moment it is sent.
const OPEN_BYO = 'Open Bring your own';

describe('V2Thread — the connect start links Bring your own', () => {
  test("clicking the connect start shows the link under the person's message at once", async () => {
    const send = renderThread([welcome]);
    fireEvent.click(within(startsGroup()).getByRole('button', { name: CONNECT }));
    expect(send).toHaveBeenCalledWith(CONNECT, 'text', undefined, undefined);

    const link = await screen.findByRole('button', { name: OPEN_BYO });
    fireEvent.click(link);
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/v2/agents/byo?pod=pod-1'));
  });

  test('the link shows only under that exact label', () => {
    renderThread([
      welcome,
      message('close', 'u1', 'maya', 'Connect an agent I already use, please', 4),
      message('lower', 'u1', 'maya', 'connect an agent i already use', 5),
      message('pod', 'u1', 'maya', POD_START, 6),
    ]);
    expect(screen.queryByRole('button', { name: OPEN_BYO })).not.toBeInTheDocument();
  });

  test("another member's connect message gets no link", () => {
    renderThread([welcome, message('theirs', 'u2', 'lee', CONNECT, 4)]);
    expect(screen.queryByRole('button', { name: OPEN_BYO })).not.toBeInTheDocument();
  });

  test("in a pod the viewer didn't create, their own connect message gets no link", () => {
    renderThread([welcome, message('mine', 'u1', 'maya', CONNECT, 4)], jest.fn(), {
      pod: { ...OWN_POD, createdBy: 'someone-else' },
    });
    expect(screen.queryByRole('button', { name: OPEN_BYO })).not.toBeInTheDocument();
  });

  test('the link pings byo-offer-shown once; a thread without it does not', async () => {
    resetByoStepsForTest();
    const pings = () => axios.post.mock.calls.filter(([url, body]) => String(url).endsWith('/api/stats/byo-step')
      && body?.step === 'byo-offer-shown').length;
    axios.post.mockClear();
    renderThread([welcome]);
    expect(pings()).toBe(0);
    cleanup();
    renderThread([welcome, message('mine', 'u1', 'maya', CONNECT, 4)]);
    await screen.findByRole('button', { name: OPEN_BYO });
    expect(pings()).toBe(1);
  });

  test('a matching reply folded into a thread card renders no link and records no offer', () => {
    resetByoStepsForTest();
    axios.post.mockClear();
    renderThread([
      welcome,
      message('root', 'u1', 'maya', 'Where do I start?', 4),
      message('reply', 'u1', 'maya', CONNECT, 5, { thread_root_id: 'root' }),
    ]);
    expect(screen.queryByRole('button', { name: OPEN_BYO })).not.toBeInTheDocument();
    expect(axios.post.mock.calls.filter(([url, body]) => String(url).endsWith('/api/stats/byo-step')
      && body?.step === 'byo-offer-shown')).toHaveLength(0);
  });

  test('a matching thread root renders the link and records the offer', async () => {
    resetByoStepsForTest();
    axios.post.mockClear();
    renderThread([
      welcome,
      message('root', 'u1', 'maya', CONNECT, 4),
      message('reply', 'scout-1', 'scout', 'Which one do you use?', 5, { thread_root_id: 'root', user: { username: 'scout', isBot: true } }),
    ]);
    await screen.findByRole('button', { name: OPEN_BYO });
    await waitFor(() => expect(axios.post.mock.calls.filter(([url, body]) => String(url).endsWith('/api/stats/byo-step')
      && body?.step === 'byo-offer-shown')).toHaveLength(1));
  });

  test('a message from Scout with that text gets no link', () => {
    renderThread([message('echo', 'scout-1', 'scout', CONNECT, 4, { user: { username: 'scout', isBot: true } })]);
    expect(screen.queryByRole('button', { name: OPEN_BYO })).not.toBeInTheDocument();
  });
});

// Scout's first-task proposal is structured: the row is created only after a
// person clicks Add to board, and Bring your own targets the new pod.
const BYO_HREF = '/v2/agents/byo?pod=pod-1&name=maya-agent';
const nextSteps = (starts) => ({
  id: 'next-steps',
  pod_id: 'pod-1',
  user_id: 'scout-1',
  content: 'Suggested first task: Fix login',
  message_type: 'text',
  created_at: at(1),
  user: { username: 'scout', isBot: true },
  payload: { kind: 'starts', starts },
});
const ADD = { id: 'add-first-task', label: 'Add to board', action: 'add-first-task', title: 'Fix login', sourceRef: 'https://github.com/acme/widget/issues/10' };
const BRING_OWN = { id: 'bring-your-own', label: 'Bring your own', href: BYO_HREF };

describe("V2Thread — a new pod's first task", () => {
  const axios = jest.requireMock('axios').default;
  beforeEach(() => {
    axios.post.mockClear();
    axios.get.mockImplementation(() => Promise.resolve({ data: {} }));
  });
  test('Bring your own navigates to the new pod and sends no message', () => {
    const sendSpy = renderThread([nextSteps([ADD, BRING_OWN])]);

    fireEvent.click(within(startsGroup()).getByRole('button', { name: 'Bring your own' }));

    expect(screen.getByTestId('location')).toHaveTextContent(BYO_HREF);
    expect(sendSpy).not.toHaveBeenCalled();
    expect(axios.post).not.toHaveBeenCalledWith(expect.stringContaining('/tasks/'), expect.anything(), expect.anything());
  });

  test('Add to board creates exactly one task on click and leaves Bring your own', async () => {
    const sendSpy = renderThread([nextSteps([ADD, BRING_OWN])]);
    expect(axios.post).not.toHaveBeenCalledWith(expect.stringContaining('/tasks/'), expect.anything(), expect.anything());

    fireEvent.click(within(startsGroup()).getByRole('button', { name: 'Add to board' }));

    await waitFor(() => expect(axios.post).toHaveBeenCalledWith('/api/v1/tasks/pod-1', {
      title: 'Fix login', sourceRef: 'https://github.com/acme/widget/issues/10',
    }, expect.anything()));
    await waitFor(() => expect(within(startsGroup()).queryByRole('button', { name: 'Add to board' })).not.toBeInTheDocument());
    expect(within(startsGroup()).getByRole('button', { name: 'Bring your own' })).toBeInTheDocument();
    expect(sendSpy).not.toHaveBeenCalled();
  });

  test('a failed Add to board shows its alert as a block before the transcript', async () => {
    axios.post.mockRejectedValueOnce(new Error('task write failed'));
    renderThread([nextSteps([ADD, BRING_OWN])]);

    fireEvent.click(within(startsGroup()).getByRole('button', { name: 'Add to board' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Couldn’t add the task. Try again.');
    expect(alert.parentElement).toHaveClass('v2-chat');
    expect(alert.nextElementSibling).toHaveClass('v2-thread__transcript');
  });

  test('only the pod creator sees Add to board', () => {
    renderThread([nextSteps([ADD, BRING_OWN])], jest.fn(), { pod: { ...OWN_POD, createdBy: 'u2' } });
    expect(within(startsGroup()).queryByRole('button', { name: 'Add to board' })).not.toBeInTheDocument();
    expect(within(startsGroup()).getByRole('button', { name: 'Bring your own' })).toBeInTheDocument();
  });

  test('an already-added task keeps Add to board gone after a reload', async () => {
    axios.get.mockImplementation((url) => (url === '/api/v1/tasks/pod-1'
      ? Promise.resolve({ data: { tasks: [{ title: 'Fix login', sourceRef: ADD.sourceRef }] } })
      : Promise.resolve({ data: {} })));
    renderThread([nextSteps([ADD, BRING_OWN])]);
    await waitFor(() => expect(within(startsGroup()).queryByRole('button', { name: 'Add to board' })).not.toBeInTheDocument());
    expect(within(startsGroup()).getByRole('button', { name: 'Bring your own' })).toBeInTheDocument();
  });

  test('a start whose link leaves the app is never rendered', () => {
    renderThread([nextSteps([
      { id: 'a', label: 'Protocol-relative', href: '//evil.example/x' },
      { id: 'b', label: 'Absolute', href: 'https://evil.example/x' },
      { id: 'c', label: 'Double slash', href: '/v2//evil.example' },
      { id: 'd', label: 'Unknown action', action: 'delete-pod' },
    ])]);

    expect(startsGroup()).toBeNull();
  });
});

// Walk 4 (2026-10-16): two first-minute frictions on the hosted path.
describe('Scout starts and the composer after a hosted agent goes live', () => {
  const axios = jest.requireMock('axios').default;
  const HOSTED = 'Run an agent here';
  const welcomeWithHosted = {
    ...welcome,
    payload: {
      kind: 'starts',
      starts: [
        { id: 'run-hosted', label: HOSTED, href: '/v2/agents/byo?pod=pod-1&mode=hosted' },
        ...welcome.payload.starts,
      ],
    },
  };
  const agentStates = (agents) => {
    axios.get.mockImplementation((url) => (typeof url === 'string' && url.endsWith('/agent-states')
      ? Promise.resolve({ data: { agents } })
      : Promise.resolve({ data: {} })));
  };
  afterEach(() => { axios.get.mockImplementation(() => Promise.resolve({ data: {} })); });

  test('"Run an agent here" goes away once the viewer holds a hosted agent; the other starts stay', async () => {
    agentStates([{ agentName: 'maya-agent', instanceId: 'default', state: 'reachable', isOwner: true, hosted: true }]);
    renderThread([welcomeWithHosted]);
    expect(await screen.findByRole('button', { name: CONNECT })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('button', { name: HOSTED })).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: POD_START })).toBeInTheDocument();
  });

  test('it stays while the viewer holds none, including when someone else does', async () => {
    agentStates([{ agentName: 'lee-agent', instanceId: 'default', state: 'reachable', isOwner: false, hosted: true }]);
    renderThread([welcomeWithHosted]);
    await waitFor(() => expect(axios.get)
      .toHaveBeenCalledWith(expect.stringContaining('/agent-states'), expect.anything()));
    expect(await screen.findByRole('button', { name: HOSTED })).toBeInTheDocument();
  });

  // The real-browser walk caught what the test above could not: the pod
  // arrives after the first render, and a hook placed after the `!pod` early
  // return crashed the thread ("Rendered more hooks than during the previous
  // render"). This renders the loading state first, then the pod.
  test('the draft arrives when the pod loads after the first render, without a hooks crash', async () => {
    const LateHarness = () => {
      const [ready, setReady] = useState(false);
      React.useEffect(() => { const id = setTimeout(() => setReady(true), 0); return () => clearTimeout(id); }, []);
      const detail = {
        pod: ready ? { _id: 'pod-1', name: 'My Workspace', type: 'chat', createdBy: 'u1' } : null,
        members: [{ _id: 'u1', username: 'maya', isBot: false }],
        messages: ready ? [welcome] : [],
        agents: [],
        sendMessage: jest.fn(),
        loading: !ready,
        error: null,
        refresh: jest.fn(),
      };
      return <V2Thread detail={detail} />;
    };
    render(
      <AuthContext.Provider value={authValue}>
        <MemoryRouter initialEntries={[{ pathname: '/v2/pods/pod-1', state: { composeDraft: '@maya-agent ' } }]}>
          <LateHarness />
        </MemoryRouter>
      </AuthContext.Provider>,
    );
    const composer = await screen.findByPlaceholderText(/message my workspace/i);
    await waitFor(() => expect(composer).toHaveValue('@maya-agent '));
  });

  test('a page that sends someone here can address the composer: the draft arrives, focused, once', async () => {
    render(
      <AuthContext.Provider value={authValue}>
        <MemoryRouter initialEntries={[{ pathname: '/v2/pods/pod-1', state: { composeDraft: '@maya-agent ' } }]}>
          <Harness initial={[welcome]} sendSpy={jest.fn()} />
        </MemoryRouter>
      </AuthContext.Provider>,
    );
    const composer = await screen.findByPlaceholderText(/message my workspace/i);
    await waitFor(() => expect(composer).toHaveValue('@maya-agent '));
  });
});

// TASK-290: on the person's own welcome, "Run an agent here" starts a hosted
// agent in place. The click is the consent; there is no page between. Which
// welcome may run it is the server's call (services/welcomeHostedStart.ts);
// these pin the thread's half: only the pod's creator runs it, a repeat click
// gets the same agent, and anything refused falls back to the link.
describe('"Run an agent here" runs in place on the owner\'s own welcome (TASK-290)', () => {
  const axios = jest.requireMock('axios').default;
  const HOSTED = 'Run an agent here';
  const HREF = '/v2/agents/byo?pod=pod-1&mode=hosted';
  const welcomeRunsHere = {
    ...welcome,
    payload: {
      kind: 'starts',
      starts: [
        {
          id: 'run-hosted', label: HOSTED, href: HREF, action: 'run-hosted', caps: { agentsPerUser: 1, turnsPerDay: 30 },
        },
        ...welcome.payload.starts,
      ],
    },
  };
  const PLAN = { podId: 'pod-1', existing: null, agentName: 'maya-agent' };
  const HELD = { podId: 'pod-1', existing: { agentName: 'maya-agent', instanceId: 'default', podId: 'pod-1' }, agentName: null };
  const calls = (url) => axios.post.mock.calls.filter(([called]) => called === url);
  // Answers by URL, consumed in order; { reject } answers with an error.
  const answer = (routes) => {
    axios.post.mockImplementation((url) => {
      const next = (routes[url] || []).shift();
      if (!next) return Promise.resolve({ data: {} });
      return next.reject ? Promise.reject(next.reject) : Promise.resolve({ data: next });
    });
  };
  const refusal = (status, data) => ({ reject: { response: { status, data } } });

  beforeEach(() => { axios.post.mockClear(); });
  afterEach(() => { axios.post.mockImplementation(() => Promise.resolve({ data: {} })); });

  test('the welcome skips the beta limits even for older messages carrying caps', () => {
    renderThread([welcomeRunsHere]);
    const button = screen.getByRole('button', { name: HOSTED });
    expect(button).not.toHaveAccessibleDescription();
    expect(button).not.toHaveAttribute('aria-describedby');
    expect(screen.queryByText('Beta: 1 hosted agent per account, 30 turns a day.')).not.toBeInTheDocument();
  });

  test('a held agent answers the click with its running line, even when the start carries no limits', async () => {
    answer({
      '/api/hosted/welcome-start': [HELD],
      '/api/hosted/provision': [{ ready: true }],
    });
    const noCaps = {
      ...welcome,
      payload: {
        kind: 'starts',
        starts: [{ id: 'run-hosted', label: HOSTED, href: HREF, action: 'run-hosted' }, ...welcome.payload.starts],
      },
    };
    renderThread([noCaps]);
    fireEvent.click(screen.getByRole('button', { name: HOSTED }));
    expect(await screen.findByText('maya-agent is listening.')).toHaveAttribute('role', 'status');
    expect(calls('/api/registry/install')).toHaveLength(0);
  });

  test('one click installs and starts the agent in this pod, sends nothing, and the start goes away', async () => {
    answer({
      '/api/hosted/welcome-start': [PLAN],
      '/api/registry/install': [{ success: true }],
      '/api/hosted/provision': [{ ready: true }],
    });
    // A second payload with the same caps must not inherit this welcome's live note.
    const otherStart = {
      ...welcomeRunsHere,
      id: 'other-start',
      created_at: at(1),
      user_id: 'u2',
      user: { username: 'lee', isBot: false },
    };
    const sendSpy = renderThread([welcomeRunsHere, otherStart]);
    fireEvent.click(screen.getAllByRole('button', { name: HOSTED })[0]);
    expect(await screen.findByRole('button', { name: 'Starting…' })).toBeDisabled();
    await waitFor(() => expect(screen.queryByRole('button', { name: /Run an agent here|Starting/ })).not.toBeInTheDocument());
    expect(screen.getByText('maya-agent is listening. Beta: 1 hosted agent per account, 30 turns a day.'))
      .toHaveAttribute('role', 'status');
    expect(screen.getAllByText('maya-agent is listening. Beta: 1 hosted agent per account, 30 turns a day.'))
      .toHaveLength(1);

    expect(calls('/api/hosted/welcome-start').map(([, body]) => body)).toEqual([{ messageId: 'welcome' }]);
    expect(calls('/api/registry/install')).toHaveLength(1);
    expect(calls('/api/registry/install')[0][1]).toMatchObject({
      agentName: 'maya-agent', podId: 'pod-1', config: { runtime: { runtimeType: 'hosted' } },
    });
    expect(calls('/api/hosted/provision').map(([, body]) => body)).toEqual([{ agentName: 'maya-agent' }]);
    expect(sendSpy).not.toHaveBeenCalled();
    expect(screen.getByTestId('location')).toHaveTextContent(/^\/$/);
    expect(screen.getAllByRole('button', { name: CONNECT })).toHaveLength(2);
  });

  test('a double click starts one agent', async () => {
    answer({
      '/api/hosted/welcome-start': [PLAN],
      '/api/registry/install': [{ success: true }],
      '/api/hosted/provision': [{ ready: true }],
    });
    renderThread([welcomeRunsHere]);
    const button = screen.getByRole('button', { name: HOSTED });
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(calls('/api/hosted/provision')).toHaveLength(1));
    expect(calls('/api/hosted/welcome-start')).toHaveLength(1);
    expect(calls('/api/registry/install')).toHaveLength(1);
  });

  test.each([
    ['the existing install', refusal(400, { error: 'Agent already installed in this pod' })],
    ['the cap', refusal(403, { code: 'hosted_cap_reached', cap: 1 })],
  ])('when another tab got there first, %s answers with that agent: this click starts it, with no error', async (_label, installAnswer) => {
    answer({
      '/api/hosted/welcome-start': [PLAN, HELD],
      '/api/registry/install': [installAnswer],
      '/api/hosted/provision': [{ ready: true }],
    });
    renderThread([welcomeRunsHere]);
    fireEvent.click(screen.getByRole('button', { name: HOSTED }));
    await waitFor(() => expect(screen.queryByRole('button', { name: /Run an agent here|Starting/ })).not.toBeInTheDocument());
    expect(calls('/api/registry/install')).toHaveLength(1);
    expect(calls('/api/hosted/provision').map(([, body]) => body)).toEqual([{ agentName: 'maya-agent', instanceId: 'default' }]);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  test('a person who did not create the pod gets the link, and nothing is started', () => {
    renderThread([welcomeRunsHere], jest.fn(), { pod: { ...OWN_POD, createdBy: { _id: 'u2' } } });
    fireEvent.click(screen.getByRole('button', { name: HOSTED }));
    expect(screen.getByTestId('location')).toHaveTextContent(HREF);
    expect(axios.post).not.toHaveBeenCalled();
  });

  test('the owner is recognised from a populated creator too', async () => {
    answer({ '/api/hosted/welcome-start': [refusal(503, { code: 'hosted_runtime_unconfigured' })] });
    renderThread([welcomeRunsHere], jest.fn(), { pod: { ...OWN_POD, createdBy: { _id: 'u1', username: 'maya' } } });
    fireEvent.click(screen.getByRole('button', { name: HOSTED }));
    await waitFor(() => expect(calls('/api/hosted/welcome-start')).toHaveLength(1));
  });

  test('a start the server will not run here opens the page instead', async () => {
    answer({ '/api/hosted/welcome-start': [refusal(403, { code: 'not_welcome_start' })] });
    renderThread([welcomeRunsHere]);
    fireEvent.click(screen.getByRole('button', { name: HOSTED }));
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent(HREF));
    expect(calls('/api/registry/install')).toHaveLength(0);
  });

  test('a name the install refuses opens the page, where a name can be chosen', async () => {
    answer({
      '/api/hosted/welcome-start': [PLAN, PLAN],
      '/api/registry/install': [refusal(409, { code: 'agent_name_taken', error: 'taken' })],
    });
    renderThread([welcomeRunsHere]);
    fireEvent.click(screen.getByRole('button', { name: HOSTED }));
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent(HREF));
    expect(calls('/api/hosted/provision')).toHaveLength(0);
  });

  test('a failure says why under the button, and the button can be pressed again', async () => {
    answer({
      '/api/hosted/welcome-start': [PLAN, PLAN],
      '/api/registry/install': [refusal(503, { code: 'hosted_runtime_unconfigured' })],
    });
    renderThread([welcomeRunsHere]);
    fireEvent.click(screen.getByRole('button', { name: HOSTED }));
    expect(await screen.findByRole('alert')).toHaveTextContent("Hosting isn't available on this instance yet.");
    expect(screen.getByRole('button', { name: HOSTED })).toBeEnabled();
    expect(calls('/api/hosted/provision')).toHaveLength(0);
  });
});
