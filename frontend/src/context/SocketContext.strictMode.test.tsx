// @ts-nocheck
// F560: a pod view must end inside its socket room after React StrictMode's
// mount/unmount/mount, wherever in the connect sequence the remount lands.
// The fake client follows socket.io-client's order: `connect` fires after the
// render that created the socket, and `disconnect()` on a live socket fires
// its `disconnect` handler synchronously.
import React, { StrictMode, useEffect } from 'react';
import ReactDOM from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { SocketProvider, useSocket } from './SocketContext';
import { useAuth } from './AuthContext';
import io from 'socket.io-client';

jest.mock('socket.io-client');
jest.mock('./AuthContext', () => ({ useAuth: jest.fn() }));
jest.mock('axios', () => ({ get: jest.fn(() => Promise.resolve({ data: { available: false } })), post: jest.fn() }));

let container;
let root;
let sockets;

const fakeSocket = () => {
  const handlers = {};
  const s = {
    connected: false,
    handlers,
    emit: jest.fn(),
    on: jest.fn((event, cb) => { handlers[event] = cb; }),
    off: jest.fn(),
    connect: jest.fn(),
    disconnect: jest.fn(() => {
      const wasConnected = s.connected;
      s.connected = false;
      s.disconnected = true;
      if (wasConnected && handlers.disconnect) handlers.disconnect('io client disconnect');
    }),
    serverConnect: () => {
      s.connected = true;
      if (handlers.connect) handlers.connect();
    },
  };
  return s;
};

// The live socket's last room event for this pod: what the server believes.
const lastRoomEvent = (socket, podId) => {
  const calls = socket.emit.mock.calls.filter(([e, id]) => (e === 'joinPod' || e === 'leavePod') && id === podId);
  return calls.length ? calls[calls.length - 1][0] : null;
};
const liveSocket = () => sockets.filter((s) => !s.disconnected).pop();

// Shaped like the v2 consumers (useV2PodDetail, V2PodBoard): join only once
// the shared socket reports connected.
const GatedRoom = ({ podId = '42' }) => {
  const { socket, connected, joinPod, leavePod } = useSocket();
  useEffect(() => {
    if (!podId || !socket || !connected) return undefined;
    joinPod(podId);
    return () => { leavePod(podId); };
  }, [podId, socket, connected, joinPod, leavePod]);
  return null;
};

// Joins whenever it mounts, connected or not (the integration test's shape).
const UngatedRoom = ({ podId = '42' }) => {
  const { joinPod, leavePod } = useSocket();
  useEffect(() => {
    joinPod(podId);
    return () => leavePod(podId);
  }, [podId, joinPod, leavePod]);
  return null;
};

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = ReactDOM.createRoot(container);
  sockets = [];
  io.mockImplementation(() => { const s = fakeSocket(); sockets.push(s); return s; });
  useAuth.mockReturnValue({ token: 't', currentUser: { _id: 'u1' } });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  container = null;
});

describe.each([
  ['a gated pod view', GatedRoom],
  ['an ungated pod view', UngatedRoom],
])('StrictMode remount, %s', (_label, Room) => {
  test('opened with the app, before the socket connects, ends joined', () => {
    act(() => { root.render(<StrictMode><SocketProvider><Room /></SocketProvider></StrictMode>); });
    const socket = liveSocket();
    act(() => { socket.serverConnect(); });
    expect(lastRoomEvent(socket, '42')).toBe('joinPod');
  });

  test('opened after the socket connected ends joined', () => {
    const App = ({ open }) => (
      <StrictMode><SocketProvider>{open && <Room />}</SocketProvider></StrictMode>
    );
    act(() => { root.render(<App open={false} />); });
    const socket = liveSocket();
    act(() => { socket.serverConnect(); });
    act(() => { root.render(<App open />); });
    expect(lastRoomEvent(socket, '42')).toBe('joinPod');
  });

  test('two views of one pod end joined, and leave only when both close', () => {
    const App = ({ first, second }) => (
      <StrictMode><SocketProvider>{first && <Room />}{second && <GatedRoom />}</SocketProvider></StrictMode>
    );
    act(() => { root.render(<App first={false} second={false} />); });
    const socket = liveSocket();
    act(() => { socket.serverConnect(); });
    act(() => { root.render(<App first second />); });
    expect(lastRoomEvent(socket, '42')).toBe('joinPod');
    act(() => { root.render(<App first={false} second />); });
    expect(lastRoomEvent(socket, '42')).toBe('joinPod');
    act(() => { root.render(<App first={false} second={false} />); });
    expect(lastRoomEvent(socket, '42')).toBe('leavePod');
  });

  test('a reconnect after the remount ends joined, even inside one render batch', () => {
    act(() => { root.render(<StrictMode><SocketProvider><Room /></SocketProvider></StrictMode>); });
    const socket = liveSocket();
    act(() => { socket.serverConnect(); });
    // Same batch: React never renders connected=false, so the views' effects
    // don't re-run and only the provider's connect handler can restore the room.
    act(() => {
      socket.connected = false;
      socket.handlers.disconnect('transport close');
      socket.serverConnect();
    });
    const joins = socket.emit.mock.calls.filter(([e, id]) => e === 'joinPod' && id === '42');
    expect(joins.length).toBeGreaterThanOrEqual(2);
    expect(lastRoomEvent(socket, '42')).toBe('joinPod');
  });

  test('a token refresh that swaps the socket ends joined on the new one', () => {
    act(() => { root.render(<StrictMode><SocketProvider><Room /></SocketProvider></StrictMode>); });
    const first = liveSocket();
    act(() => { first.serverConnect(); });
    useAuth.mockReturnValue({ token: 't2', currentUser: { _id: 'u1' } });
    act(() => { root.render(<StrictMode><SocketProvider><Room /></SocketProvider></StrictMode>); });
    const second = liveSocket();
    expect(second).not.toBe(first);
    act(() => { second.serverConnect(); });
    expect(lastRoomEvent(second, '42')).toBe('joinPod');
  });
});
