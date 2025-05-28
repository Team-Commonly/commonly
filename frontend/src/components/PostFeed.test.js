import React from 'react';
import ReactDOM from 'react-dom/client';
import TestUtils from 'react-dom/test-utils';
import PostFeed from './PostFeed';
import { useAppContext } from '../context/AppContext';
import { useNavigate } from 'react-router-dom';
const axios = require('axios');

jest.mock('axios', () => ({ get: jest.fn(), post: jest.fn(), delete: jest.fn() }));
jest.mock('../context/AppContext', () => ({ useAppContext: jest.fn() }));
jest.mock('react-router-dom', () => ({ useNavigate: jest.fn(), useOutletContext: () => null }));
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
  useAppContext.mockReturnValue({ currentUser: { _id: 'u1', username: 'A' }, refreshData: jest.fn(), setPosts: jest.fn(), removePost: jest.fn(), postsLoading: false });
  useNavigate.mockReturnValue(jest.fn());
});

afterEach(() => {
  TestUtils.act(() => root.unmount());
  container.remove();
  container = null;
});

test('loads posts on mount', async () => {
  axios.get.mockResolvedValueOnce({ data: [] });
  await TestUtils.act(async () => { root.render(<PostFeed />); });
  await TestUtils.act(async () => Promise.resolve());
  expect(axios.get).toHaveBeenCalled();
});
