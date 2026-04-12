// @ts-nocheck
import React from 'react';
import ReactDOM from 'react-dom/client';
import TestUtils from 'react-dom/test-utils';
import Dashboard from './Dashboard';
import { useAppContext } from '../context/AppContext';
import { useLayout } from '../context/LayoutContext';
import { useLocation } from 'react-router-dom';

jest.mock('../context/AppContext', () => ({ useAppContext: jest.fn() }));
jest.mock('../context/LayoutContext', () => ({ useLayout: jest.fn() }));
jest.mock('react-router-dom', () => ({ useLocation: jest.fn() }));
// Mock axios to avoid ESM parsing issues
jest.mock('axios', () => ({
  __esModule: true,
  default: { get: jest.fn(), post: jest.fn() },
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
  localStorage.clear();
});

afterEach(() => {
  root.unmount();
  container.remove();
  container = null;
});

function renderDashboard() {
  TestUtils.act(() => {
    root.render(<Dashboard />);
  });
}

test('shows collapse button when collapsed and toggles on click', () => {
  const toggle = jest.fn();
  useAppContext.mockReturnValue({ currentUser: null, userLoading: false, refreshData: jest.fn() });
  useLayout.mockReturnValue({ isDashboardCollapsed: true, toggleDashboard: toggle });
  useLocation.mockReturnValue({ pathname: '/feed' });
  renderDashboard();
  const button = container.querySelector('button');
  TestUtils.act(() => { button.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  expect(toggle).toHaveBeenCalled();
});

test('shows feed item when expanded', () => {
  useAppContext.mockReturnValue({ currentUser: { username: 'u', email: 'e' }, userLoading: false, refreshData: jest.fn() });
  useLayout.mockReturnValue({ isDashboardCollapsed: false, toggleDashboard: jest.fn() });
  useLocation.mockReturnValue({ pathname: '/other' });
  renderDashboard();
  expect(container.textContent).toContain('Feed');
});

test('shows Agent Rooms sidebar item when expanded', () => {
  useAppContext.mockReturnValue({ currentUser: { username: 'u', email: 'e' }, userLoading: false, refreshData: jest.fn() });
  useLayout.mockReturnValue({ isDashboardCollapsed: false, toggleDashboard: jest.fn() });
  useLocation.mockReturnValue({ pathname: '/other' });
  renderDashboard();
  expect(container.textContent).toContain('Agent Rooms');
});

test('shows Pods and Agent Admin alongside Agent Rooms', () => {
  useAppContext.mockReturnValue({ currentUser: { username: 'u', email: 'e' }, userLoading: false, refreshData: jest.fn() });
  useLayout.mockReturnValue({ isDashboardCollapsed: false, toggleDashboard: jest.fn() });
  useLocation.mockReturnValue({ pathname: '/other' });
  renderDashboard();
  expect(container.textContent).toContain('Pods');
  expect(container.textContent).toContain('Agent Rooms');
  expect(container.textContent).toContain('Agent Admin');
});
