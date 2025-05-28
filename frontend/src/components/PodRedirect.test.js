import React, { act } from 'react';
import ReactDOM from 'react-dom/client';
import TestUtils from 'react-dom/test-utils';
import PodRedirect from './PodRedirect';
import { useNavigate } from 'react-router-dom';

jest.mock('react-router-dom', () => ({
  ...jest.requireActual('react-router-dom'),
  useNavigate: jest.fn(),
}));

let container;
let root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = ReactDOM.createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  container = null;
  jest.useRealTimers();
});

describe('PodRedirect', () => {
  test('shows buttons after loading and navigates on click', () => {
    const navigate = jest.fn();
    useNavigate.mockReturnValue(navigate);
    jest.useFakeTimers();

    act(() => {
      root.render(<PodRedirect />);
    });

    act(() => {
      jest.runAllTimers();
    });

    const button = container.querySelector('button');
    expect(button.textContent).toBe('Chat Pods');

    act(() => {
      TestUtils.Simulate.click(button);
    });
    expect(navigate).toHaveBeenCalledWith('/pods/chat');
  });
});
