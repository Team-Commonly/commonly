// @ts-nocheck
// F164 (TASK-781, D244): the install page says, before an agent joins a pod an
// outside-writable grant reaches, which of its pods it would stop writing in;
// and an owner reads the runtime 403 in words, with its code kept.
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import i18n from '../../i18n';
import V2AgentBYO from '../components/V2AgentBYO';
import { V2InstallNarrowingNotice, V2RuntimeNarrowingNotice } from '../components/V2OutsiderGrantNarrowing';
import { AuthContext } from '../../context/AuthContext';

jest.mock('../utils/byoTelemetry', () => ({ recordByoStep: jest.fn() }));
jest.mock('../components/V2NavRail', () => () => null);
jest.mock('axios', () => {
  const mock = {
    get: jest.fn(),
    post: jest.fn(),
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

const axios = jest.requireMock('axios').default;

const authValue = {
  currentUser: { _id: 'u1', username: 'sam' },
  user: { _id: 'u1', username: 'sam' },
  token: 'user-jwt',
  loading: false,
  error: null,
  isAuthenticated: true,
  register: jest.fn(),
  login: jest.fn(),
  logout: jest.fn(),
  updateProfile: jest.fn(),
};

const narrowing = {
  code: 'outsider_grant_runtime_narrowed',
  losesWrites: [{ podId: 'hq', name: 'Team HQ' }],
  hiddenLosesWritesCount: 2,
  targetWritable: true,
};

afterEach(async () => {
  jest.clearAllMocks();
  await i18n.changeLanguage('en');
});

describe('install narrowing notice', () => {
  test('names the visible pods and counts the hidden ones', () => {
    render(<V2InstallNarrowingNotice agentName="lead" narrowing={narrowing} busy={false} onConfirm={jest.fn()} onCancel={jest.fn()} />);
    const pods = screen.getByTestId('byo-narrowing-pods');
    expect(pods).toHaveTextContent('Team HQ');
    expect(pods).toHaveTextContent("2 pods you can't see");
    expect(screen.getByTestId('byo-narrowing-confirmation')).toHaveTextContent(
      'Once lead joins this pod, an outside-writable connector grant would reach its pods.',
    );
    expect(screen.queryByText("It couldn't write in this pod either.")).toBeNull();
  });

  test('says when the target pod would refuse writes too, in zh-CN as well', async () => {
    const blocked = { ...narrowing, hiddenLosesWritesCount: 0, targetWritable: false };
    const { rerender } = render(<V2InstallNarrowingNotice agentName="lead" narrowing={blocked} busy={false} onConfirm={jest.fn()} onCancel={jest.fn()} />);
    expect(screen.getByText("It couldn't write in this pod either.")).toBeInTheDocument();
    await i18n.changeLanguage('zh-CN');
    rerender(<V2InstallNarrowingNotice agentName="lead" narrowing={blocked} busy={false} onConfirm={jest.fn()} onCancel={jest.fn()} />);
    expect(screen.getByText('它在这个 Pod 里也无法写入。')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '仍然安装' })).toBeInTheDocument();
  });

  test('the install page shows the server\'s warning and confirms only on the second press', async () => {
    axios.get.mockImplementation((url) => {
      if (url === '/api/registry/pods/p1/agents') return Promise.resolve({ data: { agents: [] } });
      if (url.startsWith('/api/registry/agents/next-free-name?')) return Promise.resolve({ data: { name: 'lead' } });
      if (url === '/api/pods') return Promise.resolve({ data: [{ _id: 'p1', name: 'Sentry Triage', type: 'chat' }] });
      return Promise.resolve({ data: {} });
    });
    let installs = 0;
    axios.post.mockImplementation((url, body) => {
      if (url === '/api/registry/install') {
        installs += 1;
        if (!body.confirmNarrowing) {
          return Promise.reject({ response: { status: 409, data: {
            code: 'outsider_grant_narrowing_confirm_required', narrowing,
          } } });
        }
        return Promise.resolve({ data: { success: true } });
      }
      return Promise.resolve({ data: { token: 'cm_agent_x' } });
    });
    window.history.pushState({}, '', '/v2/agents/byo?pod=p1&name=lead&mode=byo');
    render(
      <AuthContext.Provider value={authValue}>
        <MemoryRouter initialEntries={['/v2/agents/byo?pod=p1&name=lead&mode=byo']}>
          <V2AgentBYO />
        </MemoryRouter>
      </AuthContext.Provider>,
    );
    const action = await screen.findByRole('button', { name: /get my connect command/i }, { timeout: 5000 });
    await waitFor(() => expect(action).toBeEnabled());
    fireEvent.click(action);

    expect(await screen.findByTestId('byo-narrowing-pods')).toHaveTextContent('Team HQ');
    expect(installs).toBe(1);
    // Nothing past the install ran: no key was issued for a seat that was not installed.
    expect(axios.post.mock.calls.some(([url]) => url.includes('/runtime-tokens'))).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Install anyway' }));
    await waitFor(() => expect(installs).toBe(2));
    expect(axios.post.mock.calls.filter(([url]) => url === '/api/registry/install')[1][1])
      .toMatchObject({ agentName: 'lead', podId: 'p1', confirmNarrowing: true });
  });
});

describe('runtime narrowing notice', () => {
  test('names the one pod it can write in and keeps the code', () => {
    render(<V2RuntimeNarrowingNotice agentName="lead" status={{
      narrowedPodCount: 1, writablePod: { podId: 't', name: 'Sentry Triage' }, writablePodHidden: false,
    }} />);
    const notice = screen.getByTestId('agent-runtime-narrowing');
    expect(notice).toHaveTextContent('lead can only write in Sentry Triage, because an outside-writable grant reaches it.');
    expect(notice).toHaveTextContent('outsider_grant_runtime_narrowed');
  });

  test('never names a pod the owner cannot see', () => {
    render(<V2RuntimeNarrowingNotice agentName="lead" status={{
      narrowedPodCount: 1, writablePod: null, writablePodHidden: true,
    }} />);
    expect(screen.getByTestId('agent-runtime-narrowing')).toHaveTextContent("which you can't see");
  });

  test('says when it can write nowhere, in zh-CN as well', async () => {
    const status = { narrowedPodCount: 2, writablePod: null, writablePodHidden: false };
    const { rerender } = render(<V2RuntimeNarrowingNotice agentName="lead" status={status} />);
    expect(screen.getByTestId('agent-runtime-narrowing'))
      .toHaveTextContent("lead can't write in any pod: outside-writable grants reach 2 of its pods.");
    await i18n.changeLanguage('zh-CN');
    rerender(<V2RuntimeNarrowingNotice agentName="lead" status={status} />);
    expect(screen.getByTestId('agent-runtime-narrowing'))
      .toHaveTextContent('lead 现在无法在任何 Pod 里写入：它有2个 Pod 被外部可写的授权覆盖。');
  });
});
