// @ts-nocheck
// TASK-547: a copy-paste setup command on the BYO, Connect or runtime
// pages must target the instance the page is on. A bare `commonly login` falls
// back to the CLI's built-in production default, so on dev or a self-hosted
// instance the computer would register against commonly.me.
const fs = require('fs');
const path = require('path');
const { daemonSetupCommand } = require('../utils/daemonSetupCommand');

const SOURCES = [
  'components/V2AgentBYO.tsx',
  'components/V2AgentRuntimeGrants.tsx',
  'components/V2ConnectPage.tsx',
];
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

describe('copy-paste setup commands follow the page instance', () => {
  beforeEach(() => { process.env.REACT_APP_API_URL = 'https://api-dev.example.test/'; });
  afterEach(() => { delete process.env.REACT_APP_API_URL; });

  test('the computer setup command logs in to the page instance, not the CLI default', () => {
    const command = daemonSetupCommand();
    expect(command).toContain('commonly login --instance https://api-dev.example.test ');
    expect(command).not.toMatch(/commonly\.me/);
  });

  test('no BYO, Connect or runtime source hardcodes the production API host', () => {
    SOURCES.forEach((rel) => {
      expect([rel, read(rel).match(/api\.commonly\.me/g)]).toEqual([rel, null]);
    });
  });
});
