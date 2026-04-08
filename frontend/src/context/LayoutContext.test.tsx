// @ts-nocheck
import React, { act } from 'react';
import ReactDOM from 'react-dom/client';
import TestUtils from 'react-dom/test-utils';
import { LayoutProvider, useLayout } from './LayoutContext';

const TestComponent = () => {
  const { isDashboardCollapsed, toggleDashboard } = useLayout();
  return (
    <div>
      <span data-testid="state">{String(isDashboardCollapsed)}</span>
      <button onClick={toggleDashboard}>toggle</button>
    </div>
  );
};

let container;
let root;

beforeEach(() => {
  localStorage.clear();
  document.body.className = '';
  container = document.createElement('div');
  document.body.appendChild(container);
  root = ReactDOM.createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  container = null;
});

describe('LayoutContext', () => {
  test('initializes from localStorage and toggles state', () => {
    localStorage.setItem('dashboardCollapsed', 'true');

    act(() => {
      root.render(
        <LayoutProvider>
          <TestComponent />
        </LayoutProvider>
      );
    });

    const span = container.querySelector('[data-testid="state"]');
    expect(span.textContent).toBe('true');
    expect(document.body.classList.contains('dashboard-collapsed')).toBe(true);

    const button = container.querySelector('button');
    act(() => {
      TestUtils.Simulate.click(button);
    });

    expect(span.textContent).toBe('false');
    expect(localStorage.getItem('dashboardCollapsed')).toBe('false');
    expect(document.body.classList.contains('dashboard-collapsed')).toBe(false);
  });
});
