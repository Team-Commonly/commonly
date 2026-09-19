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
import {
  mkdtempSync, readFileSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CHILD_ENV_ALLOWLIST, buildChildEnv, connectStdioMcp, describeMcpCommand, splitCredential,
} from '../src/lib/adapters/pi-mcp-client.mjs';
import {
  CREDENTIAL_FILE_VAR, removeCredentialFile, writeCredentialFile,
} from '../src/lib/credential-file.js';

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
const runChildProbe = async ({
  declaredEnv, extraArg, ambientToken, ambientExtra = {},
}) => {
  const dir = mkdtempSync(join(tmpdir(), 'kai-cred-'));
  const out = join(dir, 'seen.json');
  const server = `
    import { readFileSync, writeFileSync } from 'node:fs';
    let piped = null;
    try { piped = readFileSync(3, 'utf8'); } catch (e) { piped = 'ERR:' + e.code; }
    writeFileSync(${JSON.stringify(out)}, JSON.stringify({
      fdVar: process.env.COMMONLY_TOKEN_FD ?? null,
      envToken: process.env.COMMONLY_AGENT_TOKEN ?? null,
      tokenFile: process.env.COMMONLY_TOKEN_FILE ?? null,
      litellmKey: process.env.COMMONLY_LITELLM_KEY ?? null,
      marker: process.env.KAI_PROBE_MARKER ?? null,
      envKeys: Object.keys(process.env).sort(),
      path: process.env.PATH ?? null,
      home: process.env.HOME ?? null,
      piped,
    }));
    process.stdin.resume();
  `;
  const command = [process.execPath, '--input-type=module', '-e', server];
  if (extraArg) command.push(extraArg);
  const previous = process.env.COMMONLY_AGENT_TOKEN;
  const previousExtra = {};
  for (const [key, value] of Object.entries(ambientExtra)) {
    previousExtra[key] = process.env[key];
    process.env[key] = value;
  }
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
    for (const [key, value] of Object.entries(previousExtra)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

/** A real 0600 credential file, as the launcher writes it. */
const writeTokenFile = (token = TOKEN) => {
  const dir = mkdtempSync(join(tmpdir(), 'kai-cred-file-'));
  const path = join(dir, 'token');
  writeFileSync(path, token, { mode: 0o600 });
  return path;
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

describe('splitCredential: the launcher file channel (TASK-083)', () => {
  const readFrom = (contents) => ({ readCredentialFile: () => contents });
  const warned = () => {
    const lines = [];
    return { lines, onWarn: (m) => lines.push(m) };
  };

  test('a declaration that names a file is read here, piped, and leaves no path behind', () => {
    // The whole point of the launcher channel: the runtime is handed a PATH, and
    // the bridge turns it into a pipe, so the child ends up with neither.
    const { env, credential, keepInEnv } = splitCredential(
      { [CREDENTIAL_FILE_VAR]: '/run/seat/token', COMMONLY_API_URL: 'https://api.commonly.me' },
      ['npx', '-y', '@commonlyai/mcp@latest'],
      { onWarn: () => {}, ...readFrom(`${TOKEN}\n`) },
    );
    expect(credential).toBe(TOKEN);
    expect(keepInEnv).toBe(false);
    expect(env[CREDENTIAL_FILE_VAR]).toBeUndefined();
    expect(env.COMMONLY_AGENT_TOKEN).toBeUndefined();
    expect(env.COMMONLY_TOKEN_FD).toBe('3');
    expect(env.COMMONLY_API_URL).toBe('https://api.commonly.me');
  });

  test('the declared file is authoritative: a failed read throws, it does not fall through', () => {
    expect(() => splitCredential(
      { [CREDENTIAL_FILE_VAR]: '/run/seat/gone' },
      ['npx', '-y', '@commonlyai/mcp@latest'],
      { onWarn: () => {}, readCredentialFile: () => { throw new Error('ENOENT'); } },
    )).toThrow(/could not be read: \/run\/seat\/gone/);
  });

  test('a declared file wins over a literal token left in the same declaration', () => {
    // The literal is an older declaration's leftover; preferring it would keep
    // the secret in the environment the launcher channel exists to empty.
    const { env, credential, keepInEnv } = splitCredential(
      { [CREDENTIAL_FILE_VAR]: '/run/seat/token', COMMONLY_AGENT_TOKEN: 'cm_agent_stale_literal' },
      ['npx', '-y', '@commonlyai/mcp@latest'],
      { onWarn: () => {}, readCredentialFile: () => `${TOKEN}\n` },
    );
    expect(credential).toBe(TOKEN);
    expect(keepInEnv).toBe(false);
    expect(env.COMMONLY_AGENT_TOKEN).toBeUndefined();
  });

  test('a file that carried nothing is refused rather than treated as no credential', () => {
    expect(() => splitCredential(
      { [CREDENTIAL_FILE_VAR]: '/run/seat/empty' },
      ['npx', '-y', '@commonlyai/mcp@latest'],
      { onWarn: () => {}, ...readFrom('   \n') },
    )).toThrow(/carried nothing/);
  });

  test('an old pinned server gets the token value in its env — the measured degradation', () => {
    // A server that predates the pipe reader can only be told in its environment.
    // Serving it is a deliberate choice with a warning, not an accident.
    const w = warned();
    const { env, credential, keepInEnv } = splitCredential(
      { [CREDENTIAL_FILE_VAR]: '/run/seat/token' },
      ['npx', '-y', '@commonlyai/mcp@0.3.4'],
      { onWarn: w.onWarn, ...readFrom(TOKEN) },
    );
    expect(keepInEnv).toBe(true);
    expect(credential).toBeNull();
    expect(env.COMMONLY_AGENT_TOKEN).toBe(TOKEN);
    expect(env[CREDENTIAL_FILE_VAR]).toBeUndefined();
    expect(w.lines.join('\n')).toMatch(/predates the pipe channel/);
  });

  test('a readable file with no declaration at all is not consulted', () => {
    // Absent, blank and non-string declarations all mean "no file channel", and
    // none of them may reach the reader.
    for (const value of [undefined, '', '   ']) {
      const { credential, keepInEnv } = splitCredential(
        { [CREDENTIAL_FILE_VAR]: value },
        ['npx', '-y', '@commonlyai/mcp@latest'],
        { onWarn: () => {}, readCredentialFile: () => { throw new Error('must not be read'); } },
      );
      expect([value, credential, keepInEnv]).toEqual([value, null, false]);
    }
  });
});

describe('the child environment is an allowlist (TASK-083)', () => {
  test('buildChildEnv keeps the derived allowlist and the entry declaration, nothing else', () => {
    const parent = {
      PATH: '/usr/bin',
      HOME: '/home/seat',
      TMPDIR: '/var/folders/x',
      HTTPS_PROXY: 'http://proxy:8080',
      COMMONLY_AGENT_TOKEN: TOKEN,
      COMMONLY_LITELLM_KEY: 'sk-live',
      SEAT_PRIVATE_NOTE: 'do not ship',
    };
    const out = buildChildEnv(parent, { COMMONLY_API_URL: 'https://api.commonly.me' });
    expect(Object.keys(out).sort()).toEqual([
      'COMMONLY_API_URL', 'HOME', 'HTTPS_PROXY', 'PATH', 'TMPDIR',
    ]);
    expect(out.PATH).toBe('/usr/bin');
  });

  test('the entry declaration wins when it names a key the parent also has', () => {
    expect(buildChildEnv({ PATH: '/usr/bin' }, { PATH: '/seat/bin' }).PATH).toBe('/seat/bin');
  });

  test('the allowlist is a closed list, not a prefix rule', () => {
    // A `COMMONLY_*` variable is ours to hand over explicitly; a variable that
    // looks like a secret must not ride in because of its name.
    expect(CHILD_ENV_ALLOWLIST).not.toContain('COMMONLY_AGENT_TOKEN');
    expect(CHILD_ENV_ALLOWLIST).not.toContain('COMMONLY_LITELLM_KEY');
    expect(CHILD_ENV_ALLOWLIST.every((k) => k === k.toUpperCase())).toBe(true);
  });

  test('a real child inherits the allowlist, and no seat secret or marker', async () => {
    const seen = await runChildProbe({
      declaredEnv: { SEAT_ENV: 'kai' },
      ambientToken: TOKEN,
      ambientExtra: { COMMONLY_LITELLM_KEY: 'sk-live', KAI_PROBE_MARKER: 'present' },
    });
    expect(seen.envToken).toBeNull();
    expect(seen.litellmKey).toBeNull();
    expect(seen.marker).toBeNull();
    expect(seen.fdVar).toBeNull();
    // Not a vacuous pass: the allowlist is really passed through.
    expect(seen.path).toBeTruthy();
    expect(seen.home).toBeTruthy();
    expect(seen.envKeys).toContain('SEAT_ENV');
  });

  test('a real child reads the launcher file off fd 3 and never sees the path', async () => {
    const seen = await runChildProbe({
      declaredEnv: { [CREDENTIAL_FILE_VAR]: writeTokenFile() },
      extraArg: '@commonlyai/mcp@0.3.11',
    });
    expect(seen.piped).toBe(TOKEN);
    expect(seen.envToken).toBeNull();
    expect(seen.tokenFile).toBeNull();
  });
});

describe('writeCredentialFile: the launcher side (TASK-083)', () => {
  test('writes a 0600 file inside a 0700 directory and hands back the path', () => {
    const root = mkdtempSync(join(tmpdir(), 'kai-cred-root-'));
    const written = writeCredentialFile(TOKEN, { agentName: 'kai', root, now: () => 1, random: () => 'abcd' });
    expect(written.path).toBe(join(root, 'kai-1-abcd', 'token'));
    expect(readFileSync(written.path, 'utf8')).toBe(TOKEN);
    expect(statSync(written.path).mode & 0o777).toBe(0o600);
    expect(statSync(join(root, 'kai-1-abcd')).mode & 0o777).toBe(0o700);
    expect(removeCredentialFile(written)).toBe(true);
  });

  test('a missing token writes nothing and names nothing', () => {
    expect(writeCredentialFile('')).toBeNull();
    expect(writeCredentialFile(undefined)).toBeNull();
    expect(writeCredentialFile('   ')).toBeNull();
  });

  test('the file is written with the mode chmod sets, not the umask the process happens to have', () => {
    // writeFileSync's mode is filtered by umask, so the 0600 has to be asserted
    // after the write or a 0022 umask produces a 0644 credential.
    const calls = [];
    const fs = {
      mkdirSync: (...a) => calls.push(['mkdir', a]),
      writeFileSync: (...a) => calls.push(['write', a]),
      chmodSync: (...a) => calls.push(['chmod', a]),
      rmSync: () => {},
    };
    writeCredentialFile(TOKEN, { agentName: 'kai', root: '/r', fs, now: () => 1, random: () => 'x' });
    expect(calls.map((c) => c[0])).toEqual(['mkdir', 'write', 'chmod']);
    expect(calls[2][1]).toEqual(['/r/kai-1-x/token', 0o600]);
  });
});
