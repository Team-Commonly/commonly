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
  default: { get: jest.fn(), post: jest.fn(), delete: jest.fn() }
}));
jest.mock('../context/AuthContext', () => ({
  useAuth: jest.fn(),
  AuthContext: {
    _currentValue: { user: { _id: 'u', username: 'me', profilePicture: null } },
    Provider: ({ children }) => children,
    Consumer: ({ children }) => children({ user: { _id: 'u', username: 'me', profilePicture: null } })
  }
}));
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
  // Restore getBoundingClientRect after resetAllMocks clears the setupTests mock
  Element.prototype.getBoundingClientRect = jest.fn(() => ({
    width: 120, height: 120, top: 0, left: 0,
    bottom: 0, right: 0, x: 0, y: 0, toJSON: jest.fn(),
  }));
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
    .mockResolvedValueOnce({ data: [{ _id: 'm1', content: 'hello', messageType: 'text', userId: { _id: 'u' }, createdAt: '2020-01-01' }] })
    .mockResolvedValueOnce({ data: [] })
    .mockResolvedValueOnce({ data: { entries: [] } });

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

test('renders integration summary bot messages', async () => {
  const botMessage = {
    type: 'integration-summary',
    source: 'slack',
    sourceLabel: 'Slack',
    channel: 'general',
    messageCount: 2,
    timeRange: { start: '2025-01-01T00:00:00Z', end: '2025-01-01T01:00:00Z' },
    summary: 'AI summary text'
  };

  axios.get
    .mockResolvedValueOnce({ data: { _id: '1', name: 'Room', members: [{ _id: 'u' }], createdBy: { _id: 'u', username: 'me', profilePicture: null } } })
    .mockResolvedValueOnce({ data: [] })
    .mockResolvedValueOnce({ data: [] })
    .mockResolvedValueOnce({
      data: [{
        _id: 'm2',
        content: `[BOT_MESSAGE]${JSON.stringify(botMessage)}`,
        messageType: 'text',
        userId: { _id: 'bot', username: 'commonly-bot' },
        createdAt: '2025-01-01'
      }]
    })
    .mockResolvedValueOnce({ data: [] })
    .mockResolvedValueOnce({ data: { entries: [] } });

  await TestUtils.act(async () => { root.render(<ChatRoom />); });
  await TestUtils.act(async () => Promise.resolve());

  expect(container.textContent).toContain('Slack Update');
  expect(container.textContent).toContain('#general');
  expect(container.textContent).toContain('AI summary text');
});

test('shows remove member button for pod admin', async () => {
  axios.get
    .mockResolvedValueOnce({
      data: {
        _id: '1',
        name: 'Room',
        members: [
          { _id: 'u', username: 'me', profilePicture: null },
          { _id: 'u2', username: 'other', profilePicture: null }
        ],
        createdBy: { _id: 'u', username: 'me', profilePicture: null }
      }
    })
    .mockResolvedValueOnce({ data: [] })
    .mockResolvedValueOnce({ data: [] })
    .mockResolvedValueOnce({ data: [] })
    .mockResolvedValueOnce({ data: [] })
    .mockResolvedValueOnce({ data: { entries: [] } });

  await TestUtils.act(async () => { root.render(<ChatRoom />); });
  await TestUtils.act(async () => Promise.resolve());

  const removeButtons = container.querySelectorAll('button[aria-label="Remove member"]');
  expect(removeButtons.length).toBe(1);
});

test('renders agent display name for instance usernames in messages', async () => {
  axios.get
    .mockResolvedValueOnce({
      data: {
        _id: '1',
        name: 'Room',
        members: [{ _id: 'u' }],
        createdBy: { _id: 'u', username: 'me', profilePicture: null }
      }
    })
    .mockResolvedValueOnce({ data: [] })
    .mockResolvedValueOnce({ data: [] })
    .mockResolvedValueOnce({
      data: [{
        _id: 'm-agent',
        content: 'hello from agent',
        messageType: 'text',
        userId: { _id: 'a1', username: 'openclaw-liz', profilePicture: null },
        createdAt: '2026-01-01T00:00:00.000Z'
      }]
    })
    .mockResolvedValueOnce({ data: [] })
    .mockResolvedValueOnce({
      data: {
        agents: [{
          name: 'openclaw',
          instanceId: 'liz',
          displayName: 'Liz Assistant',
          iconUrl: '/api/uploads/liz.png',
          profile: { displayName: 'Liz Assistant' }
        }]
      }
    })
    .mockResolvedValueOnce({ data: { entries: [] } });

  await TestUtils.act(async () => { root.render(<ChatRoom />); });
  await TestUtils.act(async () => Promise.resolve());

  expect(container.textContent).toContain('Liz Assistant');
  expect(container.textContent).toContain('hello from agent');
});

test('renders system messages as lightweight notices', async () => {
  axios.get
    .mockResolvedValueOnce({
      data: {
        _id: '1',
        name: 'Room',
        members: [{ _id: 'u' }],
        createdBy: { _id: 'u', username: 'me', profilePicture: null }
      }
    })
    .mockResolvedValueOnce({ data: [] })
    .mockResolvedValueOnce({ data: [] })
    .mockResolvedValueOnce({
      data: [{
        _id: 'm-system',
        content: '[Encountered an issue - details sent to debug DM]',
        messageType: 'system',
        userId: { _id: 'bot', username: 'commonly-bot', profilePicture: null },
        createdAt: '2026-01-01T00:00:00.000Z'
      }]
    })
    .mockResolvedValueOnce({ data: [] })
    .mockResolvedValueOnce({ data: { entries: [] } });

  await TestUtils.act(async () => { root.render(<ChatRoom />); });
  await TestUtils.act(async () => Promise.resolve());

  expect(container.textContent).toContain('[Encountered an issue - details sent to debug DM]');
  expect(container.querySelector('.system-message')).toBeTruthy();
});
