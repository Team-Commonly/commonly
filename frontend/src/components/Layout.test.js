import React from 'react';
import ReactDOM from 'react-dom/client';
import TestUtils from 'react-dom/test-utils';
import { MemoryRouter } from 'react-router-dom';
import Layout from './Layout';
import { useAuth } from '../context/AuthContext';
import { useLayout as useLayoutCtx } from '../context/LayoutContext';

jest.mock('../context/AuthContext', () => ({ useAuth: jest.fn() }));
jest.mock('../context/LayoutContext', () => ({ useLayout: jest.fn() }));
jest.mock('./Dashboard', () => {
  const DashboardMock = () => <div>dash</div>;
  DashboardMock.displayName = 'DashboardMock';
  return DashboardMock;
});
jest.mock('./SearchBar', () => {
  const SearchBarMock = () => <div>search</div>;
  SearchBarMock.displayName = 'SearchBarMock';
  return { __esModule: true, default: SearchBarMock };
});

let container;
let root;
let oldLocation;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = ReactDOM.createRoot(container);
  oldLocation = window.location;
  delete window.location;
  window.location = { href: '' };
});

afterEach(() => {
  TestUtils.act(() => root.unmount());
  container.remove();
  container = null;
  window.location = oldLocation;
});

test('shows spinner when loading', () => {
  useAuth.mockReturnValue({ loading: true });
  useLayoutCtx.mockReturnValue({ isDashboardCollapsed: false, toggleDashboard: jest.fn() });
  TestUtils.act(() => { root.render(<MemoryRouter><Layout /></MemoryRouter>); });
  expect(container.querySelector('svg')).not.toBeNull();
});

test('redirects to login if no token', () => {
  useAuth.mockReturnValue({ loading: false });
  useLayoutCtx.mockReturnValue({ isDashboardCollapsed: false, toggleDashboard: jest.fn() });
  localStorage.removeItem('token');
  TestUtils.act(() => { root.render(<MemoryRouter><Layout /></MemoryRouter>); });
  expect(window.location.href).toBe('/');
});
