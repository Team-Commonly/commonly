/**
 * seatbelt.claude-header-channel.smoke.test.mjs
 *
 * F461 under real sandbox-exec. A public Claude seat's headersHelper runs
 * inside the seat's Seatbelt profile and asks the adapter for the token over a
 * Unix socket in the spawn's MCP folder. This checks the profile lets a
 * confined process connect to that socket and read what the host process
 * sends, and that opening the socket as a file (what a Read tool does) gets
 * nothing. Who else may connect is bounded by the 0700 folder and the 0600
 * socket, which the adapter tests check; a seat's network is open by design.
 */

import { spawn } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'fs';
import { createServer } from 'net';
import { homedir, tmpdir } from 'os';
import { join } from 'path';

import { wrapArgvWithSeatbelt } from '../src/lib/sandbox/seatbelt.js';

const macTest = process.platform === 'darwin' ? test : test.skip;

describe('the header credential channel under Seatbelt', () => {
  let root;
  let workspace;
  let state;
  let mcpDir;
  beforeAll(() => {
    if (process.platform !== 'darwin') return;
    root = mkdtempSync(join(homedir(), '.commonly-claude-header-channel-'));
    workspace = join(root, 'workspace');
    state = join(root, 'state');
    // Where the adapter makes it: the system temp folder.
    mcpDir = mkdtempSync(join(tmpdir(), 'cc-hc-'));
    mkdirSync(workspace);
    mkdirSync(state);
  });
  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    if (mcpDir) rmSync(mcpDir, { recursive: true, force: true });
  });

  // Async: the server answering the confined process lives in this process.
  const confined = (code) => new Promise((resolve) => {
    const argv = wrapArgvWithSeatbelt([process.execPath, '-e', code], {
      workspacePath: workspace,
      executablePath: process.execPath,
      statePath: state,
      mcpConfigDir: mcpDir,
      allowClaudeRuntimeAccess: true,
    });
    const child = spawn(argv[0], argv.slice(1), { cwd: workspace });
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
    child.on('close', () => { clearTimeout(timer); resolve(out.trim()); });
  });

  macTest('a confined process reads the token from the socket, and a file open of it fails', async () => {
    const socketPath = join(mcpDir, 'headers.sock');
    const server = createServer((socket) => { socket.on('error', () => {}); socket.end('cm_agent_channel_probe'); });
    await new Promise((resolve) => { server.listen(socketPath, resolve); });
    try {
      const viaSocket = await confined(`
        const s = require('net').createConnection({ path: ${JSON.stringify(socketPath)} });
        let d = ''; s.on('data', (c) => { d += c; });
        s.on('end', () => console.log('GOT ' + d));
        s.on('error', (e) => console.log('DENIED ' + e.code));
      `);
      expect(viaSocket).toBe('GOT cm_agent_channel_probe');
      const viaFile = await confined(`
        try { require('fs').readFileSync(${JSON.stringify(socketPath)}); console.log('READ'); }
        catch (e) { console.log('FAILED ' + e.code); }
      `);
      expect(viaFile).toMatch(/^FAILED /);
    } finally {
      await new Promise((resolve) => { server.close(resolve); });
    }
  });
});
