import React from 'react';
import ReactDOM from 'react-dom/client';
import TestUtils from 'react-dom/test-utils';
import SearchBar from './SearchBar';
import { useNavigate, useLocation } from 'react-router-dom';
const axios = require('axios').default;

jest.mock('axios', () => ({
  __esModule: true,
  default: { get: jest.fn() }
}));
jest.mock('react-router-dom', () => ({
  useNavigate: jest.fn(),
  useLocation: jest.fn()
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
});

test('typing triggers local search on feed page', async () => {
  const navigate = jest.fn();
  useNavigate.mockReturnValue(navigate);
  useLocation.mockReturnValue({ pathname: '/feed', search: '' });
  axios.get.mockResolvedValue({ data: ['r'] });
  const onResults = jest.fn();
  await TestUtils.act(async () => {
    root.render(<SearchBar onSearchResults={onResults} />);
  });
  const input = container.querySelector('input');
  await TestUtils.act(async () => {
    TestUtils.Simulate.change(input, { target: { value: 'hello' } });
  });
  expect(axios.get).toHaveBeenCalledWith('/api/posts/search', { params: { query: 'hello' } });
  expect(onResults).toHaveBeenCalledWith(['r']);
});

test('submitting navigates to feed with query', () => {
  const navigate = jest.fn();
  useNavigate.mockReturnValue(navigate);
  useLocation.mockReturnValue({ pathname: '/other', search: '' });
  const onResults = jest.fn();
  TestUtils.act(() => {
    root.render(<SearchBar onSearchResults={onResults} />);
  });
  const input = container.querySelector('input');
  const form = container.querySelector('form');
  TestUtils.act(() => {
    TestUtils.Simulate.change(input, { target: { value: 'abc' } });
  });
  TestUtils.act(() => {
    TestUtils.Simulate.submit(form);
  });
  expect(navigate).toHaveBeenCalledWith({ pathname: '/feed', search: 'q=abc' });
});

test('mount with query param triggers search', async () => {
  const navigate = jest.fn();
  useNavigate.mockReturnValue(navigate);
  useLocation.mockReturnValue({ pathname: '/feed', search: '?q=tag' });
  axios.get.mockResolvedValue({ data: ['x'] });
  const onResults = jest.fn();
  await TestUtils.act(async () => {
    root.render(<SearchBar onSearchResults={onResults} />);
  });
  await TestUtils.act(async () => Promise.resolve());
  expect(axios.get).toHaveBeenCalledWith('/api/posts/search', { params: { query: 'tag' } });
  expect(onResults).toHaveBeenCalledWith(['x']);
});

test('empty submit fetches all posts', async () => {
  const navigate = jest.fn();
  useNavigate.mockReturnValue(navigate);
  useLocation.mockReturnValue({ pathname: '/feed', search: '' });
  axios.get.mockResolvedValue({ data: ['all'] });
  const onResults = jest.fn();
  await TestUtils.act(async () => {
    root.render(<SearchBar onSearchResults={onResults} />);
  });
  const form = container.querySelector('form');
  await TestUtils.act(async () => {
    TestUtils.Simulate.submit(form);
  });
  expect(axios.get).toHaveBeenCalledWith('/api/posts', { headers: { Authorization: 'Bearer t' } });
  expect(onResults).toHaveBeenCalledWith(['all']);
});

test('adds pod-search class on pod pages', () => {
  useNavigate.mockReturnValue(jest.fn());
  useLocation.mockReturnValue({ pathname: '/pods/chat', search: '' });
  const onResults = jest.fn();
  TestUtils.act(() => {
    root.render(<SearchBar onSearchResults={onResults} />);
  });
  const div = container.querySelector('.search-bar');
  expect(div.className).toContain('pod-search');
});
