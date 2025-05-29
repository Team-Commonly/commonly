import React from 'react';
import ReactDOM from 'react-dom/client';
import TestUtils from 'react-dom/test-utils';
import Pod from './Pod';
import { useAuth } from '../context/AuthContext';
import { useNavigate, useParams } from 'react-router-dom';
const axios = require('axios').default;

jest.mock('axios', () => ({
  __esModule: true,
  default: { get: jest.fn(), post: jest.fn() }
}));
jest.mock('../context/AuthContext', () => ({ useAuth: jest.fn() }));
jest.mock('react-router-dom', () => ({
  useNavigate: jest.fn(),
  useParams: jest.fn()
}));

let container;
let root;

beforeEach(() => {
  jest.resetAllMocks();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = ReactDOM.createRoot(container);
  localStorage.setItem('token', 't');
  useAuth.mockReturnValue({ currentUser: { _id: 'u1' } });
  useNavigate.mockReturnValue(jest.fn());
  useParams.mockReturnValue({ podType: 'chat' });
});

afterEach(() => {
  root.unmount();
  container.remove();
  container = null;
  localStorage.clear();
});

const mockPod = { _id: '1', name: 'Room', description: 'Desc', type: 'chat', createdBy: { username: 'a' }, members: [] };

async function renderPod() {
  axios.get.mockResolvedValueOnce({ data: [mockPod] });
  await TestUtils.act(async () => {
    root.render(<Pod />);
  });
  // wait for useEffect
  await TestUtils.act(async () => Promise.resolve());
}

test('fetches pods and displays them', async () => {
  await renderPod();
  expect(axios.get).toHaveBeenCalledWith('/api/pods/chat');
  expect(container.textContent).toContain('Room');
});

test('join button posts and navigates', async () => {
  const navigate = jest.fn();
  useNavigate.mockReturnValue(navigate);
  axios.get.mockResolvedValueOnce({ data: [mockPod] });
  axios.post.mockResolvedValue({ data: mockPod });
  await TestUtils.act(async () => {
    root.render(<Pod />);
  });
  await TestUtils.act(async () => Promise.resolve());
  const joinBtn = Array.from(container.querySelectorAll('button')).find(b => b.textContent.includes('Join'));
  await TestUtils.act(async () => {
    TestUtils.Simulate.click(joinBtn);
  });
  expect(axios.post).toHaveBeenCalledWith('/api/pods/1/join', {}, { headers: { Authorization: 'Bearer t' } });
  expect(navigate).toHaveBeenCalledWith('/pods/chat/1');
});
