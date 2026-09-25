/**
 * The SSL decision in config/db-pg.ts — TASK-168.
 *
 * WHY THIS FILE EXISTS. On 2026-09-25 the new readiness gate made the kind smoke
 * test fail on the deploy step: the backend pod stayed 0/1 while every other pod
 * was Ready. The pod was not slow — it was in a state it could never leave.
 * `PG_SSL_ENABLED` was set to "false" by the chart and ignored by the code, so
 * the pool went into SSL mode against an in-cluster Postgres with no TLS, and the
 * connect failed with "The server does not support SSL connections". Before this
 * row, nothing reported that: the pod served Mongo-fallback chat and passed
 * readiness, so main's green smoke never proved PG was mounted at all.
 *
 * The empty-CA case is the sharper half. A zero-byte `ca.pem` (which is exactly
 * what the local chart mounts, and what any instance gets if its CA secret
 * materializes empty) used to count as a configured CA, because `fs.existsSync`
 * was the entire test — so it both forced TLS and handed Node nothing to verify
 * with. An unreadable/missing CA still disables SSL rather than blocking boot;
 * that is deliberate and asserted below.
 */
jest.mock('fs');

const { resolvePgSsl } = require('../../../config/db-pg');

const ca = (content) => ({ exists: true, content });
const missing = () => ({ exists: false, content: '' });

describe('resolvePgSsl — PG_SSL_ENABLED is read, not inferred (TASK-168)', () => {
  it('disables SSL when PG_SSL_ENABLED=false, even with a real CA present', () => {
    // The smoke cluster's shape: a real path, SSL explicitly off.
    const d = resolvePgSsl(
      { PG_SSL_ENABLED: 'false', PG_SSL_CA_PATH: '/app/certs/ca.pem' },
      () => ca('-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----'),
    );
    expect(d.ssl).toBe(false);
    expect(d.reason).toContain('PG_SSL_ENABLED=false');
  });

  it('disables SSL for a blank CA file instead of configuring an empty CA', () => {
    // The exact local placeholder: PG_SSL_CA_PATH set, file exists, zero bytes.
    const d = resolvePgSsl({ PG_SSL_CA_PATH: '/app/certs/ca.pem' }, () => ca(''));
    expect(d.ssl).toBe(false);
    expect(d.reason).toContain('empty');
  });

  it('disables SSL for a whitespace-only CA file too', () => {
    const d = resolvePgSsl({ PG_SSL_CA_PATH: '/app/certs/ca.pem' }, () => ca('  \n\t'));
    expect(d.ssl).toBe(false);
    expect(d.reason).toContain('empty');
  });

  it('disables SSL when no CA path is configured', () => {
    const d = resolvePgSsl({}, () => ca('anything'));
    expect(d.ssl).toBe(false);
    expect(d.reason).toContain('PG_SSL_CA_PATH');
  });

  it('disables SSL, without throwing, when the CA path does not exist', () => {
    const d = resolvePgSsl({ PG_SSL_CA_PATH: '/app/certs/ca.pem' }, missing);
    expect(d.ssl).toBe(false);
    expect(d.reason).toContain('not found');
  });

  it('disables SSL, without throwing, when reading the CA throws', () => {
    const d = resolvePgSsl({ PG_SSL_CA_PATH: '/app/certs/ca.pem' }, () => {
      throw new Error('EACCES: permission denied');
    });
    expect(d.ssl).toBe(false);
    expect(d.reason).toContain('EACCES');
  });

  it('enables SSL with the CA when SSL is on by default and the CA is real', () => {
    // Dev and prod: PG_SSL_ENABLED="true", a real Aiven CA. Unchanged behaviour.
    const pem = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----';
    const d = resolvePgSsl({ PG_SSL_CA_PATH: '/app/certs/ca.pem' }, () => ca(pem));
    expect(d.ssl).toEqual({ rejectUnauthorized: true, ca: pem });
  });

  it('treats PG_SSL_ENABLED="true" explicitly as enabled (not just unset)', () => {
    const pem = 'cert';
    const enabled = resolvePgSsl(
      { PG_SSL_ENABLED: 'true', PG_SSL_CA_PATH: '/app/certs/ca.pem' },
      () => ca(pem),
    );
    const unset = resolvePgSsl({ PG_SSL_CA_PATH: '/app/certs/ca.pem' }, () => ca(pem));
    expect(enabled.ssl).toEqual(unset.ssl);
    expect(enabled.ssl).not.toBe(false);
  });

  it('accepts any casing/spacing of "false"', () => {
    ['FALSE', 'False', ' false '].forEach((v) => {
      const d = resolvePgSsl(
        { PG_SSL_ENABLED: v, PG_SSL_CA_PATH: '/app/certs/ca.pem' },
        () => ca('cert'),
      );
      expect(d.ssl).toBe(false);
    });
  });
});

describe('the module reads the same decision it exports', () => {
  it('wires resolvePgSsl into the pool config rather than deciding inline', () => {
    // A second copy of the rule is how the first one drifted from the chart's
    // documented intent. The module must call the exported function.
    // jest.mock('fs') at the top of this file auto-mocks readFileSync, so the
    // real one has to be asked for by name — otherwise this assertion reads
    // `undefined` and compares it against a string (a red for the wrong reason).
    const realFs = jest.requireActual('fs');
    const source = realFs.readFileSync(
      require('path').join(__dirname, '../../../config/db-pg.ts'),
      'utf8',
    );
    expect(source).toContain('const sslDecision = resolvePgSsl(process.env');
    expect(source).toContain('pgConfig.ssl = sslDecision.ssl');
  });
});
