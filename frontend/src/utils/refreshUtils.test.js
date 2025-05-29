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
  test("refreshPage triggers reload after delay", () => {
    const { refreshPage } = require("./refreshUtils");
    refreshPage(200);
    expect(window.location.reload).not.toHaveBeenCalled();
    jest.advanceTimersByTime(200);
    expect(window.location.reload).toHaveBeenCalled();
  });

  test("multipleRefreshes triggers reload for each delay", () => {
    const { multipleRefreshes } = require("./refreshUtils");
    multipleRefreshes([100, 200]);
    jest.advanceTimersByTime(100);
    expect(window.location.reload).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(100);
    expect(window.location.reload).toHaveBeenCalledTimes(2);
  });

});
