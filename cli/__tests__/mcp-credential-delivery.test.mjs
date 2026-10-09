/**
 * Which channel a declared MCP server gets the seat credential on, for the two
 * adapters that cannot pipe it (TASK-083).
 *
 * The rewrite is of the DECLARATION: an entry that named the token variable
 * names the file variable instead, so the value never exists in the runtime's
 * environment for its whole process subtree to inherit.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CREDENTIAL_FILE_PLACEHOLDER, CREDENTIAL_PLACEHOLDER, deliverSeatCredential,
} from '../src/lib/mcp-credential-delivery.js';
import { FILE_READER_VERSION } from '../src/lib/mcp-server-version.js';

const OURS = ['npx', '-y', '@commonlyai/mcp@latest'];
const warned = () => {
  const lines = [];
  return { lines, onWarn: (m) => lines.push(m) };
};

describe('deliverSeatCredential: the declaration is rewritten, not the value', () => {
  test('our server at an unpinned spec is moved onto the launcher channel', () => {
    const w = warned();
    const { env, delivered } = deliverSeatCredential(
      { name: 'commonly', command: OURS, env: { COMMONLY_API_URL: '${COMMONLY_API_URL}', COMMONLY_AGENT_TOKEN: CREDENTIAL_PLACEHOLDER } },
      { credentialFile: '/run/seat/token', onWarn: w.onWarn },
    );
    expect(delivered).toBe('path');
    expect(env.COMMONLY_AGENT_TOKEN).toBeUndefined();
    expect(env.COMMONLY_TOKEN_FILE).toBe(CREDENTIAL_FILE_PLACEHOLDER);
    expect(env.COMMONLY_API_URL).toBe('${COMMONLY_API_URL}');
    expect(w.lines).toEqual([]);
  });

  test('the caller declaration is not mutated', () => {
    const declared = { COMMONLY_AGENT_TOKEN: CREDENTIAL_PLACEHOLDER };
    const server = { name: 'commonly', command: OURS, env: declared };
    deliverSeatCredential(server, { credentialFile: '/run/seat/token', onWarn: () => {} });
    expect(declared).toEqual({ COMMONLY_AGENT_TOKEN: CREDENTIAL_PLACEHOLDER });
    expect(server.env).toBe(declared);
  });

  test('a server that is not ours keeps its declaration, and the warning says so', () => {
    const w = warned();
    const { env, delivered } = deliverSeatCredential(
      { name: 'playwright', command: ['npx', '-y', '@playwright/mcp@latest'], env: { COMMONLY_AGENT_TOKEN: 'their-own' } },
      { credentialFile: '/run/seat/token', onWarn: w.onWarn },
    );
    expect(delivered).toBe('env');
    expect(env.COMMONLY_AGENT_TOKEN).toBe('their-own');
    expect(w.lines.join('\n')).toMatch(/not @commonlyai\/mcp/);
  });

  test('with no launcher file nothing is rewritten: no path to nowhere', () => {
    const { env, delivered } = deliverSeatCredential(
      { name: 'commonly', command: OURS, env: { COMMONLY_AGENT_TOKEN: CREDENTIAL_PLACEHOLDER } },
      { credentialFile: null, onWarn: () => {} },
    );
    expect(delivered).toBe('unavailable');
    expect(env.COMMONLY_AGENT_TOKEN).toBe(CREDENTIAL_PLACEHOLDER);
    expect(env.COMMONLY_TOKEN_FILE).toBeUndefined();
  });

  test('an entry that declares no credential is left entirely alone', () => {
    const { env, delivered } = deliverSeatCredential(
      { name: 'x', command: OURS, env: { A: 'b' } },
      { credentialFile: '/run/seat/token', onWarn: () => {} },
    );
    expect(delivered).toBe('none');
    expect(env).toEqual({ A: 'b' });
  });

  test('an entry already on the launcher channel is passed through untouched', () => {
    const { env, delivered } = deliverSeatCredential(
      { name: 'commonly', command: OURS, env: { COMMONLY_TOKEN_FILE: CREDENTIAL_FILE_PLACEHOLDER } },
      { credentialFile: '/run/seat/token', onWarn: () => {} },
    );
    expect(delivered).toBe('path');
    expect(env.COMMONLY_TOKEN_FILE).toBe(CREDENTIAL_FILE_PLACEHOLDER);
  });

  test('a literal token is superseded, and that is said out loud', () => {
    const w = warned();
    const { env, delivered } = deliverSeatCredential(
      { name: 'commonly', command: OURS, env: { COMMONLY_AGENT_TOKEN: 'cm_agent_stale_literal' } },
      { credentialFile: '/run/seat/token', onWarn: w.onWarn },
    );
    expect(delivered).toBe('path');
    expect(env.COMMONLY_AGENT_TOKEN).toBeUndefined();
    expect(w.lines.join('\n')).toMatch(/superseding it with this spawn's credential file/);
  });

  test('the version threshold is the file reader, not the pipe reader', () => {
    // 0.3.11 reads a pipe but not a path: the two channels shipped in different
    // releases, so one threshold for both would hand a path to a reader that
    // cannot open it.
    expect(FILE_READER_VERSION[0]).toBe(0);
    expect(FILE_READER_VERSION[1]).toBe(3);
    expect(FILE_READER_VERSION[2]).toBeGreaterThan(11);
  });
});

describe('deliverSeatCredential: the pin threshold, measured against a real checkout', () => {
  /** A checkout directory shaped like the staging seats', with a real package.json. */
  const checkout = (version) => {
    const dir = mkdtempSync(join(tmpdir(), 'kai-legacy-mcp-'));
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'index.js'), '');
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@commonlyai/mcp', version }));
    return ['node', join(dir, 'src', 'index.js')];
  };

  test('a checkout below the file release keeps the value in the environment', () => {
    // Measured on this box: five seats run a hand-patched staging checkout at
    // 0.3.7. Handing that reader a path it cannot open would take away the
    // seat's tools, which is a worse failure than the one being fixed.
    const w = warned();
    const { env, delivered } = deliverSeatCredential(
      { name: 'commonly', command: checkout('0.3.7'), env: { COMMONLY_AGENT_TOKEN: CREDENTIAL_PLACEHOLDER } },
      { credentialFile: '/run/seat/token', onWarn: w.onWarn },
    );
    expect(delivered).toBe('env');
    expect(env.COMMONLY_AGENT_TOKEN).toBe(CREDENTIAL_PLACEHOLDER);
    expect(env.COMMONLY_TOKEN_FILE).toBeUndefined();
    expect(w.lines.join('\n')).toMatch(/predates the credential file \(0\.3\.12\)/);
  });

  test('the same checkout at or above the file release is moved onto the path', () => {
    for (const version of ['0.3.12', '0.4.0', '1.0.0']) {
      const { env, delivered } = deliverSeatCredential(
        { name: 'commonly', command: checkout(version), env: { COMMONLY_AGENT_TOKEN: CREDENTIAL_PLACEHOLDER } },
        { credentialFile: '/run/seat/token', onWarn: () => {} },
      );
      expect([version, delivered, env.COMMONLY_TOKEN_FILE])
        .toEqual([version, 'path', CREDENTIAL_FILE_PLACEHOLDER]);
    }
  });
});
