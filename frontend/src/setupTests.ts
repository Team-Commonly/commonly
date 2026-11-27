// Import jest-dom matchers
import '@testing-library/jest-dom';
import { act, configure } from '@testing-library/react';
import { TextEncoder } from 'util';
import './i18n';

// jsdom omits this browser API; use Node's implementation for UTF-8 encoding.
Object.assign(global, { TextEncoder });

// Under fake timers, waitFor and findBy advance fake time in 50 ms rounds.
// In jsdom, React's scheduler runs on the real setTimeout it captured at
// import, so a state update that lands outside act (a mocked request resolving
// after render) waits on a real 1 ms timer. A round's only real yield was act's
// setImmediate, which runs before a timer queued in the same loop turn, so the
// update rendered only in a round where its timer was already due: a BYO page
// took 1 to 14 of the default 20 rounds, and a merge-queue run ran out (F679).
// Each round now ends with one real setTimeout(0), queued after the
// scheduler's, and every wait in that BYO file takes one round. A test that
// resets modules and requires Testing Library again gets a copy without this.
// Guard: src/__tests__/fakeTimerWaitFor.test.tsx.
const realSetTimeout: typeof setTimeout = jest.requireActual('timers').setTimeout;
configure({
  unstable_advanceTimersWrapper: async (advance) => {
    await act(async () => { await advance(); });
    await new Promise((resolve) => { realSetTimeout(resolve, 0); });
  },
});

// Mock axios
jest.mock('axios', () => ({
  __esModule: true,
  default: {
    defaults: { baseURL: '', headers: { common: {} } },
    interceptors: {
      request: { use: jest.fn(), eject: jest.fn() },
      response: { use: jest.fn(), eject: jest.fn() },
    },
    get: jest.fn(() => Promise.resolve({ data: {} })),
    post: jest.fn(() => Promise.resolve({ data: {} })),
    put: jest.fn(() => Promise.resolve({ data: {} })),
    delete: jest.fn(() => Promise.resolve({ data: {} })),
    patch: jest.fn(() => Promise.resolve({ data: {} })),
  },
}));

// Mock IntersectionObserver
(global as unknown as Record<string, unknown>).IntersectionObserver = class {
  disconnect(): void {}
  observe(): void {}
  unobserve(): void {}
};

// Mock ResizeObserver
(global as unknown as Record<string, unknown>).ResizeObserver = class {
  disconnect(): void {}
  observe(): void {}
  unobserve(): void {}
};

// Mock getBoundingClientRect
Element.prototype.getBoundingClientRect = jest.fn(() => ({
  width: 120,
  height: 120,
  top: 0,
  left: 0,
  bottom: 0,
  right: 0,
  x: 0,
  y: 0,
  toJSON: jest.fn()
}));

// Mock getComputedStyle for DOM accessibility API
Object.defineProperty(window, 'getComputedStyle', {
  value: (_element: Element) => ({
    getPropertyValue: (property: string) => {
      // Return appropriate values for common CSS properties
      if (property === 'display') return 'block';
      if (property === 'visibility') return 'visible';
      if (property === 'opacity') return '1';
      if (property === 'position') return 'static';
      if (property === 'clip') return 'auto';
      if (property === 'clip-path') return 'none';
      return '';
    },
    display: 'block',
    visibility: 'visible',
    opacity: '1',
    position: 'static',
    clip: 'auto',
    'clip-path': 'none'
  }),
  writable: true,
  configurable: true
});

// Mock HTMLElement properties
Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
  configurable: true,
  value: 120,
});

Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
  configurable: true,
  value: 120,
});

Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
  configurable: true,
  value: 120,
});

Object.defineProperty(HTMLElement.prototype, 'scrollWidth', {
  configurable: true,
  value: 120,
});

// Mock createPortal to avoid portal-related issues
jest.mock('react-dom', () => ({
  ...jest.requireActual('react-dom'),
  createPortal: (node: React.ReactNode) => node,
}));

// Mock TextareaAutosize to prevent JSDOM compatibility issues
jest.mock('@mui/material/TextareaAutosize', () => {
  const React = require('react');
  const MockTextareaAutosize = React.forwardRef((props: Record<string, unknown>, ref: React.Ref<HTMLTextAreaElement>) => {
    const { minRows, ...otherProps } = props;
    return React.createElement('textarea', {
      ...otherProps,
      ref,
      rows: minRows || 1,
    });
  });
  MockTextareaAutosize.displayName = 'MockTextareaAutosize';
  MockTextareaAutosize.propTypes = {
    minRows: require('prop-types').number,
  };
  return MockTextareaAutosize;
});

// Set up React testing environment
(global as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// Comprehensive console.error suppression for test warnings
const originalError = console.error;
beforeAll(() => {
  console.error = (...args: unknown[]) => {
    const message = args[0];
    if (typeof message === 'string') {
      // Suppress all React warnings that don't indicate actual test failures
      if (
        message.includes('Warning: An update to') ||
        message.includes('Warning: `ReactDOMTestUtils.act`') ||
        message.includes('Warning: Function components cannot be given refs') ||
        message.includes('When testing, code that causes React state updates')
      ) {
        return;
      }
    }
    originalError.call(console, ...args);
  };
});

afterAll(() => {
  console.error = originalError;
});
