import { captureFirstTouchRef, cleanRef, readFirstTouchRef } from './firstTouch';

afterEach(() => {
  localStorage.clear();
  jest.restoreAllMocks();
});

describe('first-touch ref', () => {
  test('keeps the first ref a browser arrives with, and only the first', () => {
    expect(captureFirstTouchRef('?ref=X')).toBe('x');
    expect(captureFirstTouchRef('?ref=hn')).toBeNull();
    expect(readFirstTouchRef()).toBe('x');
  });

  test('a ref beside other params is still read (the re-engagement deep link)', () => {
    expect(captureFirstTouchRef('?mode=hosted&ref=email')).toBe('email');
  });

  test('a link without a ref, or with a dirty one, keeps nothing', () => {
    expect(captureFirstTouchRef('?next=/v2')).toBeNull();
    expect(captureFirstTouchRef('?ref=%3Cscript%3E')).toBeNull();
    expect(readFirstTouchRef()).toBeUndefined();
    // A dirty first ref does not use up the first touch.
    expect(captureFirstTouchRef('?ref=x')).toBe('x');
  });

  test('a stored value that is not a clean code reads as no ref', () => {
    localStorage.setItem('commonly.firstTouchRef', JSON.stringify({ ref: '<b>' }));
    expect(readFirstTouchRef()).toBeUndefined();
    localStorage.setItem('commonly.firstTouchRef', 'not json');
    expect(readFirstTouchRef()).toBeUndefined();
  });

  test('storage that throws (a private window) is no ref, never an error', () => {
    jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    expect(captureFirstTouchRef('?ref=x')).toBeNull();
    expect(readFirstTouchRef()).toBeUndefined();
  });

  test('the same rule as the backend: short, plain, lower-cased', () => {
    expect(cleanRef(' X-Thread_2 ')).toBe('x-thread_2');
    expect(cleanRef('a'.repeat(33))).toBeNull();
    expect(cleanRef('https://evil.example')).toBeNull();
    expect(cleanRef('__proto__')).toBeNull();
    expect(cleanRef('Constructor')).toBeNull();
  });
});
