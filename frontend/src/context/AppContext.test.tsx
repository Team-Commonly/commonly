// @ts-nocheck
import React, { act } from 'react';
import ReactDOM from 'react-dom/client';
import TestUtils from 'react-dom/test-utils';
import { AppProvider, useAppContext } from './AppContext';

jest.mock('axios', () => ({ get: jest.fn(), post: jest.fn(), put: jest.fn() }));

const TestComponent = () => {
  const { posts, setPosts, updatePost, removePost } = useAppContext();
  return (
    <div>
      <span data-testid="posts">{JSON.stringify(posts)}</span>
      <button onClick={() => setPosts([{ _id: '1', title: 'hello' }])}>init</button>
      <button onClick={() => updatePost('1', { title: 'world' })}>update</button>
      <button onClick={() => removePost('1')}>remove</button>
    </div>
  );
};

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
});

describe('AppContext post helpers', () => {
  test('updatePost and removePost modify posts array', () => {
    act(() => {
      root.render(
        <AppProvider>
          <TestComponent />
        </AppProvider>
      );
    });

    const span = container.querySelector('[data-testid="posts"]');
    expect(span.textContent).toBe('[]');

    const [initBtn, updateBtn, removeBtn] = container.querySelectorAll('button');

    act(() => {
      TestUtils.Simulate.click(initBtn);
    });
    expect(span.textContent).toContain('hello');

    act(() => {
      TestUtils.Simulate.click(updateBtn);
    });
    expect(span.textContent).toContain('world');

    act(() => {
      TestUtils.Simulate.click(removeBtn);
    });
    expect(span.textContent).toBe('[]');
  });
});
