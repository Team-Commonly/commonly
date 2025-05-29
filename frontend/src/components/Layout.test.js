import React from 'react';
import ReactDOM from 'react-dom/client';
import TestUtils from 'react-dom/test-utils';
import { useAuth } from '../context/AuthContext';
import { useLayout } from '../context/LayoutContext';
import { useLocation } from 'react-router-dom';

jest.mock('axios', () => ({ __esModule: true, default: {} }));
jest.mock('../context/AuthContext', () => ({ useAuth: jest.fn() }));
jest.mock('../context/LayoutContext', () => ({ useLayout: jest.fn() }));
jest.mock('../context/AppContext', () => ({ useAppContext: jest.fn() }));
jest.mock('./Dashboard', () => {
  const Dash = () => <div>Dashboard</div>;
  Dash.displayName = 'Dashboard';
  return { __esModule: true, default: Dash };
});
jest.mock('./SearchBar', () => {
  const Search = () => <div>Search</div>;
  Search.displayName = 'SearchBar';
  return { __esModule: true, default: Search };
});
jest.mock('react-router-dom', () => ({ Outlet: () => null, useLocation: jest.fn() }));

let Layout;
let container;
let root;

beforeEach(() => {
  Layout = require('./Layout').default;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = ReactDOM.createRoot(container);
  window.location = { href: '' };
});

afterEach(() => {
  root.unmount();
  container.remove();
  container = null;
});

test('redirects to login if not authenticated', () => {
  useAuth.mockReturnValue({ loading: false });
  useLayout.mockReturnValue({ isDashboardCollapsed: false, toggleDashboard: jest.fn() });
  useLocation.mockReturnValue({ pathname: '/feed' });
  localStorage.clear();
  TestUtils.act(() => { root.render(<Layout />); });
  expect(window.location.href).toBe('http://localhost/');
});
