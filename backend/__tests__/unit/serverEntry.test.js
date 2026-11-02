/**
 * ADR-034 D6: the process entry refuses to start without PostgreSQL. Chat is
 * stored only there, so an instance without PG_HOST would run with no place
 * to put a message. Tests build the app without PG_HOST on purpose, so this
 * is checked on the real entry, in its own process, from an empty directory
 * (no .env to supply a PG_HOST).
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BACKEND = path.join(__dirname, '../..');

describe('server entry', () => {
  it('exits before starting anything when PG_HOST is unset, and says why', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'server-entry-'));
    try {
      const run = spawnSync(process.execPath, ['-r', require.resolve('ts-node/register'), path.join(BACKEND, 'server.ts')], {
        cwd,
        env: {
          PATH: process.env.PATH,
          HOME: cwd,
          NODE_ENV: 'test',
          TS_NODE_TRANSPILE_ONLY: 'true',
          TS_NODE_PROJECT: path.join(BACKEND, 'tsconfig.json'),
        },
        encoding: 'utf8',
        timeout: 90000,
      });
      expect(run.signal).toBeNull();
      expect(run.status).not.toBe(0);
      expect(run.stderr).toMatch(/PostgreSQL is required: set PG_HOST/);
      expect(run.stdout).not.toMatch(/Server running on port/);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  }, 120000);
});
