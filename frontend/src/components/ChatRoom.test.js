import React from 'react';
import ReactDOM from 'react-dom/client';
import TestUtils from 'react-dom/test-utils';
import ChatRoom from './ChatRoom';
import { useParams, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useSocket } from '../context/SocketContext';
import { useLayout } from '../context/LayoutContext';
const axios = require('axios').default;

jest.mock('axios', () => ({
  __esModule: true,
  default: { get: jest.fn(), post: jest.fn() }
}));
jest.mock('../context/AuthContext', () => ({ useAuth: jest.fn() }));
jest.mock('../context/SocketContext', () => ({ useSocket: jest.fn() }));
jest.mock('../context/LayoutContext', () => ({ useLayout: jest.fn() }));
jest.mock('react-router-dom', () => ({ useParams: jest.fn(), useNavigate: jest.fn() }));

let container;
let root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = ReactDOM.createRoot(container);
  jest.resetAllMocks();
  // JSDOM doesn't implement scrollIntoView
  Element.prototype.scrollIntoView = jest.fn();
  localStorage.setItem('token', 't');
  useAuth.mockReturnValue({ currentUser: { _id: 'u', username: 'me', profilePicture: null } });
  useSocket.mockReturnValue({
    socket: { on: jest.fn(), off: jest.fn() },
    connected: true,
    pgAvailable: false,
    joinPod: jest.fn(),
    leavePod: jest.fn(),
    sendMessage: jest.fn()
  });
  useLayout.mockReturnValue({ isDashboardCollapsed: false });
  useParams.mockReturnValue({ podType: 'chat', roomId: '1' });
  useNavigate.mockReturnValue(jest.fn());
});

afterEach(() => {
  root.unmount();
  container.remove();
  container = null;
  localStorage.clear();
});

test('loads room and messages then displays them', async () => {
  axios.get
    .mockResolvedValueOnce({ data: { _id: '1', name: 'Room', members: [{ _id: 'u' }], createdBy: { _id: 'u', username: 'me', profilePicture: null } } })
    .mockResolvedValueOnce({ data: [] })
    .mockResolvedValueOnce({ data: [] })
    .mockResolvedValueOnce({ data: [{ _id: 'm1', content: 'hello', messageType: 'text', userId: { _id: 'u' }, createdAt: '2020-01-01' }] });

  await TestUtils.act(async () => { root.render(<ChatRoom />); });
  await TestUtils.act(async () => Promise.resolve());

  expect(axios.get).toHaveBeenCalledWith('/api/pods/chat/1', { headers: { Authorization: 'Bearer t' } });
  expect(container.textContent).toContain('Room');
  expect(container.textContent).toContain('hello');
});

test('shows spinner while loading', () => {
  // Socket still mocked but axios not resolved yet
  TestUtils.act(() => { root.render(<ChatRoom />); });
  const svg = container.querySelector('svg');
  expect(svg).toBeTruthy();
});
