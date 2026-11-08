// @ts-nocheck
// F307: a person closes the direct message pod they hold with an agent. The
// thread offers it when the agent is gone, the inspector always offers it to
// the pod's person, and the pods list shows one "Closed … · Undo" line.
// Frame: docs/design/artboards/f303.
import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import V2Thread from '../components/V2Thread';
import V2Inspector from '../components/V2Inspector';
import V2ClosedDmStatus from '../components/V2ClosedDmStatus';
import { setClosedRoom, lastClosedRoom } from '../agentRoomClose';
import { AuthContext } from '../../context/AuthContext';

jest.mock('../../context/SocketContext', () => ({
  useSocket: () => ({ socket: null, connected: false }),
}));

beforeAll(() => {
  Element.prototype.scrollIntoView = jest.fn();
});

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

const axios = jest.requireMock('axios').default;

const auth = (id = 'u1', isBot = false) => ({
  currentUser: { _id: id, username: id, isBot },
  user: { _id: id, username: id },
  token: 't',
  loading: false,
  error: null,
  isAuthenticated: true,
  register: jest.fn(),
  login: jest.fn(),
  logout: jest.fn(),
  updateProfile: jest.fn(),
});

const roomDetail = (podOverrides = {}) => ({
  pod: { _id: 'room1', name: 'otter', type: 'agent-room', ...podOverrides },
  members: [{ _id: 'agent1', username: 'otter', isBot: true }, { _id: 'u1', username: 'person', isBot: false }],
  messages: [],
  agents: [],
  sendMessage: jest.fn(() => Promise.resolve({ _id: 'm1' })),
  loading: false,
  error: null,
  refresh: jest.fn(() => Promise.resolve()),
});

const Where = () => <div data-testid="where">{useLocation().pathname}</div>;

const renderAt = (ui, user = auth()) => render(
  <AuthContext.Provider value={user}>
    <MemoryRouter initialEntries={['/v2/pods/room1']}>
      <Routes><Route path="*" element={<>{ui}<Where /></>} /></Routes>
    </MemoryRouter>
  </AuthContext.Provider>,
);

afterEach(() => {
  jest.clearAllMocks();
  act(() => setClosedRoom(null));
});

describe('thread: the agent is gone', () => {
  test('offers the close to the person, and closing goes to the pods list with Undo queued', async () => {
    const refresh = jest.fn(() => Promise.resolve());
    renderAt(<V2Thread detail={roomDetail({ agentGone: true })} podsState={{ refresh, pods: [], loading: false, error: null }} />);
    const notice = await screen.findByTestId('agent-room-gone');
    expect(notice).toHaveTextContent('otter was removed, so nothing will answer here.');

    fireEvent.click(screen.getByRole('button', { name: 'Close direct message' }));
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent(/^\/v2$/));
    expect(axios.post).toHaveBeenCalledWith('/api/pods/room1/close', {}, expect.anything());
    expect(refresh).toHaveBeenCalledWith({ silent: true });
    expect(lastClosedRoom()).toEqual({ id: 'room1', name: 'otter' });
  });

  test('says nothing while the agent is still here', () => {
    renderAt(<V2Thread detail={roomDetail({ agentGone: false })} />);
    expect(screen.queryByTestId('agent-room-gone')).toBeNull();
  });

  test('a failed close stays on the pod and says so', async () => {
    axios.post.mockRejectedValueOnce(new Error('nope'));
    renderAt(<V2Thread detail={roomDetail({ agentGone: true })} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Close direct message' }));
    expect(await screen.findByText("Couldn't close it. Try again.")).toBeInTheDocument();
    expect(screen.getByTestId('where')).toHaveTextContent('/v2/pods/room1');
    expect(lastClosedRoom()).toBeNull();
  });
});

describe('inspector: the quiet Close card', () => {
  test('shows to the pod\'s person and closes', async () => {
    const onPodChanged = jest.fn(() => Promise.resolve());
    renderAt(<V2Inspector detail={roomDetail()} currentUserId="u1" onPodChanged={onPodChanged} />);
    const card = await screen.findByTestId('inspector-close-dm');
    expect(card).toHaveTextContent('Writing here again, or otter writing to you, brings it back.');
    fireEvent.click(screen.getByRole('button', { name: 'Close direct message' }));
    await waitFor(() => expect(onPodChanged).toHaveBeenCalled());
    expect(axios.post).toHaveBeenCalledWith('/api/pods/room1/close', {}, expect.anything());
  });

  test('never shows to the agent member, or on another pod type', () => {
    const { unmount } = renderAt(<V2Inspector detail={roomDetail()} currentUserId="agent1" />, auth('agent1', true));
    expect(screen.queryByTestId('inspector-close-dm')).toBeNull();
    unmount();
    const team = { ...roomDetail(), pod: { _id: 'p1', name: 'team', type: 'chat' } };
    renderAt(<V2Inspector detail={team} currentUserId="u1" />);
    expect(screen.queryByTestId('inspector-close-dm')).toBeNull();
  });
});

describe('pods list: Closed … · Undo', () => {
  test('shows after a close, and Undo reopens and opens the pod', async () => {
    const onListChanged = jest.fn(() => Promise.resolve());
    renderAt(<V2ClosedDmStatus selectedPodId={null} onListChanged={onListChanged} />);
    expect(screen.queryByTestId('closed-dm-status')).toBeNull();
    act(() => setClosedRoom({ id: 'room1', name: 'otter' }));
    expect(screen.getByTestId('closed-dm-status')).toHaveTextContent('Closed otter');

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/v2/pods/room1'));
    expect(axios.post).toHaveBeenCalledWith('/api/pods/room1/reopen', {}, expect.anything());
    expect(onListChanged).toHaveBeenCalled();
    expect(screen.queryByTestId('closed-dm-status')).toBeNull();
  });

  test('survives the close\'s own landing, then ends when another pod opens', () => {
    const { rerender } = renderAt(<V2ClosedDmStatus selectedPodId="room1" />);
    act(() => setClosedRoom({ id: 'room1', name: 'otter' }));
    const at = (podId) => rerender(
      <AuthContext.Provider value={auth()}>
        <MemoryRouter initialEntries={['/v2']}>
          <V2ClosedDmStatus selectedPodId={podId} />
        </MemoryRouter>
      </AuthContext.Provider>,
    );
    at(null);
    at('workspace');
    expect(screen.getByTestId('closed-dm-status')).toBeInTheDocument();
    at('another');
    expect(screen.queryByTestId('closed-dm-status')).toBeNull();
  });
});
