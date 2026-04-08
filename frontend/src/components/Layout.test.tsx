// @ts-nocheck
import React from 'react';
import ReactDOM from 'react-dom/client';
import TestUtils from 'react-dom/test-utils';
import Layout from './Layout';
import { BrowserRouter } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useLayout } from '../context/LayoutContext';
import { useAppContext } from '../context/AppContext';
import { useLocation } from 'react-router-dom';

jest.mock('../context/AuthContext', () => ({ useAuth: jest.fn() }));
jest.mock('../context/LayoutContext', () => ({ useLayout: jest.fn() }));
jest.mock('../context/AppContext', () => ({ useAppContext: jest.fn() }));
jest.mock('react-router-dom', () => ({
  ...jest.requireActual('react-router-dom'),
  useLocation: jest.fn(),
}));
// axios is ESM; mock it so Jest doesn't try to parse the module
jest.mock('axios', () => ({
  __esModule: true,
  default: { get: jest.fn(), post: jest.fn() },
}));

// Mock Material UI hooks that depend on window.matchMedia
jest.mock('@mui/material', () => ({
  ...jest.requireActual('@mui/material'),
  useMediaQuery: () => false,
  useTheme: () => ({ breakpoints: { down: () => false } }),
}));

let container;
let root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = ReactDOM.createRoot(container);
  delete window.location;
  window.location = { href: 'start' };
  jest.resetAllMocks();
  // provide default context values so Dashboard can render
  useAppContext.mockReturnValue({ currentUser: null, userLoading: false, refreshData: jest.fn() });
  localStorage.clear();
});

afterEach(() => {
  root.unmount();
  container.remove();
  container = null;
});

function renderLayout() {
  TestUtils.act(() => {
    root.render(
      <BrowserRouter>
        <Layout />
      </BrowserRouter>
    );
  });
}

test('shows loading indicator when auth is loading', () => {
  useAuth.mockReturnValue({ loading: true });
  useLayout.mockReturnValue({ isDashboardCollapsed: false, toggleDashboard: jest.fn() });
  useLocation.mockReturnValue({ pathname: '/' });
  renderLayout();
  expect(container.querySelector('svg')).toBeTruthy();
});

test('redirects to root when no token found', () => {
  useAuth.mockReturnValue({ loading: false });
  useLayout.mockReturnValue({ isDashboardCollapsed: false, toggleDashboard: jest.fn() });
  useLocation.mockReturnValue({ pathname: '/' });
  renderLayout();
  expect(window.location.href).toBe('/');
});

test('calls toggleDashboard when button clicked', () => {
  localStorage.setItem('token', 't');
  const toggle = jest.fn();
  useAuth.mockReturnValue({ loading: false });
  useLayout.mockReturnValue({ isDashboardCollapsed: false, toggleDashboard: toggle });
  useLocation.mockReturnValue({ pathname: '/feed' });
  renderLayout();
  const button = container.querySelector('.toggle-dashboard-button');
  TestUtils.act(() => { TestUtils.Simulate.click(button); });
  expect(toggle).toHaveBeenCalled();
});

test('pod detail layout classes applied when on pod page', () => {
  localStorage.setItem('token', 't');
  useAuth.mockReturnValue({ loading: false });
  useLayout.mockReturnValue({ isDashboardCollapsed: true, toggleDashboard: jest.fn() });
  useLocation.mockReturnValue({ pathname: '/pods/chat/1' });
  renderLayout();
  expect(container.firstChild.className).toContain('pods-view');
  expect(container.firstChild.className).toContain('pod-detail');
  expect(container.firstChild.className).toContain('dashboard-collapsed');
});
