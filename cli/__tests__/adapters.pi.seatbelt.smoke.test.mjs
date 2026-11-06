/**
 * A public pi turn under the real macOS kernel (F113b).
 *
 * A stand-in pi package does what the real pi does with the parts that matter
 * here: it is launched through an npm-style symlink, reads the server list on
 * fd 3 and starts the declared stdio MCP server as its own child (the bridge's
 * job, in-process in the real pi), and runs a shell. Every one of those
 * processes tries to read a file outside the jail's grants; each must be
 * denied by the profile it inherited from the one sandbox-exec spawn, and the
 * MCP server must not be able to inspect the pi process that started it.
 */
import {
  chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile,
} from 'fs/promises';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import pi from '../src/lib/adapters/pi.js';
import { detectSeatbelt } from '../src/lib/sandbox/seatbelt.js';
import { PUBLIC_SEAT_WITHHELD_TOOLS } from '../src/lib/public-withheld-tools.js';

const realSeatbeltTest = process.platform === 'darwin' ? test : test.skip;

realSeatbeltTest('the jailed pi, the MCP server it starts and its shell all stay inside Seatbelt', async () => {
  expect(detectSeatbelt().available).toBe(true);
  // HOME, not /tmp: /var and /private/var carry broad metadata grants, so a
  // secret there would not prove the boundary.
  const root = await realpath(await mkdtemp(join(homedir(), '.pi-seatbelt-smoke-')));
  const secret = join(root, 'operator-secret.txt');
  const packageRoot = join(root, 'npm', 'lib', 'node_modules', '@earendil-works', 'pi-coding-agent');
  const binDir = join(root, 'npm', 'bin');
  const workspace = join(root, 'workspace');
  const piHome = join(root, 'pi-home');
  try {
    await Promise.all([
      mkdir(join(packageRoot, 'dist'), { recursive: true }),
      mkdir(binDir, { recursive: true }),
      mkdir(workspace),
    ]);
    await writeFile(secret, 'operator-only', { mode: 0o600 });
    await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent' }));
    // The declared MCP server: reports whether it can read the secret.
    const serverPath = join(workspace, 'fake-mcp.cjs');
    await writeFile(serverPath, [
      'const fs = require("fs");',
      `let r; try { fs.readFileSync(${JSON.stringify(secret)}); r = "READ"; } catch (e) { r = e.code; }`,
      // Process inspection of the jailed pi (its parent): lsof reads another
      // process's open files and cwd through process-info.
      'const l = require("child_process").spawnSync("/usr/sbin/lsof", ["-a", "-p", String(process.ppid), "-d", "cwd"], { encoding: "utf8" });',
      'process.stdout.write(r + (l.status === 0 && String(l.stdout).includes(String(process.ppid)) ? ":INSPECTED" : ":BLIND"));',
      '',
    ].join('\n'));
    const cli = join(packageRoot, 'dist', 'cli.js');
    await writeFile(cli, [
      `#!${process.execPath}`,
      'const fs = require("fs"); const cp = require("child_process");',
      'if (process.argv.includes("--version")) { process.stdout.write("0.84.1\\n"); process.exit(0); }',
      'const servers = JSON.parse(fs.readFileSync(3, "utf8"));',
      'const s = servers[0];',
      'const mcp = cp.spawnSync(s.command[0], s.command.slice(1), { encoding: "utf8", env: { PATH: process.env.PATH, ...s.env } });',
      `const shell = cp.spawnSync("/bin/sh", ["-c", "cat ${secret} >/dev/null 2>&1 && echo READ || echo DENIED"], { encoding: "utf8" });`,
      `let self; try { fs.readFileSync(${JSON.stringify(secret)}); self = "READ"; } catch (e) { self = e.code; }`,
      'const report = { self, mcp: mcp.stdout || String(mcp.error || mcp.stderr), shell: shell.stdout.trim(),',
      '  key: process.env.COMMONLY_LITELLM_KEY === "sk-real" ? "LEAKED" : "proxied",',
      '  withheld: s.withheldTools };',
      'process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant",',
      '  content: [{ type: "text", text: JSON.stringify(report) }] } }) + "\\n");',
      '',
    ].join('\n'));
    await chmod(cli, 0o755);
    await symlink(cli, join(binDir, 'pi'));

    const result = await pi.spawn('hello', {
      cwd: workspace,
      agentName: 'pi-seatbelt-smoke',
      runtimeToken: 'cm_agent_smoke',
      instanceUrl: 'https://api.example',
      env: { PATH: `${binDir}:${dirname(process.execPath)}:/usr/bin:/bin`, COMMONLY_LITELLM_KEY: 'sk-real' },
      environment: {
        model: 'smoke-model',
        sandbox: { trust: 'public' },
        mcp: [{ name: 'commonly', transport: 'stdio', command: ['node', serverPath] }],
      },
      _piHome: piHome,
      // No _version: the real probe asks the fake pi on PATH, which says 0.84.1.
      timeoutMs: 20_000,
    });
    const report = JSON.parse(result.text);
    expect(report).toEqual({
      self: 'EPERM',
      mcp: 'EPERM:BLIND',
      shell: 'DENIED',
      key: 'proxied',
      withheld: [...PUBLIC_SEAT_WITHHELD_TOOLS],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// F175c: the delete runs inside the jail, on the real kernel, through the real
// helper. The stand-in pi prints nothing until it has deleted, so the parent's
// first-line delete cannot be what removed the file.
realSeatbeltTest('the jailed pi can delete its own per-spawn credential directory', async () => {
  const root = await realpath(await mkdtemp(join(homedir(), '.pi-seatbelt-smoke-')));
  const packageRoot = join(root, 'npm', 'lib', 'node_modules', '@earendil-works', 'pi-coding-agent');
  const binDir = join(root, 'npm', 'bin');
  const workspace = join(root, 'workspace');
  const piHome = join(root, 'pi-home');
  const helper = fileURLToPath(new URL('../src/lib/adapters/pi-mcp-client.mjs', import.meta.url));
  try {
    await Promise.all([
      mkdir(join(packageRoot, 'dist'), { recursive: true }),
      mkdir(binDir, { recursive: true }),
      mkdir(workspace),
    ]);
    await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent' }));
    const cli = join(packageRoot, 'dist', 'cli.js');
    await writeFile(cli, [
      `#!${process.execPath}`,
      'const fs = require("fs");',
      'if (process.argv.includes("--version")) { process.stdout.write("0.84.1\\n"); process.exit(0); }',
      'const raw = fs.readFileSync(3, "utf8");',
      'const file = process.env.COMMONLY_TOKEN_FILE;',
      'const before = fs.readFileSync(file, "utf8");',
      `import(${JSON.stringify(helper)}).then(({ readServers, removeSpawnCredential }) => {`,
      '  const servers = readServers(raw);',
      '  const removed = removeSpawnCredential(servers);',
      '  const report = { before, removed, gone: !fs.existsSync(file), dirGone: !fs.existsSync(require("path").dirname(file)) };',
      '  process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant",',
      '    content: [{ type: "text", text: JSON.stringify(report) }] } }) + "\\n");',
      '}, (err) => { process.stderr.write(String(err)); process.exit(3); });',
      '',
    ].join('\n'));
    await chmod(cli, 0o755);
    await symlink(cli, join(binDir, 'pi'));

    const result = await pi.spawn('hello', {
      cwd: workspace,
      agentName: 'pi-seatbelt-delete',
      runtimeToken: 'cm_agent_smoke',
      instanceUrl: 'https://api.example',
      env: { PATH: `${binDir}:${dirname(process.execPath)}:/usr/bin:/bin`, COMMONLY_LITELLM_KEY: 'sk-real' },
      environment: {
        model: 'smoke-model',
        sandbox: { trust: 'public' },
        mcp: [{
          name: 'commonly-grant-broker',
          transport: 'http',
          url: '${COMMONLY_API_URL}/api/mcp/grants/g1',
          headers: { Authorization: 'Bearer ${COMMONLY_AGENT_TOKEN}' },
        }],
      },
      _piHome: piHome,
      timeoutMs: 20_000,
    });
    expect(JSON.parse(result.text)).toEqual({
      before: 'cm_agent_smoke', removed: true, gone: true, dirGone: true,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
