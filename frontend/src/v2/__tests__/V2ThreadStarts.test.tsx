// @ts-nocheck
// Scout's starts: the first session's direction B (ruled 2026-10-15). Scout's
// welcome carries its starts in a server-composed payload, the thread renders
// them as buttons under that message, and a click sends the start as the
// person's own message. A start goes away only once this person has sent it,
// so nothing else in the pod (a join row, Scout's follow-ups, another member)
// can take the offer away before it is seen.
import React, { useState } from 'react';
import {
  fireEvent, render, screen, waitFor, within,
} from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import V2Thread from '../components/V2Thread';
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
  content: "I'm Scout. This pod is yours, and I work in it with you. Start with one of these, or tell me what you're working on.",
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

    const group = startsGroup();
    expect(within(group).queryByRole('button', { name: CONNECT })).not.toBeInTheDocument();
    expect(within(group).getByRole('button', { name: POD_START })).toBeInTheDocument();
  });

  test('both starts sent: no group is left behind', () => {
    renderThread([
      welcome,
      message('sent-1', 'u1', 'maya', CONNECT, 4),
      message('sent-2', 'u1', 'maya', POD_START, 5),
    ]);

    expect(startsGroup()).not.toBeInTheDocument();
  });

  test('a message without starts shows no buttons, including an older welcome', () => {
    renderThread([
      message('old-welcome', 'scout-1', 'scout', "Welcome — I'm Scout. This workspace is yours, and I live here.", 0, { user: { username: 'scout', isBot: true } }),
    ]);

    expect(startsGroup()).not.toBeInTheDocument();
  });
});

// A new pod's next steps (2026-10-15): the proposer's first message in a pod
// it just created offers two starts that act instead of sending text. One opens
// Bring your own aimed at this pod; the other opens this pod's invite dialog.
const BYO_HREF = '/v2/agents/byo?pod=pod-1&name=maya-agent';
const nextSteps = (starts) => ({
  id: 'next-steps',
  pod_id: 'pod-1',
  user_id: 'scout-1',
  content: 'This pod is ready. Two ways to get it going: bring in an agent you already use, or invite a teammate.',
  message_type: 'text',
  created_at: at(1),
  user: { username: 'scout', isBot: true },
  payload: { kind: 'starts', starts },
});
const CONNECT_HERE = { id: 'connect-agent-here', label: 'Connect an agent to this pod', href: BYO_HREF };
const INVITE = { id: 'invite-teammate', label: 'Invite a teammate', action: 'invite' };

describe("V2Thread — a new pod's next steps", () => {
  test('the connect start navigates to Bring your own for this pod and sends no message', () => {
    const sendSpy = renderThread([nextSteps([CONNECT_HERE, INVITE])], jest.fn(), { onOpenInvite: jest.fn() });

    fireEvent.click(within(startsGroup()).getByRole('button', { name: 'Connect an agent to this pod' }));

    expect(screen.getByTestId('location')).toHaveTextContent(BYO_HREF);
    expect(sendSpy).not.toHaveBeenCalled();
  });

  test("the invite start opens this pod's invite dialog on the people tab and sends no message", () => {
    const onOpenInvite = jest.fn();
    const sendSpy = renderThread([nextSteps([CONNECT_HERE, INVITE])], jest.fn(), { onOpenInvite });

    fireEvent.click(within(startsGroup()).getByRole('button', { name: 'Invite a teammate' }));

    expect(onOpenInvite).toHaveBeenCalledWith('people');
    expect(sendSpy).not.toHaveBeenCalled();
  });

  test('both stay after use: acting on one never takes the other away', () => {
    renderThread([nextSteps([CONNECT_HERE, INVITE])], jest.fn(), { onOpenInvite: jest.fn() });

    fireEvent.click(within(startsGroup()).getByRole('button', { name: 'Invite a teammate' }));

    const labels = within(startsGroup()).getAllByRole('button').map((button) => button.textContent);
    expect(labels).toEqual(['Connect an agent to this pod', 'Invite a teammate']);
  });

  test('an invite start is not shown where this thread cannot open the dialog', () => {
    renderThread([nextSteps([CONNECT_HERE, INVITE])]);

    const labels = within(startsGroup()).getAllByRole('button').map((button) => button.textContent);
    expect(labels).toEqual(['Connect an agent to this pod']);
  });

  test('a start whose link leaves the app is never rendered', () => {
    renderThread([nextSteps([
      { id: 'a', label: 'Protocol-relative', href: '//evil.example/x' },
      { id: 'b', label: 'Absolute', href: 'https://evil.example/x' },
      { id: 'c', label: 'Double slash', href: '/v2//evil.example' },
      { id: 'd', label: 'Unknown action', action: 'delete-pod' },
    ])], jest.fn(), { onOpenInvite: jest.fn() });

    expect(startsGroup()).toBeNull();
  });
});

// Walk 4 (2026-10-16): two first-minute frictions on the hosted path.
describe('Scout starts and the composer after a hosted agent goes live', () => {
  const axios = jest.requireMock('axios').default;
  const HOSTED = 'Run an agent here, nothing to install';
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
  const HOSTED = 'Run an agent here, nothing to install';
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

  test('the beta limits sit under the button, and describe it', () => {
    renderThread([welcomeRunsHere]);
    expect(screen.getByRole('button', { name: HOSTED }))
      .toHaveAccessibleDescription('Beta: 1 hosted agent per account, 30 turns a day.');
  });

  test('one click installs and starts the agent in this pod, sends nothing, and the start goes away', async () => {
    answer({
      '/api/hosted/welcome-start': [PLAN],
      '/api/registry/install': [{ success: true }],
      '/api/hosted/provision': [{ ready: true }],
    });
    const sendSpy = renderThread([welcomeRunsHere]);
    fireEvent.click(screen.getByRole('button', { name: HOSTED }));
    expect(await screen.findByRole('button', { name: 'Starting…' })).toBeDisabled();
    await waitFor(() => expect(screen.queryByRole('button', { name: /Run an agent here|Starting/ })).not.toBeInTheDocument());

    expect(calls('/api/hosted/welcome-start').map(([, body]) => body)).toEqual([{ messageId: 'welcome' }]);
    expect(calls('/api/registry/install')).toHaveLength(1);
    expect(calls('/api/registry/install')[0][1]).toMatchObject({
      agentName: 'maya-agent', podId: 'pod-1', config: { runtime: { runtimeType: 'hosted' } },
    });
    expect(calls('/api/hosted/provision').map(([, body]) => body)).toEqual([{ agentName: 'maya-agent' }]);
    expect(sendSpy).not.toHaveBeenCalled();
    expect(screen.getByTestId('location')).toHaveTextContent(/^\/$/);
    expect(screen.getByRole('button', { name: CONNECT })).toBeInTheDocument();
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
