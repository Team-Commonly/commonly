// @ts-nocheck
import React, { useEffect } from 'react';
import ReactDOM from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { SocketProvider, useSocket } from './SocketContext';
import { useAuth } from './AuthContext';
import io from 'socket.io-client';

jest.mock('socket.io-client');
jest.mock('./AuthContext', () => ({ useAuth: jest.fn() }));
jest.mock('axios', () => ({ get: jest.fn(), post: jest.fn() }));

let container;
let root;
let socketHandlers;

const RoomConsumer = ({ podId = '42' }) => {
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
  const emit = jest.fn();
  socketHandlers = {};
  const on = jest.fn((event, cb) => {
    socketHandlers[event] = cb;
    if (event === 'connect') cb();
  });
  const disconnect = jest.fn();
  io.mockReturnValue({ emit, on, disconnect });
  useAuth.mockReturnValue({ token: 't', currentUser: { _id: 'u1' } });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  container = null;
});

test('joinPod and sendMessage emit events', () => {
  let value;
  const Test = () => { value = useSocket(); return null; };
  act(() => {
    root.render(<SocketProvider><Test /></SocketProvider>);
  });

  act(() => { value.joinPod('42'); });
  expect(io.mock.results[io.mock.results.length - 1].value.emit).toHaveBeenCalledWith('joinPod', '42');

  act(() => { value.sendMessage('42', 'hi'); });
  expect(io.mock.results[io.mock.results.length - 1].value.emit).toHaveBeenCalledWith('sendMessage', {
    podId: '42', content: 'hi', messageType: 'text', userId: 'u1'
  });
});

test('keeps a shared pod room until its last mounted consumer leaves', () => {
  const Rooms = ({ first, second }) => (
    <SocketProvider>
      {first && <RoomConsumer />}
      {second && <RoomConsumer />}
    </SocketProvider>
  );
  act(() => {
    root.render(<Rooms first second={false} />);
  });
  const socket = io.mock.results[io.mock.results.length - 1].value;
  expect(socket.emit).toHaveBeenCalledWith('joinPod', '42');

  expect(socket.emit).toHaveBeenCalledTimes(1);
  act(() => { root.render(<Rooms first second />); });
  expect(socket.emit).toHaveBeenCalledTimes(1);

  act(() => { root.render(<Rooms first second={false} />); });
  expect(socket.emit).not.toHaveBeenCalledWith('leavePod', '42');
  act(() => { root.render(<Rooms first={false} second={false} />); });
  expect(socket.emit).toHaveBeenCalledWith('leavePod', '42');
});

test('re-joins rooms after a socket reconnect', () => {
  act(() => {
    root.render(<SocketProvider><RoomConsumer /></SocketProvider>);
  });
  const socket = io.mock.results[io.mock.results.length - 1].value;
  expect(socket.emit).toHaveBeenCalledWith('joinPod', '42');

  // Keep both callbacks in one React batch: if reconnect happens before a
  // connected=false render, the provider's connect handler itself must restore
  // the room rather than relying on the consumer effect to re-run.
  act(() => {
    socketHandlers.disconnect('transport close');
    socketHandlers.connect();
  });
  expect(socket.emit.mock.calls.filter(([event, podId]) => event === 'joinPod' && podId === '42')).toHaveLength(2);
});
