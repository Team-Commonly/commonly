/**
 * mcp-first-run.test.mjs
 *
 * A public seat's first spawn on a fresh machine found no host-prepared MCP
 * build, started one, and refused the turn; the person's first @mention then
 * waited out the kernel's requeue. `agent run` now prepares the build before
 * its first poll, and only when the seat would otherwise hit that refusal.
 */

import { jest } from '@jest/globals';
import { prepareMcpBeforeFirstPoll } from '../src/lib/mcp-first-run.js';
import { commonlyMcpServer, defaultSeatSandbox } from '../src/lib/default-environment.js';
import { WARM_RESULTS } from '../src/lib/mcp-home.js';

const connectPage = { mcp: [commonlyMcpServer()], sandbox: defaultSeatSandbox() };
const emptyHome = () => ({ source: 'declared', reason: 'home-empty' });
const preparedHome = () => ({ source: 'home', reason: 'pointer', version: '0.3.13' });

describe('prepareMcpBeforeFirstPoll', () => {
  test('a public seat on a machine with no prepared build warms it once, before polling, and says so', async () => {
    const warm = jest.fn().mockResolvedValue(WARM_RESULTS.ADVANCED);
    const lines = [];
    const result = await prepareMcpBeforeFirstPoll({
      environment: connectPage, home: '/tmp/home/.commonly/mcp', plan: emptyHome, warm, log: (line) => lines.push(line),
    });
    expect(result).toBe(WARM_RESULTS.ADVANCED);
    expect(warm).toHaveBeenCalledTimes(1);
    expect(warm.mock.calls[0][0]).toBe('/tmp/home/.commonly/mcp');
    expect(lines).toEqual([
      "preparing Commonly's tools on this machine (first run only)...",
      "Commonly's tools are ready",
    ]);
  });

  test('a failed warm is reported and the run goes on; the first turn retries it', async () => {
    const lines = [];
    const result = await prepareMcpBeforeFirstPoll({
      environment: connectPage,
      plan: emptyHome,
      warm: jest.fn().mockResolvedValue(WARM_RESULTS.REGISTRY_UNAVAILABLE),
      log: (line) => lines.push(line),
    });
    expect(result).toBe(WARM_RESULTS.REGISTRY_UNAVAILABLE);
    expect(lines[1]).toBe("could not prepare Commonly's tools yet (registry-unavailable); the first turn will try again");
  });

  test('nothing runs when the build is already prepared, the seat is not public, or it declares no commonly server', async () => {
    const warm = jest.fn();
    expect(await prepareMcpBeforeFirstPoll({ environment: connectPage, plan: preparedHome, warm })).toBeNull();
    expect(await prepareMcpBeforeFirstPoll({ environment: { mcp: [commonlyMcpServer()] }, plan: emptyHome, warm })).toBeNull();
    expect(await prepareMcpBeforeFirstPoll({ environment: { sandbox: defaultSeatSandbox() }, plan: emptyHome, warm })).toBeNull();
    expect(await prepareMcpBeforeFirstPoll({ environment: null, plan: emptyHome, warm })).toBeNull();
    expect(warm).not.toHaveBeenCalled();
  });

  test('a legacy internal trust reads as public', async () => {
    const warm = jest.fn().mockResolvedValue(WARM_RESULTS.CURRENT);
    await prepareMcpBeforeFirstPoll({
      environment: { mcp: [commonlyMcpServer()], sandbox: { trust: 'internal' } }, plan: emptyHome, warm,
    });
    expect(warm).toHaveBeenCalledTimes(1);
  });
});
