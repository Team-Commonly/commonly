import React from 'react';
import ReactDOM from 'react-dom/client';
import TestUtils from 'react-dom/test-utils';

jest.mock('../context/AuthContext', () => ({ useAuth: jest.fn() }));
jest.mock('../context/LayoutContext', () => ({ useLayout: jest.fn() }));
jest.mock('./Dashboard', () => () => <div data-testid="dash" />);
jest.mock('./SearchBar', () => () => <div data-testid="search" />);
jest.mock('react-router-dom', () => ({
  Outlet: () => <div data-testid="outlet" />,
  useLocation: jest.fn()
}));

import { useAuth } from '../context/AuthContext';
import { useLayout } from '../context/LayoutContext';
import { useLocation } from 'react-router-dom';
import Layout from './Layout';

let container;
let root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = ReactDOM.createRoot(container);
  delete window.location;
  window.location = { href: '' };
});

afterEach(() => {
  TestUtils.act(() => root.unmount());
  container.remove();
  container = null;
});

test('redirects to login when no token', () => {
  useAuth.mockReturnValue({ loading: false });
  useLayout.mockReturnValue({ isDashboardCollapsed: false, toggleDashboard: jest.fn() });
  useLocation.mockReturnValue({ pathname: '/' });
  localStorage.removeItem('token');
  TestUtils.act(() => { root.render(<Layout />); });
  expect(window.location.href).toBe('/');
});

test('shows loader when loading', () => {
  useAuth.mockReturnValue({ loading: true });
  useLayout.mockReturnValue({ isDashboardCollapsed: false, toggleDashboard: jest.fn() });
  useLocation.mockReturnValue({ pathname: '/' });
  TestUtils.act(() => { root.render(<Layout />); });
  expect(container.querySelector('svg')).toBeTruthy();
});
