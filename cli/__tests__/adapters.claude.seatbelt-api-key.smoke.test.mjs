/**
 * A Seatbelt-confined Claude seat with ANTHROPIC_API_KEY, under the real macOS
 * kernel (F151).
 *
 * The real adapter, the real provider proxy and the real sandbox-exec run; only
 * claude and the provider are stand-ins. The stand-in claude, launched through
 * the adapter's own Seatbelt profile, reports what reached it (is the host key
 * anywhere in its environment, argv or HOME?) and sends one Messages request
 * to the ANTHROPIC_BASE_URL it was given, with the key it was given. The
 * stand-in provider accepts only the host's real key, so a reply proves the
 * request went through the host-side proxy, which swapped the per-turn token
 * for the key. No keychain is read.
 */
import { createServer } from 'http';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import claude from '../src/lib/adapters/claude.js';
import { detectSeatbelt } from '../src/lib/sandbox/seatbelt.js';

const realSeatbeltTest = process.platform === 'darwin' ? test : test.skip;
const HOST_KEY = 'sk-ant-host-only-f151-smoke';

const filesUnder = async (dir) => {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await filesUnder(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
};

realSeatbeltTest('a key seat reaches the model through the loopback proxy, holding only its token', async () => {
  expect(detectSeatbelt().available).toBe(true);
  const root = await realpath(await mkdtemp(join(homedir(), '.claude-f151-seatbelt-smoke-')));
  const bin = join(root, 'bin');
  const workspace = join(root, 'workspace');
  const state = join(root, 'state');
  const seen = [];
  const provider = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      seen.push({ path: req.url, key: req.headers['x-api-key'], body });
      if (req.headers['x-api-key'] !== HOST_KEY) {
        res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"bad key"}');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ content: [{ type: 'text', text: 'PROVIDER_REPLY' }] }));
    });
  });
  await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
  const upstream = `http://127.0.0.1:${provider.address().port}`;
  try {
    await Promise.all([mkdir(bin), mkdir(workspace), mkdir(state)]);
    // A file beside the seat's folders: proves the stand-in ran confined.
    await writeFile(join(root, 'outside.txt'), 'operator-only', { mode: 0o600 });
    await writeFile(join(bin, 'claude'), [
      `#!${process.execPath}`,
      'const fs = require("fs");',
      `const key = ${JSON.stringify(HOST_KEY)};`,
      'const inEnv = JSON.stringify(process.env).includes(key);',
      'const inArgv = process.argv.join(" ").includes(key);',
      `let outside; try { fs.readFileSync(${JSON.stringify(join(root, 'outside.txt'))}); outside = "READ"; } catch (e) { outside = e.code; }`,
      '(async () => {',
      '  let reply;',
      '  try {',
      '    const res = await fetch(new URL("v1/messages", process.env.ANTHROPIC_BASE_URL.replace(/\\/?$/, "/")), {',
      '      method: "POST",',
      '      headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },',
      '      body: JSON.stringify({ model: "m", max_tokens: 8, messages: [{ role: "user", content: "hi" }] }),',
      '    });',
      '    reply = `${res.status}:${(await res.json()).content?.[0]?.text}`;',
      '  } catch (e) { reply = `FETCH_FAILED:${e.cause?.code || e.message}`; }',
      '  const report = { inEnv, inArgv, outside, reply, baseURL: process.env.ANTHROPIC_BASE_URL, home: process.env.HOME };',
      '  process.stdout.write(JSON.stringify({ type: "system", subtype: "init", mcp_servers: [] }) + "\\n");',
      '  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: JSON.stringify(report) }) + "\\n");',
      '})();',
      '',
    ].join('\n'), { mode: 0o755 });

    const res = await claude.spawn('hi', {
      agentName: 'f151-smoke',
      sessionId: null,
      cwd: workspace,
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        ANTHROPIC_API_KEY: HOST_KEY,
        ANTHROPIC_BASE_URL: upstream,
      },
      environment: { model: 'test-model', sandbox: { mode: 'workspace', trust: 'public' } },
      _publicClaudeState: state,
      timeoutMs: 30_000,
    });

    const report = JSON.parse(res.text);
    expect(report.outside).toBe('EPERM');
    expect(report.reply).toBe('200:PROVIDER_REPLY');
    expect(report.baseURL).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/?$/);
    expect(report.baseURL).not.toBe(upstream);
    expect(report.inEnv).toBe(false);
    expect(report.inArgv).toBe(false);
    expect(report.home).toBe(state);
    // The provider saw the real key, injected by the host-side proxy.
    expect(seen).toHaveLength(1);
    expect(seen[0].key).toBe(HOST_KEY);
    // Nothing the jail could read holds the key.
    for (const file of await filesUnder(state)) {
      expect(await readFile(file, 'utf8')).not.toContain(HOST_KEY);
    }
    // The per-turn proxy is gone once the turn ends.
    const after = await fetch(new URL('v1/messages', report.baseURL.replace(/\/?$/, '/')), { method: 'POST' })
      .then(() => 'OPEN', (e) => e.cause?.code || 'CLOSED');
    expect(after).toBe('ECONNREFUSED');
  } finally {
    await new Promise((resolve) => provider.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
