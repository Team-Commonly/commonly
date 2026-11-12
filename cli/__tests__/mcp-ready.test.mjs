/**
 * F460. Which MCP entries of a public seat name a ready file, so the spawn can
 * delete its credential once every reader has it: the shipped Commonly server
 * (when its warm build writes one) and the grant-broker bridge. A public seat
 * whose shipped server is a build from before ready files is refused: without
 * the file the credential would stay readable until the deadline on every turn.
 */
import { join } from 'path';
import {
  MCP_READY_FILE_ENV, bridgeReadyFile, commonlyMcpReadyFile,
} from '../src/lib/mcp-ready.js';
import { MCP_READY_FILE_ENV as OPENCODE_READY_FILE_ENV } from '../src/lib/adapters/opencode.js';

const SHIPPED = ['npx', '-y', '@commonlyai/mcp@latest'];
const WARM = ['/usr/bin/node', '/home/x/.commonly/mcp/1.2.3/node_modules/@commonlyai/mcp/src/index.js'];

const publicCtx = () => ({ readyFileDir: '/tmp/ready-dir', readyFiles: [] });

describe('commonlyMcpReadyFile', () => {
  test('names a fresh file in the ready folder for the shipped server, and records it', () => {
    const ctx = publicCtx();
    const path = commonlyMcpReadyFile({ name: 'commonly', command: SHIPPED }, WARM, ctx, { writesReadyFile: () => true });
    expect(path.startsWith(join('/tmp/ready-dir', ''))).toBe(true);
    expect(ctx.readyFiles).toEqual([{ name: 'commonly', path }]);
    const again = commonlyMcpReadyFile({ name: 'commonly', command: SHIPPED }, WARM, ctx, { writesReadyFile: () => true });
    expect(again).not.toBe(path);
  });

  test('a public seat on a warm build without ready files is refused, plainly', () => {
    expect(() => commonlyMcpReadyFile({ name: 'commonly', command: SHIPPED }, WARM, publicCtx(), { writesReadyFile: () => false }))
      .toThrow(/commonly.*update @commonlyai\/mcp/);
  });

  // Our package run by path (a checkout) gets the credential file but names
  // no ready file, so it would lose the credential before reading it.
  test('our package declared by a path outside the MCP home is refused on a public seat too', () => {
    const CHECKOUT = ['node', '/srv/commonly-mcp/src/index.js'];
    const describe = () => ({ isCommonly: true, version: [0, 3, 50] });
    expect(() => commonlyMcpReadyFile({ name: 'commonly', command: CHECKOUT }, CHECKOUT, publicCtx(), {
      describe, writesReadyFile: () => false,
    })).toThrow(/outside the host-prepared MCP home.*update @commonlyai\/mcp/);
    // Reverse: on a private seat it is not asked.
    expect(commonlyMcpReadyFile({ name: 'commonly', command: CHECKOUT }, CHECKOUT, { readyFiles: [] }, {
      describe, writesReadyFile: () => false,
    })).toBeNull();
  });

  test('no ready folder (a private seat), or a server that is not ours: nothing asked, nothing refused', () => {
    const priv = { readyFiles: [] };
    expect(commonlyMcpReadyFile({ name: 'commonly', command: SHIPPED }, WARM, priv, { writesReadyFile: () => false })).toBeNull();
    const ctx = publicCtx();
    expect(commonlyMcpReadyFile({ name: 'other', command: ['node', '/opt/other.js'] }, ['node', '/opt/other.js'], ctx, { writesReadyFile: () => false })).toBeNull();
    expect(ctx.readyFiles).toEqual([]);
  });
});

// Opus review HOLD 2: another server handed the credential path names no ready
// file, so the release would not wait for it and it would lose the file.
describe('a server that is not ours but would receive the credential', () => {
  const OTHER = ['node', '/opt/other.js'];
  const notOurs = { describe: () => null, writesReadyFile: () => false };

  test('is refused on a public seat', () => {
    expect(() => commonlyMcpReadyFile({ name: 'side', command: OTHER }, OTHER, publicCtx(), {
      ...notOurs, env: { COMMONLY_TOKEN_FILE: '/tmp/x/token' },
    })).toThrow(/side is another server declaring COMMONLY_TOKEN_FILE.*private seat/);
  });

  test('reverse: without the credential, or on a private seat, it is left alone', () => {
    const ctx = publicCtx();
    expect(commonlyMcpReadyFile({ name: 'side', command: OTHER }, OTHER, ctx, {
      ...notOurs, env: { OTHER_VAR: 'x', COMMONLY_TOKEN_FILE: '' },
    })).toBeNull();
    expect(ctx.readyFiles).toEqual([]);
    expect(commonlyMcpReadyFile({ name: 'side', command: OTHER }, OTHER, { readyFiles: [] }, {
      ...notOurs, env: { COMMONLY_TOKEN_FILE: '/tmp/x/token' },
    })).toBeNull();
  });
});

describe('bridgeReadyFile', () => {
  test('the broker bridge always gets one on a public seat; none without a ready folder', () => {
    const ctx = publicCtx();
    const path = bridgeReadyFile({ name: 'grants' }, ctx);
    expect(ctx.readyFiles).toEqual([{ name: 'grants', path }]);
    expect(bridgeReadyFile({ name: 'grants' }, { readyFiles: [] })).toBeNull();
  });
});

test('one variable name, wherever it is imported from', () => {
  expect(MCP_READY_FILE_ENV).toBe('COMMONLY_MCP_READY_FILE');
  expect(OPENCODE_READY_FILE_ENV).toBe(MCP_READY_FILE_ENV);
});
