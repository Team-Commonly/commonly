import React from 'react';
import ReactDOM from 'react-dom/client';
import TestUtils from 'react-dom/test-utils';
import ChatRoom from './ChatRoom';
import { useAuth } from '../context/AuthContext';
import { useSocket } from '../context/SocketContext';
import { useLayout } from '../context/LayoutContext';
import { useParams, useNavigate } from 'react-router-dom';
const axios = require('axios');

jest.mock('axios', () => ({ get: jest.fn(), post: jest.fn(), delete: jest.fn() }));
jest.mock('../context/AuthContext', () => ({ useAuth: jest.fn() }));
jest.mock('../context/SocketContext', () => ({ useSocket: jest.fn() }));
jest.mock('../context/LayoutContext', () => ({ useLayout: jest.fn() }));
jest.mock('react-router-dom', () => ({ useParams: jest.fn(), useNavigate: jest.fn() }));
jest.mock('../utils/avatarUtils', () => ({ getAvatarColor: () => 'red' }));
jest.mock('emoji-picker-react', () => {
  const Picker = () => <div>emoji</div>;
  Picker.displayName = 'EmojiPickerMock';
  return Picker;
});

let container;
let root;

beforeEach(() => {
  jest.resetAllMocks();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = ReactDOM.createRoot(container);
  useAuth.mockReturnValue({ currentUser: { _id: 'u1', username: 'A' } });
  useSocket.mockReturnValue({ socket: { on: jest.fn(), off: jest.fn() }, connected: false, pgAvailable: false, joinPod: jest.fn(), leavePod: jest.fn(), sendMessage: jest.fn() });
  useLayout.mockReturnValue({ isDashboardCollapsed: false });
  useParams.mockReturnValue({ podType: 'chat', roomId: '1' });
  useNavigate.mockReturnValue(jest.fn());
});

afterEach(() => {
  TestUtils.act(() => root.unmount());
  container.remove();
  container = null;
});

test('fetches pod data on mount', async () => {
  axios.get.mockResolvedValueOnce({ data: { available: false } });
  axios.get.mockResolvedValueOnce({ data: { _id: '1', name: 'Room', createdBy: { _id: 'u1' }, members: [] } });
  axios.get.mockResolvedValue({ data: [] });
  await TestUtils.act(async () => { root.render(<ChatRoom />); });
  await TestUtils.act(async () => Promise.resolve());
  expect(axios.get).toHaveBeenCalledWith('/api/pods/chat/1', expect.anything());
  expect(container.textContent).toContain('Room');
});
