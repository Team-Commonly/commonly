// F65: one request's reads share a small number of pool connections, so a
// burst of requests does not queue chat and auth behind hundreds of reads.
const { limitConcurrency } = require('../../../utils/concurrencyLimit');

const tick = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

describe('limitConcurrency', () => {
  it('never runs more than its limit at once', async () => {
    const run = limitConcurrency(3);
    let inFlight = 0;
    let peak = 0;
    const task = async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await tick(5);
      inFlight -= 1;
    };
    await Promise.all(Array.from({ length: 10 }, () => run(task)));
    expect(peak).toBe(3);
  });

  it('runs every task and gives each caller its own result', async () => {
    const run = limitConcurrency(2);
    const results = await Promise.all([5, 1, 3, 2].map((n) => run(async () => { await tick(n); return n * 10; })));
    expect(results).toEqual([50, 10, 30, 20]);
  });

  it('turns a synchronous throw into a rejection and frees the slot', async () => {
    const run = limitConcurrency(1);
    const failed = run(() => { throw new Error('boom'); });
    const after = run(async () => 'ran');
    await expect(failed).rejects.toThrow('boom');
    await expect(after).resolves.toBe('ran');
  });

  it('frees the slot when a task rejects', async () => {
    const run = limitConcurrency(1);
    const failed = run(() => Promise.reject(new Error('nope')));
    const after = run(async () => 'ran');
    await expect(failed).rejects.toThrow('nope');
    await expect(after).resolves.toBe('ran');
  });

  it('runs a thenable once', async () => {
    const run = limitConcurrency(2);
    let runs = 0;
    const thenable = { then(resolve) { runs += 1; resolve('q'); } };
    await expect(run(() => thenable)).resolves.toBe('q');
    expect(runs).toBe(1);
  });
});
