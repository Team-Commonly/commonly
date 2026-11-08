// Stream-level env redaction for Jest runs.
//
// Why this exists: on 2026-11-07 a Jest failure in a builder run printed the
// whole process env into the run's captured stdout, leaking a live session
// token. The console mock in __tests__/setup.js does NOT catch this — Jest's
// human-readable failure diff, and any forwarded or TEST_VERBOSE console output,
// are written by the Jest MAIN process straight to process.stdout / stderr,
// below the mocked `global.console`. So the guard patches the streams
// themselves, in both the main process (globalSetup.js) and the workers
// (setup.js), covering every path that reaches a run's captured output.
//
// It never prints a secret: it reads sensitive values into an in-memory map and
// rewrites any occurrence to `[REDACTED:<NAME>]`.
//
// The map is a snapshot of process.env at install time, matched verbatim: a
// secret set after install, or one that appears transformed (URL-encoded inside
// a connection URI, base64, JSON-escaped), is not caught. The dump this guards
// against prints values verbatim, which is covered.

// Env var NAMES whose VALUE must never reach test output (case-insensitive).
// AUTH is deliberately excluded: SSH_AUTH_SOCK and similar are paths, not
// secrets, and matching them would redact useful output.
const SECRET_NAME = /(TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE_KEY|CREDENTIAL|API_?KEY|ACCESS_KEY|MASTER_KEY|_PAT$|_KEY$|MONGO_URI|DATABASE_URL|CONNECTION_STRING|_DSN$)/i;

// Short values are skipped: rarely secret, and a common substring would corrupt
// unrelated output. A real credential clears this length easily.
const MIN_SECRET_LEN = 8;

// Marks a stream as already patched (stores its unpatch fn) so installing from
// both the main process and each per-file worker realm wraps the shared
// process.stdout/stderr exactly once instead of stacking wrappers N-deep.
const PATCHED = Symbol.for('commonly.jest.envRedaction.patched');

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// [name, value] for every secret-named var with a long-enough string value,
// longest value first so an overlapping shorter value can't pre-empt a longer
// match (e.g. a token that happens to contain a password substring).
function collectSecrets(env) {
  return Object.entries(env)
    .filter(([name, value]) => typeof value === 'string'
      && value.length >= MIN_SECRET_LEN
      && SECRET_NAME.test(name))
    .sort((a, b) => b[1].length - a[1].length);
}

// Pure, global-free: returns (str) => redactedStr. Returns identity when there
// is nothing to redact so callers can install unconditionally.
function makeRedactor(env = process.env) {
  const pairs = collectSecrets(env);
  if (pairs.length === 0) return (str) => str;

  const byValue = new Map();
  pairs.forEach(([name, value]) => {
    if (!byValue.has(value)) byValue.set(value, `[REDACTED:${name}]`);
  });
  const pattern = new RegExp(Array.from(byValue.keys()).map(escapeRegExp).join('|'), 'g');
  return (str) => str.replace(pattern, (m) => byValue.get(m) || '[REDACTED]');
}

// Patch one Writable so string chunks pass through the redactor. Buffers and
// other chunk types pass untouched, so a non-text write or Jest's own stream
// framing is never corrupted. Returns an unpatch function.
function patchStream(stream, redactor) {
  // Idempotent per stream: a second call returns the existing unpatch without
  // wrapping write again, so the shared process.stdout/stderr never stack.
  if (stream[PATCHED]) return stream[PATCHED];
  const original = stream.write.bind(stream);
  stream.write = function patchedWrite(chunk, ...rest) {
    if (typeof chunk === 'string' && chunk.length > 0) {
      return original(redactor(chunk), ...rest);
    }
    return original(chunk, ...rest);
  };
  const unpatch = () => { stream.write = original; delete stream[PATCHED]; };
  stream[PATCHED] = unpatch;
  return unpatch;
}

// Patch process.stdout and process.stderr. Idempotent per stream (see
// patchStream), so calling from both globalSetup (main realm) and setup.js
// (per-file worker realm) wraps each shared stream exactly once. Returns true
// when this call was the one that patched the streams.
function installStreamEnvRedaction(env = process.env) {
  const fresh = !process.stdout[PATCHED];
  const redactor = makeRedactor(env);
  patchStream(process.stdout, redactor);
  patchStream(process.stderr, redactor);
  return fresh;
}

module.exports = {
  installStreamEnvRedaction,
  makeRedactor,
  patchStream,
  collectSecrets,
  SECRET_NAME,
  MIN_SECRET_LEN,
};
