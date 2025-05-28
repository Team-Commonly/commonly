import { setRefreshFlag, checkAndRefresh } from './refreshUtils';

describe('refreshUtils', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    sessionStorage.clear();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, reload: jest.fn() },
    });
  });

  afterEach(() => {
    jest.useRealTimers();
    // Reset the location object
    delete window.location;
    window.location = new URL('http://localhost');
  });

  test('setRefreshFlag stores value in sessionStorage', () => {
    setRefreshFlag('flag', 2);
    expect(sessionStorage.getItem('flag')).toBe('2');
  });

  test('checkAndRefresh triggers reload and clears flag when count is 1', () => {
    setRefreshFlag('flag', 1);
    checkAndRefresh('flag');
    jest.runAllTimers();
    expect(window.location.reload).toHaveBeenCalled();
    expect(sessionStorage.getItem('flag')).toBeNull();
  });

  test('checkAndRefresh decrements count when greater than 1', () => {
    setRefreshFlag('flag', 3);
    checkAndRefresh('flag');
    expect(sessionStorage.getItem('flag')).toBe('2');
  });
});
