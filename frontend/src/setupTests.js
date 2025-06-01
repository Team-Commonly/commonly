// Import jest-dom matchers
import '@testing-library/jest-dom';

// Mock axios
jest.mock('axios', () => ({
  default: {
    get: jest.fn(() => Promise.resolve({ data: {} })),
    post: jest.fn(() => Promise.resolve({ data: {} })),
    put: jest.fn(() => Promise.resolve({ data: {} })),
    delete: jest.fn(() => Promise.resolve({ data: {} })),
  },
}));

// Mock IntersectionObserver
global.IntersectionObserver = class IntersectionObserver {
  disconnect() {}
  observe() {}
  unobserve() {}
};

// Mock ResizeObserver
global.ResizeObserver = class ResizeObserver {
  disconnect() {}
  observe() {}
  unobserve() {}
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
  value: (_element) => ({
    getPropertyValue: (property) => {
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
  createPortal: (node) => node,
}));

// Mock TextareaAutosize to prevent JSDOM compatibility issues
jest.mock('@mui/material/TextareaAutosize', () => {
  const React = require('react');
  const MockTextareaAutosize = React.forwardRef((props, ref) => {
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
global.IS_REACT_ACT_ENVIRONMENT = true;

// Comprehensive console.error suppression for test warnings
const originalError = console.error;
beforeAll(() => {
  console.error = (...args) => {
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