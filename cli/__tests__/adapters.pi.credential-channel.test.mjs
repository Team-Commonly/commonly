/**
 * The runtime token's channel (TASK-078): the pi path hands the credential to
 * the MCP child on an inherited fd instead of in its environment.
 *
 * Sam's ruling on the posture card (70188/70199, 2026-09-19) was "take the token
 * out of the environment (inherited pipe)" — the pattern TASK-070 already uses
 * for the server list. What makes that a real removal rather than a move is
 * measured here against a REAL child that reads its own fd 3 and its own
 * environment: an argument passed to an injected fake is not proof that a
 * process could not read the secret.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  connectStdioMcp, describeMcpCommand, splitCredential,
} from '../src/lib/adapters/pi-mcp-client.mjs';

const TOKEN = 'cm_agent_secret_value';

const waitForFile = async (path, ms = 5000) => {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      if (Date.now() > deadline) throw new Error(`probe file never appeared: ${path}`);
      await new Promise((r) => { setTimeout(r, 25); });
    }
  }
};

/**
 * Spawn a real child through the real client and have it report what it can
 * see: the pointer variable, the environment token if any, and its own fd 3.
 * It writes to a file because `connectStdioMcp` owns the child's stdout, and it
 * then idles so the client keeps a live child to close.
 */
const runChildProbe = async ({ declaredEnv, extraArg, ambientToken }) => {
  const dir = mkdtempSync(join(tmpdir(), 'kai-cred-'));
  const out = join(dir, 'seen.json');
  const server = `
    import { readFileSync, writeFileSync } from 'node:fs';
    let piped = null;
    try { piped = readFileSync(3, 'utf8'); } catch (e) { piped = 'ERR:' + e.code; }
    writeFileSync(${JSON.stringify(out)}, JSON.stringify({
      fdVar: process.env.COMMONLY_TOKEN_FD ?? null,
      envToken: process.env.COMMONLY_AGENT_TOKEN ?? null,
      piped,
    }));
    process.stdin.resume();
  `;
  const command = [process.execPath, '--input-type=module', '-e', server];
  if (extraArg) command.push(extraArg);
  const previous = process.env.COMMONLY_AGENT_TOKEN;
  if (ambientToken) process.env.COMMONLY_AGENT_TOKEN = ambientToken;
  else delete process.env.COMMONLY_AGENT_TOKEN;
  try {
    const client = connectStdioMcp(
      { name: 'probe', command, env: declaredEnv },
      { spawnImpl: spawn, timeoutMs: 5000 },
    );
    const seen = JSON.parse(await waitForFile(out));
    client.close();
    return seen;
  } finally {
    if (previous === undefined) delete process.env.COMMONLY_AGENT_TOKEN;
    else process.env.COMMONLY_AGENT_TOKEN = previous;
  }
};

describe('splitCredential: which channel the token takes', () => {
  const warned = () => {
    const lines = [];
    return { lines, onWarn: (m) => lines.push(m) };
  };

  test('a declaration that supplies the token has it moved to the pipe', () => {
    const w = warned();
    const { env, credential, keepInEnv } = splitCredential(
      { COMMONLY_AGENT_TOKEN: TOKEN, COMMONLY_API_URL: 'https://api.commonly.me' },
      ['npx', '-y', '@commonlyai/mcp@latest'],
      { onWarn: w.onWarn },
    );
    expect(credential).toBe(TOKEN);
    expect(keepInEnv).toBe(false);
    expect(env.COMMONLY_AGENT_TOKEN).toBeUndefined();
    expect(env.COMMONLY_TOKEN_FD).toBe('3');
    expect(env.COMMONLY_API_URL).toBe('https://api.commonly.me');
    expect(w.lines).toEqual([]);
  });

  test('a declaration pinning a pre-pipe server keeps the token in env, and says why', () => {
    // The sprint seats run a staging checkout at 0.3.4; handing that server a
    // pipe it cannot read would take its tools away rather than its secret.
    const w = warned();
    const { env, credential, keepInEnv } = splitCredential(
      { COMMONLY_AGENT_TOKEN: TOKEN },
      ['npx', '-y', '@commonlyai/mcp@0.3.4'],
      { onWarn: w.onWarn },
    );
    expect(keepInEnv).toBe(true);
    expect(credential).toBeNull();
    expect(env.COMMONLY_AGENT_TOKEN).toBe(TOKEN);
    expect(env.COMMONLY_TOKEN_FD).toBeUndefined();
    expect(w.lines.join('\n')).toMatch(/0\.3\.4/);
    expect(w.lines.join('\n')).toMatch(/COMMONLY_TOKEN_CHANNEL=env/);
  });

  test('a declaration pinning the pipe-reading release or newer is piped', () => {
    for (const spec of ['0.3.11', '0.3.12', '0.4.0', '1.0.0']) {
      const { credential, keepInEnv } = splitCredential(
        { COMMONLY_AGENT_TOKEN: TOKEN },
        ['npx', '-y', `@commonlyai/mcp@${spec}`],
        { onWarn: () => {} },
      );
      expect([spec, keepInEnv]).toEqual([spec, false]);
      expect(credential).toBe(TOKEN);
    }
  });

  test('an explicit opt-out wins over everything: COMMONLY_TOKEN_CHANNEL=env', () => {
    const { env, keepInEnv, credential } = splitCredential(
      { COMMONLY_AGENT_TOKEN: TOKEN, COMMONLY_TOKEN_CHANNEL: 'env' },
      ['npx', '-y', '@commonlyai/mcp@latest'],
      { onWarn: () => {} },
    );
    expect(keepInEnv).toBe(true);
    expect(credential).toBeNull();
    expect(env.COMMONLY_AGENT_TOKEN).toBe(TOKEN);
    // The switch itself is not part of the child's contract.
    expect(env.COMMONLY_TOKEN_CHANNEL).toBeUndefined();
  });

  test('a declaration with no token is left alone', () => {
    const { env, credential, keepInEnv } = splitCredential(
      { SEAT_ENV: 'kai' },
      ['node', 'other-server.js'],
      { onWarn: () => {} },
    );
    expect(credential).toBeNull();
    expect(keepInEnv).toBe(false);
    expect(env).toEqual({ SEAT_ENV: 'kai' });
  });
});

