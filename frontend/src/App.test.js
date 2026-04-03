import React, { act } from 'react';
import ReactDOM from 'react-dom/client';


jest.mock('./context/AuthContext', () => ({
  AuthProvider: ({ children }) => <>{children}</>,
  useAuth: () => ({})
}));
jest.mock('./context/AppContext', () => ({ AppProvider: ({ children }) => <>{children}</> }));
jest.mock('./context/SocketContext', () => ({ SocketProvider: ({ children }) => <>{children}</> }));
jest.mock('./context/LayoutContext', () => ({ LayoutProvider: ({ children }) => <>{children}</> }));
jest.mock('react-router-dom', () => ({
  BrowserRouter: ({ children }) => <>{children}</>,
  Routes: ({ children }) => <>{children}</>,
  Route: () => null,
  useLocation: () => ({ pathname: '/' })
}));

let container;
let root;
let App;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = ReactDOM.createRoot(container);
  App = require('./App').default;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  container = null;
  document.body.classList.remove('modern-ui');
});

test('adds class to body on mount', () => {
  act(() => {
    root.render(<App />);
  });
  expect(document.body.classList.contains('modern-ui')).toBe(true);
});

test('removes class on unmount', () => {
  act(() => {
    root.render(<App />);
  });
  expect(document.body.classList.contains('modern-ui')).toBe(true);
  act(() => {
    root.unmount();
  });
  expect(document.body.classList.contains('modern-ui')).toBe(false);
});
