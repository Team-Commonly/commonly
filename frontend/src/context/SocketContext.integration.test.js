import React from 'react';
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

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = ReactDOM.createRoot(container);
  const emit = jest.fn();
  const on = jest.fn((event, cb) => { if(event==='connect') cb(); });
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
  expect(io.mock.results[0].value.emit).toHaveBeenCalledWith('joinPod', '42');

  act(() => { value.sendMessage('42', 'hi'); });
  expect(io.mock.results[0].value.emit).toHaveBeenCalledWith('sendMessage', {
    podId: '42', content: 'hi', messageType: 'text', userId: 'u1'
  });
});
