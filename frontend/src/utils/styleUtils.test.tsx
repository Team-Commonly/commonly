// @ts-nocheck
import { forceReflow, applyBodyClass, applyStylesToElements, reloadStylesheets, forceImmediateStyleApplication } from './styleUtils';

describe('styleUtils', () => {
  test('forceReflow reads offsetHeight', () => {
    const el = document.createElement('div');
    
    // Mock offsetHeight as a getter
    let offsetHeightCalled = false;
    Object.defineProperty(el, 'offsetHeight', {
      get: jest.fn(() => {
        offsetHeightCalled = true;
        return 100;
      }),
      configurable: true
    });
    
    forceReflow(el);
    expect(offsetHeightCalled).toBe(true);
  });

  test('applyBodyClass adds and removes class on body', () => {
    const cleanup = applyBodyClass('test-class');
    expect(document.body.classList.contains('test-class')).toBe(true);
    cleanup();
    expect(document.body.classList.contains('test-class')).toBe(false);
  });

  test('applyStylesToElements applies class', () => {
    const el1 = document.createElement('div');
    el1.className = 't';
    const el2 = document.createElement('div');
    el2.className = 't';
    document.body.appendChild(el1);
    document.body.appendChild(el2);
    applyStylesToElements('.t');
    expect(el1.classList.contains('style-applied')).toBe(true);
    expect(el2.classList.contains('style-applied')).toBe(true);
    el1.remove();
    el2.remove();
  });

  test('reloadStylesheets replaces links', () => {
    jest.useFakeTimers();
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'style.css';
    document.head.appendChild(link);
    reloadStylesheets();
    const newLink = document.head.querySelector('link[rel="stylesheet"]:not([href="style.css"])');
    expect(newLink).toBeTruthy();
    jest.runAllTimers();
    expect(document.head.querySelector('link[href="style.css"]')).toBeNull();
    newLink.remove();
    jest.useRealTimers();
  });

  test('forceImmediateStyleApplication hides body temporarily', () => {
    jest.useFakeTimers();
    forceImmediateStyleApplication();
    expect(document.body.style.visibility).toBe('hidden');
    jest.runAllTimers();
    expect(document.body.style.visibility).toBe('');
    jest.useRealTimers();
  });
});
