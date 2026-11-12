/**
 * seatbelt.claude-header-channel.smoke.test.mjs
 *
 * F461 under real sandbox-exec. A public Claude seat's headersHelper runs
 * inside the seat's Seatbelt profile and asks the adapter for the token over a
 * Unix socket in the spawn's MCP folder, sending the turn's key from a file
 * beside it. Checked here:
 * - the seat's own jail reads the key and gets the token;
 * - opening the socket as a file (what a Read tool does) gets nothing;
 * - another seat's jail, whose profile admits only its own MCP folder, can
 *   still CONNECT to this socket (a seat's network is open; measured in the
 *   review), but cannot read the key, and a connect without it gets nothing.
 *   That last part is why the key exists.
 */

import { spawn } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join } from 'path';

import { startHeaderCredentialChannel } from '../src/lib/adapters/claude.js';
import { wrapArgvWithSeatbelt } from '../src/lib/sandbox/seatbelt.js';

const macTest = process.platform === 'darwin' ? test : test.skip;
const TOKEN = 'cm_agent_channel_probe';

describe('the header credential channel under Seatbelt', () => {
  let root;
  const seats = {};
  beforeAll(() => {
    if (process.platform !== 'darwin') return;
    root = mkdtempSync(join(homedir(), '.commonly-claude-header-channel-'));
    for (const name of ['a', 'b']) {
      const workspace = join(root, `workspace-${name}`);
      const state = join(root, `state-${name}`);
      mkdirSync(workspace);
      mkdirSync(state);
      // Where the adapter makes it: the system temp folder.
      seats[name] = { workspace, state, mcpDir: mkdtempSync(join(tmpdir(), `cc-hc-${name}-`)) };
    }
  });
  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    for (const seat of Object.values(seats)) rmSync(seat.mcpDir, { recursive: true, force: true });
  });

  // Async: the server answering the confined process lives in this process.
  const confined = (seat, code) => new Promise((resolve) => {
    const argv = wrapArgvWithSeatbelt([process.execPath, '-e', code], {
      workspacePath: seat.workspace,
      executablePath: process.execPath,
      statePath: seat.state,
      mcpConfigDir: seat.mcpDir,
      allowClaudeRuntimeAccess: true,
    });
    const child = spawn(argv[0], argv.slice(1), { cwd: seat.workspace });
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
    child.on('close', () => { clearTimeout(timer); resolve(out.trim()); });
  });
  const connect = (socketPath, keyExpr) => `
    let key = '';
    try { key = ${keyExpr}; } catch (e) { console.log('KEY ' + e.code); }
    const s = require('net').createConnection({ path: ${JSON.stringify(socketPath)} }, () => s.write(key + '\\n'));
    let d = ''; s.on('data', (c) => { d += c; });
    s.on('close', () => console.log('GOT [' + d + ']'));
    s.on('error', (e) => console.log('ERR ' + e.code));
  `;

  macTest('the seat\'s own jail gets the token; a file open of the socket fails', async () => {
    const channel = await startHeaderCredentialChannel(seats.a.mcpDir, TOKEN);
    try {
      const keyRead = `require('fs').readFileSync(${JSON.stringify(channel.keyPath)}, 'utf8').trim()`;
      expect(await confined(seats.a, connect(channel.path, keyRead))).toBe(`GOT [${TOKEN}]`);
      const viaFile = await confined(seats.a, `
        try { require('fs').readFileSync(${JSON.stringify(channel.path)}); console.log('READ'); }
        catch (e) { console.log('FAILED ' + e.code); }
      `);
      expect(viaFile).toMatch(/^FAILED /);
    } finally {
      await channel.close();
    }
  });

  macTest('another seat\'s jail that learns the path cannot read the key, and gets nothing without it', async () => {
    const channel = await startHeaderCredentialChannel(seats.a.mcpDir, TOKEN);
    try {
      const keyRead = `require('fs').readFileSync(${JSON.stringify(channel.keyPath)}, 'utf8').trim()`;
      expect(await confined(seats.b, connect(channel.path, keyRead))).toBe('KEY EPERM\nGOT []');
    } finally {
      await channel.close();
    }
  });
});
