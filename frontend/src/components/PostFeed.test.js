import React from 'react';
import { createRoot } from 'react-dom/client';
import * as TestUtils from 'react-dom/test-utils';
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
  root = createRoot(container);
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

test('emoji picker opens when emoji button is clicked', async () => {
  await renderFeed();
  const emojiButton = container.querySelector('[data-testid="emoji-button"]');
  expect(emojiButton).toBeTruthy();
  
  await TestUtils.act(async () => {
    TestUtils.Simulate.click(emojiButton);
  });
  
  // Check if emoji picker portal exists
  const emojiPicker = document.querySelector('.emoji-picker-portal');
  expect(emojiPicker).toBeTruthy();
});

test('emoji picker closes when clicking outside', async () => {
  await renderFeed();
  
  // Open emoji picker
  const emojiButton = container.querySelector('[data-testid="emoji-button"]');
  await TestUtils.act(async () => {
    TestUtils.Simulate.click(emojiButton);
  });
  
  let emojiPicker = document.querySelector('.emoji-picker-portal');
  expect(emojiPicker).toBeTruthy();
  
  // Simulate clicking outside by triggering the document mousedown handler
  await TestUtils.act(async () => {
    // Create a proper mock DOM element
    const mockElement = document.createElement('div');
    mockElement.closest = jest.fn().mockReturnValue(null);
    
    const event = new MouseEvent('mousedown', { bubbles: true });
    Object.defineProperty(event, 'target', {
      value: mockElement,
      enumerable: true
    });
    
    document.dispatchEvent(event);
  });
  
  emojiPicker = document.querySelector('.emoji-picker-portal');
  expect(emojiPicker).toBeFalsy();
});

test('emoji picker portal is rendered with correct classes', async () => {
  await renderFeed();
  const emojiButton = container.querySelector('[data-testid="emoji-button"]');
  
  await TestUtils.act(async () => {
    TestUtils.Simulate.click(emojiButton);
  });
  
  const emojiPicker = document.querySelector('.emoji-picker-portal');
  expect(emojiPicker).toBeTruthy();
  expect(emojiPicker.classList.contains('emoji-picker-portal')).toBe(true);
  
  const emojiContainer = emojiPicker.querySelector('.emoji-picker-container');
  expect(emojiContainer).toBeTruthy();
});

test('emoji button has correct test id for accessibility', async () => {
  await renderFeed();
  const emojiButton = container.querySelector('[data-testid="emoji-button"]');
  expect(emojiButton).toBeTruthy();
  expect(emojiButton.getAttribute('data-testid')).toBe('emoji-button');
});

