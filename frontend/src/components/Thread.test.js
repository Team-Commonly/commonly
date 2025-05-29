import React from 'react';
import ReactDOM from 'react-dom/client';
import TestUtils from 'react-dom/test-utils';
import Thread from './Thread';
import { useParams, useNavigate } from 'react-router-dom';
import { useAppContext } from '../context/AppContext';
const axios = require('axios').default;

jest.mock('axios', () => ({
  __esModule: true,
  default: { get: jest.fn(), post: jest.fn(), delete: jest.fn() }
}));
jest.mock('../context/AppContext', () => ({ useAppContext: jest.fn() }));
jest.mock('react-router-dom', () => ({
  useParams: jest.fn(),
  useNavigate: jest.fn()
}));

let container;
let root;

beforeEach(() => {
  jest.resetAllMocks();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = ReactDOM.createRoot(container);
  localStorage.setItem('token', 't');
  useParams.mockReturnValue({ id: '1' });
  useNavigate.mockReturnValue(jest.fn());
});

afterEach(() => {
  root.unmount();
  container.remove();
  container = null;
  localStorage.clear();
});

const mockPost = {
  _id: '1',
  content: 'thread post',
  userId: { _id: 'u1', username: 'user', profilePicture: null },
  createdAt: new Date().toISOString(),
  comments: [],
  likes: 0,
  likedBy: []
};

async function renderThread(ctx = {}) {
  useAppContext.mockReturnValue({ currentUser: { _id: 'u2' }, refreshData: jest.fn(), removePost: jest.fn(), ...ctx });
  axios.get.mockResolvedValueOnce({ data: mockPost });
  await TestUtils.act(async () => { root.render(<Thread />); });
  await TestUtils.act(async () => Promise.resolve());
}

test('fetches post and displays content', async () => {
  await renderThread();
  expect(axios.get).toHaveBeenCalledWith('/api/posts/1');
  expect(container.textContent).toContain('thread post');
});

test('submitting comment posts and updates UI', async () => {
  await renderThread();
  axios.post.mockResolvedValue({ data: { _id: 'c1', text: 'hi', userId: { _id: 'u2', username: 'me' }, createdAt: new Date().toISOString() } });
  const textarea = container.querySelector('textarea');
  const form = container.querySelector('form');
  TestUtils.act(() => { TestUtils.Simulate.change(textarea, { target: { value: 'hi' } }); });
  await TestUtils.act(async () => { TestUtils.Simulate.submit(form); });
  expect(axios.post).toHaveBeenCalledWith('/api/posts/1/comments', { text: 'hi' }, { headers: { Authorization: 'Bearer t' } });
  expect(container.textContent).toContain('hi');
});

test('liking post sends request', async () => {
  await renderThread();
  axios.post.mockResolvedValue({ data: { likes: 1, liked: true } });
  const likeBtn = container.querySelector('button');
  await TestUtils.act(async () => { TestUtils.Simulate.click(likeBtn); });
  expect(axios.post).toHaveBeenCalledWith('/api/posts/1/like', {}, { headers: { Authorization: 'Bearer t' } });
});
