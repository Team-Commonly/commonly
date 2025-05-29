import React from 'react';
import ReactDOM from 'react-dom/client';
import TestUtils from 'react-dom/test-utils';
import PostFeed from './PostFeed';
import { useAppContext } from '../context/AppContext';
import { useOutletContext, useNavigate } from 'react-router-dom';
const axios = require('axios').default;

jest.mock('axios', () => ({
  __esModule: true,
  default: { get: jest.fn(), post: jest.fn(), delete: jest.fn() }
}));
jest.mock('../context/AppContext', () => ({ useAppContext: jest.fn() }));
jest.mock('react-router-dom', () => ({
  useNavigate: jest.fn(),
  useOutletContext: jest.fn()
}));

let container;
let root;

beforeEach(() => {
  jest.resetAllMocks();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = ReactDOM.createRoot(container);
  localStorage.setItem('token', 't');
});

afterEach(() => {
  root.unmount();
  container.remove();
  container = null;
  localStorage.clear();
  jest.useRealTimers();
  // reset location
  delete window.location;
  window.location = new URL('http://localhost');
});

const mockPost = {
  _id: '1',
  content: 'hello',
  userId: { _id: 'u1', username: 'user', profilePicture: null },
  likes: 0,
  comments: []
};

async function renderFeed(appCtx = {}) {
  useAppContext.mockReturnValue({
    currentUser: { _id: 'u2', username: 'other' },
    setPosts: jest.fn(),
    refreshData: jest.fn(),
    removePost: jest.fn(),
    postsLoading: false,
    ...appCtx
  });
  useOutletContext.mockReturnValue(null);
  useNavigate.mockReturnValue(jest.fn());
  axios.get.mockResolvedValueOnce({ data: [mockPost] });
  await TestUtils.act(async () => {
    root.render(<PostFeed />);
  });
  await TestUtils.act(async () => Promise.resolve());
}

test('fetches posts and displays them', async () => {
  await renderFeed();
  expect(axios.get).toHaveBeenCalledWith('/api/posts', { headers: { Authorization: 'Bearer t' } });
  expect(container.textContent).toContain('hello');
});

test('clicking like sends request and toggles', async () => {
  await renderFeed();
  axios.post.mockResolvedValue({ data: { likes: 1, liked: true } });
  const likeBtn = container.querySelector('.like-button');
  await TestUtils.act(async () => {
    TestUtils.Simulate.click(likeBtn);
  });
  await TestUtils.act(async () => Promise.resolve());
  expect(axios.post).toHaveBeenCalledWith('/api/posts/1/like', {}, { headers: { Authorization: 'Bearer t' } });
  expect(likeBtn.className).toContain('active');
});

test('creating post submits and reloads', async () => {
  Object.defineProperty(window, 'location', { configurable: true, value: { ...window.location, reload: jest.fn() } });
  useAppContext.mockReturnValue({ currentUser: { _id: 'u2', username: 'u' }, setPosts: jest.fn(), refreshData: jest.fn(), removePost: jest.fn(), postsLoading: false });
  useOutletContext.mockReturnValue(null);
  useNavigate.mockReturnValue(jest.fn());
  axios.get.mockResolvedValueOnce({ data: [] });
  axios.post.mockResolvedValue({});
  await TestUtils.act(async () => { root.render(<PostFeed />); });
  await TestUtils.act(async () => Promise.resolve());
  const textarea = container.querySelector('textarea');
  const postBtn = Array.from(container.querySelectorAll('button')).find(b => b.textContent === 'Post');
  TestUtils.act(() => { TestUtils.Simulate.change(textarea, { target: { value: '#tag hi' } }); });
  await TestUtils.act(async () => { TestUtils.Simulate.click(postBtn); });
  expect(axios.post).toHaveBeenCalledWith('/api/posts', { content: '#tag hi', tags: ['tag'] }, { headers: { Authorization: 'Bearer t' } });
  expect(window.location.reload).toHaveBeenCalled();
});

