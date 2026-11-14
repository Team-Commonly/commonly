/**
 * F525: the pasted line's connect code is traded for the agent's key. Fake
 * codes and keys only.
 */
import { jest } from '@jest/globals';
import { connectCodeRefusalLine, redeemConnectCode } from '../src/lib/connect-code.js';

const CODE = `cmc_${'A'.repeat(22)}`;
const failing = (status, body) => () => ({
  post: async () => { const err = new Error(`HTTP ${status}`); err.status = status; err.body = body; throw err; },
});

describe('redeemConnectCode', () => {
  test('trades the code for the key, sending no bearer', async () => {
    const post = jest.fn(async () => ({ token: 'cm_agent_fake_key' }));
    const clientFactory = jest.fn(() => ({ post }));
    const result = await redeemConnectCode({ code: CODE, instanceUrl: 'https://api.example.test', clientFactory });
    expect(result).toEqual({ token: 'cm_agent_fake_key' });
    expect(clientFactory).toHaveBeenCalledWith({ instance: 'https://api.example.test', token: null });
    expect(post).toHaveBeenCalledWith('/api/agents/runtime/connect-code', { code: CODE });
  });

  test('a malformed code never reaches the instance', async () => {
    const clientFactory = jest.fn();
    expect(await redeemConnectCode({ code: 'cm_agent_not_a_code', instanceUrl: 'x', clientFactory }))
      .toEqual({ refusal: 'invalid' });
    expect(clientFactory).not.toHaveBeenCalled();
  });

  test.each([
    ['connect_code_unknown', 404, 'unknown'],
    ['connect_code_used', 410, 'used'],
    ['connect_code_revoked', 410, 'revoked'],
    ['connect_code_rate_limited', 429, 'rate_limited'],
    ['invalid_connect_code', 400, 'invalid'],
  ])('reads %s as %s', async (code, status, refusal) => {
    expect(await redeemConnectCode({ code: CODE, instanceUrl: 'x', clientFactory: failing(status, { code }) }))
      .toEqual({ refusal });
  });

  test('an older instance without the route, or no answer, is unreachable with a reason', async () => {
    expect(await redeemConnectCode({ code: CODE, instanceUrl: 'x', clientFactory: failing(404, { message: 'Not Found' }) }))
      .toEqual({ refusal: 'unreachable', status: 404 });
    const offline = () => ({ post: async () => { throw new Error('fetch failed'); } });
    expect(await redeemConnectCode({ code: CODE, instanceUrl: 'x', clientFactory: offline }))
      .toEqual({ refusal: 'unreachable', detail: 'fetch failed' });
  });

  test('an answer that is not an agent key is refused', async () => {
    const odd = () => ({ post: async () => ({ token: 'cm_user_wrong_kind' }) });
    expect((await redeemConnectCode({ code: CODE, instanceUrl: 'x', clientFactory: odd })).refusal).toBe('unreachable');
  });
});

describe('connectCodeRefusalLine', () => {
  test('each refusal is one plain line that says what to do', () => {
    expect(connectCodeRefusalLine('unknown', { name: 'ada' }))
      .toBe("This line's connect code has expired: each one works for 30 minutes. Get a new line from the Connect your own agent page.");
    expect(connectCodeRefusalLine('used', { name: 'ada' })).toContain('On that computer, run: commonly agent run ada.');
    expect(connectCodeRefusalLine('unreachable', { instanceUrl: 'https://api.example.test', detail: 'fetch failed' }))
      .toBe("Couldn't reach https://api.example.test to use the connect code (fetch failed). Check this computer is online, then paste the line again.");
    expect(connectCodeRefusalLine('unreachable', { instanceUrl: 'https://api.example.test', status: 404 }))
      .toBe('https://api.example.test answered HTTP 404 to the connect code. '
        + 'Check the line is the one from the Connect your own agent page, copy it again, and paste it whole.');
    expect(connectCodeRefusalLine('used', { name: 'ada', runName: 'ada@two' })).toContain('run: commonly agent run ada@two.');
    for (const refusal of ['invalid', 'unknown', 'used', 'revoked', 'rate_limited', 'unreachable', 'no_fetch']) {
      expect(connectCodeRefusalLine(refusal, { name: 'ada', instanceUrl: 'x' })).not.toMatch(/\n/);
    }
  });
});
