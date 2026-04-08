// @ts-nocheck
import React from 'react';
import ReactDOM from 'react-dom/client';
import TestUtils from 'react-dom/test-utils';
import { act } from 'react-dom/test-utils';
import Login from './Login';
import Register from './Register';
import VerifyEmail from './VerifyEmail';
import Layout from './Layout';
import Dashboard from './Dashboard';
import PostFeed from './PostFeed';
import Thread from './Thread';
import UserProfile from './UserProfile';
import { useAuth } from '../context/AuthContext';
import { useAppContext } from '../context/AppContext';
import { useLayout as useLayoutCtx } from '../context/LayoutContext';
import { useSocket } from '../context/SocketContext';
import { useNavigate, useParams, useSearchParams, useLocation, useOutletContext } from 'react-router-dom';
const axios = require('axios').default;

jest.mock('axios', () => ({
  __esModule: true,
  default: {
    get: jest.fn(),
    post: jest.fn(),
    defaults: {},
    interceptors: {
      request: { use: jest.fn() },
    },
  }
}));

jest.mock('../context/AuthContext', () => ({ useAuth: jest.fn() }));
jest.mock('../context/AppContext', () => ({ useAppContext: jest.fn() }));
jest.mock('../context/LayoutContext', () => ({ useLayout: jest.fn() }));
jest.mock('../context/SocketContext', () => ({ useSocket: jest.fn() }));

jest.mock('react-router-dom', () => ({
  useNavigate: jest.fn(),
  useParams: jest.fn(),
  useSearchParams: jest.fn(),
  useLocation: jest.fn(),
  useOutletContext: jest.fn(),
  Navigate: () => <div>Navigate</div>,
  Outlet: () => <div>Outlet</div>,
  Link: ({ children }) => <a href="#">{children}</a>
}));

let container;
let root;

beforeEach(() => {
  jest.resetAllMocks();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = ReactDOM.createRoot(container);
  useNavigate.mockReturnValue(jest.fn());
  useParams.mockReturnValue({ id: '1', podType: 'chat', roomId: '1' });
  useSearchParams.mockReturnValue([{ get: () => 'tok' }]);
  useLocation.mockReturnValue({ pathname: '/feed', search: '' });
  useAuth.mockReturnValue({ loading: false, currentUser: { username: 'u' } });
  useAppContext.mockReturnValue({
    currentUser: { username: 'u', email: 'e' },
    userLoading: false,
    refreshData: jest.fn()
  });
  useLayoutCtx.mockReturnValue({
    isDashboardCollapsed: false,
    toggleDashboard: jest.fn()
  });
  useSocket.mockReturnValue({
    socket: { on: jest.fn(), emit: jest.fn() },
    joinPod: jest.fn(),
    leavePod: jest.fn(),
    sendMessage: jest.fn(),
    connected: true,
    pgAvailable: true
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  container = null;
  localStorage.clear();
});

function render(comp) {
  act(() => { root.render(comp); });
  return container.textContent;
}

test('Login renders and submits', async () => {
  axios.post.mockResolvedValue({ data: { token: 't', verified: true } });
  await TestUtils.act(async () => {
    root.render(<Login />);
  });
  const form = container.querySelector('form');
  await TestUtils.act(async () => {
    TestUtils.Simulate.submit(form);
  });
  expect(axios.post).toHaveBeenCalled();
  expect(localStorage.getItem('token')).toBe('t');
});

test('Register renders and submits', async () => {
  axios.get.mockResolvedValueOnce({ data: { inviteOnly: false } });
  axios.post.mockResolvedValue({ data: { message: 'ok' } });
  await TestUtils.act(async () => { root.render(<Register />); });
  const form = container.querySelector('form');
  await TestUtils.act(async () => { TestUtils.Simulate.submit(form); });
  expect(axios.post).toHaveBeenCalled();
});

test('VerifyEmail fetches token', async () => {
  axios.get.mockResolvedValue({ data: { message: 'verified' } });
  await TestUtils.act(async () => { root.render(<VerifyEmail />); });
  await TestUtils.act(async () => Promise.resolve());
  expect(container.textContent).toContain('verified');
});

test('Layout and Dashboard render', () => {
  render(<Layout />);
  render(<Dashboard />);
});

test('PostFeed renders', async () => {
  axios.get.mockResolvedValueOnce({ data: [] });
  useOutletContext.mockReturnValue(null);
  await TestUtils.act(async () => { root.render(<PostFeed />); });
  await TestUtils.act(async () => Promise.resolve());
  expect(axios.get).toHaveBeenCalled();
});

test('Thread renders', async () => {
  axios.get.mockResolvedValueOnce({ data: { _id: '1', userId: { username: 'u' }, content: 'c', createdAt: Date.now(), comments: [] } });
  await TestUtils.act(async () => { root.render(<Thread />); });
  await TestUtils.act(async () => Promise.resolve());
  expect(axios.get).toHaveBeenCalled();
});

test('UserProfile renders', async () => {
  axios.get.mockResolvedValueOnce({ data: { username: 'u' } });
  await TestUtils.act(async () => { root.render(<UserProfile />); });
  await TestUtils.act(async () => Promise.resolve());
  expect(axios.get).toHaveBeenCalled();
});
