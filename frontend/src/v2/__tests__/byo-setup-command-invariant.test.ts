// @ts-nocheck
// TASK-547 (D39): a copy-paste setup command on the BYO, Connect or runtime
// pages must target the instance the page is on. A bare `commonly login` falls
// back to the CLI's built-in production default, so on dev or a self-hosted
// instance the computer would register against commonly.me.
const fs = require('fs');
const path = require('path');
const { daemonSetupCommand } = require('../utils/daemonSetupCommand');

// Every v2 source file, not a fixed list: a new surface that hardcodes the host
// (the invite modal, Your Team, a future copy button) must fail here too.
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const full = path.join(dir, entry.name);
  if (entry.isDirectory()) return ['__tests__', '__mocks__'].includes(entry.name) ? [] : walk(full);
  return /\.(tsx?|jsx?)$/.test(entry.name) && !/\.test\./.test(entry.name) ? [full] : [];
});
const V2_ROOT = path.join(__dirname, '..');
const SOURCES = walk(V2_ROOT).map((file) => path.relative(V2_ROOT, file));
const read = (rel) => fs.readFileSync(path.join(V2_ROOT, rel), 'utf8');

describe('copy-paste setup commands follow the page instance', () => {
  beforeEach(() => { process.env.REACT_APP_API_URL = 'https://api-dev.example.test/'; });
  afterEach(() => { delete process.env.REACT_APP_API_URL; });

  test('the computer setup command logs in to the page instance, not the CLI default', () => {
    const command = daemonSetupCommand();
    expect(command).toContain('commonly login --instance https://api-dev.example.test ');
    expect(command).not.toMatch(/commonly\.me/);
  });

  test('no v2 source hardcodes the production API host', () => {
    expect(SOURCES.length).toBeGreaterThan(20);
    SOURCES.forEach((rel) => {
      expect([rel, read(rel).match(/api\.commonly\.me/g)]).toEqual([rel, null]);
    });
  });
});
