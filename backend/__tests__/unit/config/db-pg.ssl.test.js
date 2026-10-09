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
 * The empty-CA case is the sharper half, and it has two halves of its own. A
 * zero-byte `ca.pem` (which is exactly what the local chart mounts, and what any
 * instance gets if its CA secret materializes empty) used to count as a
 * configured CA, because `fs.existsSync` was the entire test — so it both forced
 * TLS and handed Node nothing to verify with. The first fix for that disabled
 * SSL, which turned a loud failed handshake into a successful PLAINTEXT
 * connection: a security direction change in the file whose whole job is
 * transport security (sprint-review, 74244). What is asserted now is the middle:
 * a configured CA path with an unusable file keeps TLS ON with no custom CA, so
 * the connect fails loudly and readiness reports it. Only an absent CA path (the
 * pre-existing behaviour) or an explicit `PG_SSL_ENABLED=false` reaches plaintext
 * — and a present-but-BLANK path is not absent (sprint-review, 74253).
 *
 * The level is asserted too: a missing CA file warned on main and an info line is
 * what this row exists to kill (sprint-review, 74245).
 */
jest.mock('fs');

const { resolvePgSsl } = require('../../../config/db-pg');

const ca = (content) => ({ exists: true, content });
const missing = () => ({ exists: false, content: '' });

// "unusable CA" = TLS stays required, verified against the system store. The
// reason string is asserted too, so the test pins WHY each branch ran and not
// just that no CA was attached.
const expectTlsKept = (d, why) => {
  expect(d.ssl).toEqual({ rejectUnauthorized: true });
  expect(d.reason).toContain(why);
  expect(d.reason).toContain('instead of downgrading to plaintext');
  // An explicit TLS intent that failed is not routine config (sprint-review,
  // 74245). Main warned for a missing CA file; the assertion is here so the
  // level cannot quietly drop back to info.
  expect(d.level).toBe('warn');
};

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

  it('keeps TLS on, with no custom CA, for a blank CA file rather than going plaintext', () => {
    // The exact local placeholder: PG_SSL_CA_PATH set, file exists, zero bytes.
    // With PG_SSL_ENABLED unset, TLS was asked for by configuring a CA path — a
    // zero-byte secret is a misconfiguration, not a request for plaintext.
    const d = resolvePgSsl({ PG_SSL_CA_PATH: '/app/certs/ca.pem' }, () => ca(''));
    expectTlsKept(d, 'is empty');
  });

  it('keeps TLS on for a whitespace-only CA file too', () => {
    const d = resolvePgSsl({ PG_SSL_CA_PATH: '/app/certs/ca.pem' }, () => ca('  \n\t'));
    expectTlsKept(d, 'is empty');
  });

  it('keeps TLS on even when PG_SSL_ENABLED=true and the CA file is unusable', () => {
    // The shape a dev/prod pod lands in if the CA secret materializes empty:
    // SSL explicitly requested + nothing to verify with. Fails the handshake,
    // which readiness surfaces — it does NOT fall back to an unencrypted chat
    // connection because a secret was momentarily empty.
    const d = resolvePgSsl(
      { PG_SSL_ENABLED: 'true', PG_SSL_CA_PATH: '/app/certs/ca.pem' },
      () => ca(''),
    );
    expectTlsKept(d, 'is empty');
  });

  it('disables SSL when no CA path is configured', () => {
    const d = resolvePgSsl({}, () => ca('anything'));
    expect(d.ssl).toBe(false);
    expect(d.reason).toContain('PG_SSL_CA_PATH');
    expect(d.level).toBe('info');
  });

  it('sends a present-but-blank CA path to keepTls, not to the unset branch', () => {
    // Measured by sprint-review (74253): the first cut decided "unset" on the
    // TRIMMED value, so a whitespace-only path downgraded to plaintext one line
    // below the empty-FILE case that correctly failed closed. The key is what
    // separates "not configured" from "configured wrong".
    const d = resolvePgSsl({ PG_SSL_CA_PATH: '   ' }, () => ca('cert'));
    expectTlsKept(d, 'is blank');
  });

  it('treats an empty-string CA path as blank too, but an absent key as unset', () => {
    // `''` is how a chart renders "not provided", and it is still a CA path this
    // process was handed: present-but-blank. Only a missing key is unset.
    const emptyString = resolvePgSsl({ PG_SSL_CA_PATH: '' }, () => ca('cert'));
    const absent = resolvePgSsl({}, () => ca('cert'));
    expect(emptyString.level).toBe('warn');
    expect(emptyString.ssl).toEqual({ rejectUnauthorized: true });
    expect(absent.ssl).toBe(false);
    expect(absent.level).toBe('info');
  });

  it('covers all five configuration shapes, and only two of them are plaintext', () => {
    // The table sprint-review drove (74252) — kept as one assertion so a change
    // to any single shape is visible against the others, not just in isolation.
    const shapes = {
      'CA file empty': resolvePgSsl({ PG_SSL_CA_PATH: '/ca.pem' }, () => ca('')),
      'CA file missing': resolvePgSsl({ PG_SSL_CA_PATH: '/ca.pem' }, missing),
      'CA path whitespace-only': resolvePgSsl({ PG_SSL_CA_PATH: '  ' }, () => ca('cert')),
      'CA path unset': resolvePgSsl({}, () => ca('cert')),
      'SSL explicitly off': resolvePgSsl({ PG_SSL_ENABLED: 'false' }, () => ca('cert')),
    };
    const plaintext = Object.entries(shapes)
      .filter(([, d]) => d.ssl === false)
      .map(([name]) => name);
    expect(plaintext).toEqual(['CA path unset', 'SSL explicitly off']);
    expect(shapes['CA path whitespace-only'].level).toBe('warn');
  });

  it('keeps TLS on, without throwing, when the CA path does not exist', () => {
    const d = resolvePgSsl({ PG_SSL_CA_PATH: '/app/certs/ca.pem' }, missing);
    expectTlsKept(d, 'not found');
  });

  it('keeps TLS on, without throwing, when reading the CA throws', () => {
    const d = resolvePgSsl({ PG_SSL_CA_PATH: '/app/certs/ca.pem' }, () => {
      throw new Error('EACCES: permission denied');
    });
    expectTlsKept(d, 'EACCES');
  });

  it('is the ONLY pairing that yields plaintext: explicit off, or no CA path at all', () => {
    // Guards the direction of the fix. Plaintext has exactly two doors, both of
    // them deliberate, and neither of them is "a CA path we could not use".
    const explicitOff = resolvePgSsl(
      { PG_SSL_ENABLED: 'false', PG_SSL_CA_PATH: '/app/certs/ca.pem' },
      () => ca('cert'),
    );
    const noPath = resolvePgSsl({}, () => ca('cert'));
    const emptyCa = resolvePgSsl({ PG_SSL_CA_PATH: '/app/certs/ca.pem' }, () => ca(''));
    const blankPath = resolvePgSsl({ PG_SSL_CA_PATH: ' ' }, () => ca('cert'));
    expect(explicitOff.ssl).toBe(false);
    expect(noPath.ssl).toBe(false);
    expect(emptyCa.ssl).not.toBe(false);
    expect(blankPath.ssl).not.toBe(false);
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
    // The level travels with the decision, so the caller cannot flatten a failed
    // TLS intent back into an info line (sprint-review, 74245).
    expect(source).toContain("sslDecision.level === 'warn' ? console.warn : console.log");
  });
});
