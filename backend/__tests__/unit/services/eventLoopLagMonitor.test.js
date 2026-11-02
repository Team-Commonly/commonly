// The loop-lag monitor logs a window only when the loop itself stalled past
// the threshold. On 2026-11-02 a quiet stretch in the logs was read as a
// blocked loop, and it wasn't one. The histogram is the measurement: these
// tests pin when a window logs, what the line says, and that each window
// starts from zero.
const { startEventLoopLagMonitor } = require('../../../services/eventLoopLagMonitor');

const MS = 1e6;
const fakeHistogram = () => ({
  enable: jest.fn(),
  disable: jest.fn(),
  reset: jest.fn(function reset() { this.max = 0; this.p99 = 0; }),
  max: 0,
  p99: 0,
  percentile: jest.fn(function percentile() { return this.p99; }),
});

describe('startEventLoopLagMonitor', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('logs a window whose worst delay reached the threshold, with max and p99 in ms', () => {
    const histogram = fakeHistogram();
    const log = jest.fn();
    const stop = startEventLoopLagMonitor({ thresholdMs: 1000, windowMs: 10000, histogram, log });

    histogram.max = 1840 * MS;
    histogram.p99 = 1200 * MS;
    jest.advanceTimersByTime(10000);

    expect(log).toHaveBeenCalledWith('[loop-lag] max=1840ms p99=1200ms window=10s');
    stop();
  });

  it('says nothing for a window under the threshold, and starts each window from zero', () => {
    const histogram = fakeHistogram();
    const log = jest.fn();
    const stop = startEventLoopLagMonitor({ thresholdMs: 1000, windowMs: 10000, histogram, log });

    histogram.max = 596 * MS;
    jest.advanceTimersByTime(10000);
    expect(log).not.toHaveBeenCalled();
    expect(histogram.reset).toHaveBeenCalledTimes(1);

    // A stall in one window is not reported again in the next.
    histogram.max = 2500 * MS;
    jest.advanceTimersByTime(10000);
    jest.advanceTimersByTime(10000);
    expect(log).toHaveBeenCalledTimes(1);
    stop();
  });

  it('stops measuring and logging when stopped', () => {
    const histogram = fakeHistogram();
    const log = jest.fn();
    const stop = startEventLoopLagMonitor({ histogram, log });

    stop();
    histogram.max = 5000 * MS;
    jest.advanceTimersByTime(60000);

    expect(histogram.disable).toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('measures the real loop: a 1.2s synchronous block is seen by the default histogram', async () => {
    jest.useRealTimers();
    const log = jest.fn();
    // The block ends near 1.3s and the first window closes at 2s; stopping
    // 1.5s after the block leaves over a second before the second window.
    const stop = startEventLoopLagMonitor({ thresholdMs: 1000, windowMs: 2000, log });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const until = Date.now() + 1200;
    while (Date.now() < until) { /* block the loop on purpose */ }
    await new Promise((resolve) => setTimeout(resolve, 1500));
    stop();

    expect(log).toHaveBeenCalledTimes(1);
    const [line] = log.mock.calls[0];
    expect(Number(line.match(/max=(\d+)ms/)[1])).toBeGreaterThanOrEqual(1000);
  });
});
