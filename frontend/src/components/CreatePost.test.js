import React from 'react';
import ReactDOM from 'react-dom/client';
import TestUtils from 'react-dom/test-utils';
import { useNavigate } from 'react-router-dom';
import { useAppContext } from '../context/AppContext';
import { refreshPage } from '../utils/refreshUtils';
import CreatePost from './CreatePost';
const axios = require('axios').default;

jest.mock('axios', () => ({
  __esModule: true,
  default: { post: jest.fn(), get: jest.fn() }
}));
jest.mock('react-router-dom', () => ({ useNavigate: jest.fn() }));
jest.mock('../context/AppContext', () => ({ useAppContext: jest.fn() }));
jest.mock('../utils/refreshUtils', () => ({ refreshPage: jest.fn() }));

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
});

test('submitting creates post and navigates', async () => {
  const navigate = jest.fn();
  const refreshData = jest.fn();
  useNavigate.mockReturnValue(navigate);
  useAppContext.mockReturnValue({ refreshData });
  axios.get.mockResolvedValue({ data: [] });
  axios.post.mockResolvedValue({});
  await TestUtils.act(async () => {
    root.render(<CreatePost />);
  });
  const textarea = container.querySelector('textarea');
  const form = container.querySelector('form');
  TestUtils.act(() => {
    TestUtils.Simulate.change(textarea, { target: { value: '#tag hello' } });
  });
  await TestUtils.act(async () => {
    TestUtils.Simulate.submit(form);
  });
  expect(axios.post).toHaveBeenCalledWith(
    '/api/posts',
    { content: '#tag hello', tags: ['tag'], category: 'General' },
    { headers: { Authorization: 'Bearer t' } },
  );
  expect(refreshData).toHaveBeenCalled();
  expect(navigate).toHaveBeenCalledWith('/feed');
  expect(refreshPage).toHaveBeenCalledWith(500);
});
