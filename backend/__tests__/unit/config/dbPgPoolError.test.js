/**
 * The pg pool must have an 'error' listener.
 *
 * node-postgres emits 'error' on an IDLE pooled client when the server drops
 * the connection. EventEmitter turns an 'error' event with no listener into a
 * thrown exception, which terminates the process — so the absence of this one
 * listener is the difference between a reconnect and an outage.
 *
 * It took the API down twice on 2026-08-20 with the FATAL
 * "terminating connection due to administrator command", which is what managed
 * Postgres says during failover, patching, or connection recycling. A routine
 * provider-side event was converting into a full outage, once per maintenance
 * window, forever.
 *
 * Asserted on the module's own registration rather than by simulating a crash:
 * a test that actually emitted an unhandled error would take the jest worker
 * down with it, which is the very behaviour under test.
 */
const path = require('path');

describe('pg pool error handling', () => {
  const modulePath = path.join(__dirname, '../../../config/db-pg.ts');
  const registered = [];

  beforeEach(() => {
    jest.resetModules();
    registered.length = 0;
    process.env.PG_HOST = 'localhost';
    process.env.PG_USER = 'test';
    process.env.PG_PASSWORD = 'test';
    process.env.PG_DATABASE = 'test';

    jest.doMock('pg', () => ({
      Pool: class FakePool {
        on(event, cb) {
          registered.push(event);
          return this;
        }

        connect() { return Promise.resolve({ query: async () => ({ rows: [{}] }), release() {} }); }

        query() { return Promise.resolve({ rows: [] }); }

        end() { return Promise.resolve(); }
      },
    }));
  });

  afterEach(() => {
    jest.dontMock('pg');
  });

  it("registers an 'error' listener, without which an idle-client error kills the process", () => {
    // eslint-disable-next-line global-require, import/no-dynamic-require
    require(modulePath);
    expect(registered).toContain('error');
  });

  it("still registers the 'connect' listener it already had", () => {
    // The error handler was added beside an existing connect handler; this
    // pins that the addition did not displace it.
    // eslint-disable-next-line global-require, import/no-dynamic-require
    require(modulePath);
    expect(registered).toContain('connect');
  });
});
