const mockCapture = jest.fn();
const mockChunkLoad = jest.fn();

jest.mock('./sentry', () => {
  mockChunkLoad();
  return { __esModule: true, captureBoundaryError: mockCapture };
});

// Each call is a new page load: module state resets, sessionStorage does not.
const loadPage = () => {
  jest.resetModules();
  return require('./sentryReport').reportBoundaryError;
};

const capturedMessages = () => mockCapture.mock.calls.map(([error]) => error.message);

describe('reportBoundaryError', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv, REACT_APP_SENTRY_DSN: 'https://public@example.ingest.sentry.io/456' };
    sessionStorage.clear();
    mockCapture.mockReset();
    mockChunkLoad.mockReset();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('does nothing without a DSN, not even load the chunk', async () => {
    delete process.env.REACT_APP_SENTRY_DSN;

    await loadPage()(new Error('boom'), { boundary: 'app' });

    expect(mockChunkLoad).not.toHaveBeenCalled();
    expect(mockCapture).not.toHaveBeenCalled();
  });

  it('loads the chunk, then captures with the boundary and component stack', async () => {
    const error = new Error('boom');

    await loadPage()(error, { boundary: 'v2', componentStack: '\n    at Broken' });

    expect(mockChunkLoad).toHaveBeenCalledTimes(1);
    expect(mockCapture).toHaveBeenCalledTimes(1);
    expect(mockCapture).toHaveBeenCalledWith(error, { boundary: 'v2', componentStack: '\n    at Broken' });
  });

  it('reports one message once per boundary, across calls in flight and reloads', async () => {
    const report = loadPage();

    await Promise.all([
      report(new Error('boom'), { boundary: 'app' }),
      report(new Error('boom'), { boundary: 'app' }),
    ]);
    await report(new Error('boom'), { boundary: 'v2' });
    await report(new Error('another'), { boundary: 'app' });
    await loadPage()(new Error('boom'), { boundary: 'app' });

    expect(mockCapture.mock.calls.map(([error, { boundary }]) => `${boundary}:${error.message}`)).toEqual([
      'app:boom',
      'v2:boom',
      'app:another',
    ]);
  });

  it('caps a page load at five reports, and the next load can report again', async () => {
    const report = loadPage();
    for (let i = 0; i < 7; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await report(new Error(`crash ${i}`), { boundary: 'app' });
    }

    expect(capturedMessages()).toEqual(['crash 0', 'crash 1', 'crash 2', 'crash 3', 'crash 4']);

    // A report the cap dropped was never sent, so it is not marked as seen.
    await loadPage()(new Error('crash 5'), { boundary: 'app' });

    expect(capturedMessages()).toHaveLength(6);
  });

  it('dedupes within the page when sessionStorage throws', async () => {
    jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
    const report = loadPage();

    await report(new Error('boom'), { boundary: 'app' });
    await report(new Error('boom'), { boundary: 'app' });

    expect(mockCapture).toHaveBeenCalledTimes(1);
  });

  it('keeps no error text in sessionStorage', async () => {
    await loadPage()(new Error('boom ?invite=CM-SECRET'), { boundary: 'app' });

    expect(mockCapture).toHaveBeenCalledTimes(1);
    expect(JSON.stringify({ ...sessionStorage })).not.toContain('CM-SECRET');
  });

  it('resolves when the chunk load rejects, so nothing rejects unhandled', async () => {
    mockChunkLoad.mockImplementation(() => { throw new Error('chunk load failed'); });

    await expect(loadPage()(new Error('boom'), { boundary: 'app' })).resolves.toBeUndefined();

    expect(mockChunkLoad).toHaveBeenCalledTimes(1);
    expect(mockCapture).not.toHaveBeenCalled();
  });

  it('resolves when the capture itself throws', async () => {
    mockCapture.mockImplementation(() => { throw new Error('capture failed'); });

    await expect(loadPage()(new Error('boom'), { boundary: 'app' })).resolves.toBeUndefined();

    expect(mockCapture).toHaveBeenCalledTimes(1);
  });
});
