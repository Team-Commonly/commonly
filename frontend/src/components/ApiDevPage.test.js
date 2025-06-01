import React from 'react';
import { createRoot } from 'react-dom/client';
import * as TestUtils from 'react-dom/test-utils';
import { MemoryRouter } from 'react-router-dom';
import ApiDevPage from './ApiDevPage';

// Mock the useAppContext hook
jest.mock('../context/AppContext', () => ({
  useAppContext: () => ({
    user: null,
    token: null,
  }),
}));

let container;
let root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  root.unmount();
  container.remove();
  container = null;
});

const renderApiDevPage = async () => {
  await TestUtils.act(async () => {
    root.render(
      <MemoryRouter>
        <ApiDevPage />
      </MemoryRouter>
    );
  });
};

test('renders API Development Tools title', async () => {
  await renderApiDevPage();
  expect(container.textContent).toContain('API Development Tools');
});

test('renders authentication section', async () => {
  await renderApiDevPage();
  expect(container.textContent).toContain('Authentication');
});

test('renders posts section', async () => {
  await renderApiDevPage();
  expect(container.textContent).toContain('Posts');
});

test('renders warning when not logged in', async () => {
  await renderApiDevPage();
  expect(container.textContent).toContain('You are not logged in');
});

test('component renders without crashing when user is not logged in', async () => {
  await renderApiDevPage();
  expect(container.textContent).toContain('API Development Tools');
}); 