describe('describeMcpCommand: is this our server, and which version', () => {
  const reader = (payload) => ({ readTextFile: () => payload });

  test('reads a pinned npx spec and treats an unversioned one as latest', () => {
    expect(describeMcpCommand(['npx', '-y', '@commonlyai/mcp@0.3.4']))
      .toEqual({ isCommonly: true, version: [0, 3, 4] });
    // Unpinned means "whatever is published", which is never treated as old.
    expect(describeMcpCommand(['npx', '-y', '@commonlyai/mcp@latest']))
      .toEqual({ isCommonly: true, version: null });
    expect(describeMcpCommand(['npx', '-y', '@commonlyai/mcp']))
      .toEqual({ isCommonly: true, version: null });
  });

  test('reads a local checkout from the package.json beside its entry script', () => {
    const pkg = JSON.stringify({ name: '@commonlyai/mcp', version: '0.3.4' });
    expect(describeMcpCommand(
      ['node', '/home/me/.commonly/mcp-staging/commonly-mcp/src/index.js'],
      reader(pkg),
    )).toEqual({ isCommonly: true, version: [0, 3, 4] });
  });

  test('a package.json naming another package, or a malformed one, is not our server', () => {
    expect(describeMcpCommand(['node', '/tmp/other/src/index.js'], reader('{"name":"other","version":"1.0.0"}'))).toBeNull();
    expect(describeMcpCommand(['node', '/tmp/broken/src/index.js'], reader('{not json'))).toBeNull();
    expect(describeMcpCommand(['node', '/tmp/absent/src/index.js'], reader(null))).toBeNull();
    expect(describeMcpCommand(['node', 'plain-server.js'], reader(null))).toBeNull();
    expect(describeMcpCommand([])).toBeNull();
  });

  test('a stranger server keeps the token in its environment', () => {
    // Its declaration asked for the key; it has no reason to know about a pipe,
    // so the channel is left exactly as declared.
    const { env, credential, keepInEnv } = splitCredential(
      { COMMONLY_AGENT_TOKEN: TOKEN, ITS_OWN_FLAG: '1' },
      ['node', 'someone-elses-server.js'],
      { onWarn: () => {} },
    );
    expect(keepInEnv).toBe(true);
    expect(credential).toBeNull();
    expect(env.COMMONLY_AGENT_TOKEN).toBe(TOKEN);
  });
});

describe('connectStdioMcp: what the child can actually see', () => {
  test('a real child reads its credential from fd 3 and finds none in its environment', async () => {
    // The command is identified as our server at or above the pipe-reading
    // release, which is what decides the channel; a stranger's server keeps the
    // environment (see the next describe).
    const seen = await runChildProbe({
      declaredEnv: { COMMONLY_AGENT_TOKEN: TOKEN },
      extraArg: '@commonlyai/mcp@0.3.11',
    });
    expect(seen.fdVar).toBe('3');
    expect(seen.piped).toBe(TOKEN);
    // The whole point: `ps eww <pid>` and /proc/<pid>/environ have nothing.
    expect(seen.envToken).toBeNull();
  });

  test('the ambient environment is not a channel either', async () => {
    // The declaration asks for nothing; the parent happens to carry a token.
    // `{...process.env, ...env}` used to hand it over anyway.
    const seen = await runChildProbe({
      declaredEnv: { SEAT_ENV: 'kai' },
      ambientToken: TOKEN,
    });
    expect(seen.envToken).toBeNull();
    expect(seen.fdVar).toBeNull();
  });

  test('an old pinned server really does still receive it in the environment', async () => {
    // The same real child, with a command line that names a pre-pipe server, so
    // the fallback is measured end-to-end rather than only unit-asserted.
    const seen = await runChildProbe({
      declaredEnv: { COMMONLY_AGENT_TOKEN: TOKEN },
      extraArg: '/tmp/staging/@commonlyai/mcp@0.3.4',
    });
    expect(seen.envToken).toBe(TOKEN);
    expect(seen.fdVar).toBeNull();
  });
});
