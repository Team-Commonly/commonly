// TASK-172 slice 3: the deadline every vendor call on the hosted-MCP path
// carries. The mechanism is measured here, once, rather than at each call site —
// a fifteen-second wait is only testable where the deadline is a parameter; each
// call site asserts separately that it goes through this function.
const {
  UPSTREAM_TIMEOUT_MS,
  isTimeoutError,
  upstreamFetch,
} = require('../../../services/upstreamFetch');

describe('hosted-mcp: the deadline on an outbound vendor call', () => {
  test('the shipped deadline is fifteen seconds, asserted on the literal', () => {
    // Literal, not `UPSTREAM_TIMEOUT_MS`: an expectation that reads the constant
    // under test moves with its mutant and can never fail.
    expect(UPSTREAM_TIMEOUT_MS).toBe(15 * 1000);
  });

  test('sends the request it was handed, plus a signal that is not yet aborted', async () => {
    const seen = [];
    const response = { ok: true, status: 200 };
    const got = await upstreamFetch(
      'https://mcp.linear.app/token',
      { method: 'POST', headers: { Accept: 'application/json' } },
      async (url, init) => { seen.push([url, init]); return response; },
    );

    expect(got).toBe(response);
    expect(seen).toHaveLength(1);
    const [url, init] = seen[0];
    expect(url).toBe('https://mcp.linear.app/token');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ Accept: 'application/json' });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.signal.aborted).toBe(false);
  });

  test('refuses a call the vendor never answers, once the deadline passes', async () => {
    // The failure this exists for: a socket that is accepted and then goes
    // quiet. The request is the fetch contract — abort the signal and the pending
    // fetch rejects with the signal's reason — and twenty milliseconds stands in
    // for the literal asserted above.
    const stalled = (url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason));
    });

    const error = await upstreamFetch('https://mcp.linear.app/token', {}, stalled, 20).catch((e) => e);

    expect(error.name).toBe('TimeoutError');
    expect(isTimeoutError(error)).toBe(true);
  });

  test('a deadline is told apart from any other failure, in both directions', () => {
    expect(isTimeoutError(Object.assign(new Error('ECONNREFUSED'), { name: 'Error' }))).toBe(false);
    expect(isTimeoutError(Object.assign(new Error('the operation timed out'), { name: 'TimeoutError' }))).toBe(true);
    expect(isTimeoutError(undefined)).toBe(false);
  });
});
