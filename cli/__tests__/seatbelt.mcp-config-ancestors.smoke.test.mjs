/**
 * seatbelt.mcp-config-ancestors.smoke.test.mjs
 *
 * F115 prod walk (11-12): a public dsh seat's guard plugin sits in the turn's
 * MCP config folder, under the temp folder, which resolves through /private.
 * dsh realpaths the plugin before loading it, and the profile granted no
 * metadata on /private, so the guard was disabled and the seat got no tools.
 * The proof missed it because its seat home lived under the temp folder too.
 *
 * Under real sandbox-exec, with the seat's state and workspace under the home
 * folder as a real seat's are: a file in the config folder resolves, and its
 * ancestors can be stat'ed, but a file directly in an ancestor can't be read,
 * an ancestor can't be listed, and nothing can be written there. The grant is
 * metadata only.
 */

import { spawnSync } from 'child_process';
import {
  existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync,
} from 'fs';
import { homedir, tmpdir } from 'os';
import { dirname, join } from 'path';

import { wrapArgvWithSeatbelt } from '../src/lib/sandbox/seatbelt.js';

const macTest = process.platform === 'darwin' ? test : test.skip;

describe('the MCP config folder\'s ancestors, under Seatbelt', () => {
  let home;
  let config;
  let beside;
  let written;

  beforeAll(() => {
    if (process.platform !== 'darwin') return;
    home = mkdtempSync(join(homedir(), '.commonly-mcp-ancestors-'));
    mkdirSync(join(home, 'workspace'));
    mkdirSync(join(home, 'state'));
    config = mkdtempSync(join(tmpdir(), 'commonly-mcp-ancestors-'));
    writeFileSync(join(config, 'guard.mjs'), 'export const name = "guard";\n');
    // A file directly in the config folder's parent: an ancestor, granted metadata only.
    beside = join(dirname(config), `commonly-mcp-ancestors-beside-${process.pid}.txt`);
    writeFileSync(beside, 'not for the jail');
    written = join(dirname(config), `commonly-mcp-ancestors-written-${process.pid}.txt`);
  });

  afterAll(() => {
    if (process.platform !== 'darwin') return;
    rmSync(home, { recursive: true, force: true });
    rmSync(config, { recursive: true, force: true });
    rmSync(beside, { force: true });
    rmSync(written, { force: true });
  });

  const probe = (code) => {
    const argv = wrapArgvWithSeatbelt([process.execPath, '-e', `
      const fs = require('fs');
      const r = {};
      const t = (k, f) => { try { r[k] = f(); } catch (e) { r[k] = 'DENIED ' + e.code; } };
      ${code}
      console.log(JSON.stringify(r));
    `], {
      workspacePath: join(home, 'workspace'),
      workspaceAccess: 'write',
      executablePath: process.execPath,
      statePath: join(home, 'state'),
      mcpConfigDir: config,
    });
    const run = spawnSync(argv[0], argv.slice(1), { cwd: join(home, 'workspace'), encoding: 'utf8', timeout: 20_000 });
    return JSON.parse((run.stdout || '{}').trim() || '{}');
  };

  macTest('the config folder sits under /private, so the case is real', () => {
    expect(realpathSync(config).startsWith('/private/')).toBe(true);
  });

  macTest('a file in the config folder resolves, and its ancestors can be stat\'ed', () => {
    const r = probe(`
      t('realpath', () => fs.realpathSync(${JSON.stringify(join(config, 'guard.mjs'))}));
      t('statPrivate', () => fs.statSync('/private').isDirectory());
      t('readGuard', () => fs.readFileSync(${JSON.stringify(join(config, 'guard.mjs'))}, 'utf8').length > 0);
    `);
    expect(r).toEqual({
      realpath: realpathSync(join(config, 'guard.mjs')),
      statPrivate: true,
      readGuard: true,
    });
  });

  macTest('an ancestor stays metadata only: no read of a file in it, no listing, no write', () => {
    const r = probe(`
      t('readBeside', () => fs.readFileSync(${JSON.stringify(beside)}, 'utf8'));
      t('listParent', () => fs.readdirSync(${JSON.stringify(dirname(config))}).length);
      t('listPrivate', () => fs.readdirSync('/private').length);
      t('write', () => { fs.writeFileSync(${JSON.stringify(written)}, 'x'); return 'WROTE'; });
    `);
    expect(r).toEqual({
      readBeside: 'DENIED EPERM', listParent: 'DENIED EPERM', listPrivate: 'DENIED EPERM', write: 'DENIED EPERM',
    });
    expect(existsSync(written)).toBe(false);
  });
});
