/* eslint-disable import/no-unresolved, import/extensions */
// setup.js runs before every test file (jest `setupFiles`). process.env is per
// test FILE (measured), so what this file observes is setup.js's own effect and
// nothing another suite did.
const { pool } = require('../../../config/db-pg');

describe('unit-suite DB env (setup.js in-memory mode)', () => {
  it('does not store the string "undefined" in PG_HOST / MONGO_URI', () => {
    // The defect signature: `process.env.PG_HOST = undefined` stores the STRING
    // 'undefined', which is truthy and satisfies every `if (process.env.PG_HOST)`
    // guard in the backend.
    expect(process.env.PG_HOST).not.toBe('undefined');
    expect(process.env.MONGO_URI).not.toBe('undefined');
  });

  it('builds no Pool for the host string "undefined"', () => {
    // The consequence (db-pg.ts:75): a truthy host string constructs a real Pool.
    // Asserted on the pool's own config rather than on `pool === null`, so a
    // developer with a real PG_HOST in the environment still passes.
    const host = pool && pool.options && pool.options.host;
    expect(host).not.toBe('undefined');
  });
});
