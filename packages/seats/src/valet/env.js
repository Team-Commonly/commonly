/**
 * Build the env and HOME one run executes in. The run starts from nothing the
 * user's login can be found through: a short allowlist of locale/terminal
 * variables, a fresh HOME whose XDG dirs sit inside it, and only the
 * credentials its grant names.
 *
 * What this is NOT: a filesystem sandbox. A process that already knows an
 * absolute path (/Users/<you>/.claude) can still open it, and macOS keychain
 * items are reached through the user's security session, not through HOME.
 * This removes the paths a CLI discovers its login by; an OS sandbox
 * (Seatbelt, bwrap) is what stops a process that goes looking.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, chmod, readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join, resolve, sep } from 'node:path';
import { traceOf } from '../trace/events.js';
import { runFailure } from '../failures.js';
import { MIN_CREDENTIAL_LENGTH } from '../upstream-refusal.js';
import { validateGrant } from './grant.js';

// Same spirit as the goose adapter's SAFE_ENV: locale, terminal and TLS trust
// only. USER/LOGNAME are left out on purpose; they name the account whose
// login this boundary exists to hide.
export const BASE_ENV_ALLOWLIST = /^(?:PATH|LANG|LC_[A-Z0-9_]+|TERM|TZ|SSL_CERT_FILE|SSL_CERT_DIR|NO_COLOR|CI)$/;

const isInside = (path, dir) => {
  const a = resolve(path);
  const b = resolve(dir);
  return a === b || a.startsWith(b.endsWith(sep) ? b : b + sep);
};

/**
 * PATH entries under the real home both name it and often hold shims that
 * read the user's login (~/.local/bin/claude). Adapters run their CLI by
 * absolute path, so the run loses nothing it needs.
 */
const scrubPath = (value, realHomes) => value.split(delimiter)
  .filter((entry) => entry && !realHomes.some((home) => isInside(entry, home)))
  .join(delimiter);

const pickBaseEnv = (baseEnv, realHomes) => {
  const env = {};
  for (const [name, value] of Object.entries(baseEnv)) {
    if (typeof value === 'string' && BASE_ENV_ALLOWLIST.test(name)) env[name] = value;
  }
  if (env.PATH !== undefined) env.PATH = scrubPath(env.PATH, realHomes);
  return env;
};

const makeHome = async (root) => {
  const home = await mkdtemp(join(root || tmpdir(), 'seat-home-'));
  // Conventional layout, so a CLI that ignores XDG_* and defaults to
  // ~/.config still lands inside the throwaway HOME.
  const dirs = {
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_STATE_HOME: join(home, '.local', 'state'),
    XDG_CACHE_HOME: join(home, '.cache'),
    TMPDIR: join(home, 'tmp'),
  };
  await chmod(home, 0o700);
  for (const dir of Object.values(dirs)) await mkdir(dir, { recursive: true, mode: 0o700 });
  // mkdir's mode is masked by umask; set it explicitly on every level made.
  for (const dir of [join(home, '.local'), ...Object.values(dirs)]) await chmod(dir, 0o700);
  return { home, dirs };
};

/** A value that cannot ride an env var is the same as no value. */
const usable = (value) => typeof value === 'string' && value.length > 0 && !value.includes('\0');

const resolveOne = async (spec, { baseEnv, resolveSecret }) => {
  if (spec.from === 'env') return baseEnv[spec.ref || spec.name];
  if (spec.from === 'file') return (await readFile(spec.ref, 'utf8')).replace(/\r?\n$/, '');
  if (typeof resolveSecret !== 'function') return undefined;
  return resolveSecret(spec.name, spec);
};

/**
 * The grant.issued entry for grantMeta. Its scope is the room grant this run
 * acts under (exact tool names, a connection id), as the host knows it; the
 * run grant's own credential names and patterns show up in credential.* and
 * in each permission.decided rule. `taskId` + `podId` bind the grant to that
 * board task, ending when it is done unless `endsOn` says otherwise.
 */
const grantIssued = (meta) => {
  const {
    grantId = randomUUID(), parentGrantId, scope = {}, target, issuedBy, expiresAt, taskId, podId, endsOn = 'task.done',
  } = meta;
  return {
    grantId,
    ...(parentGrantId === undefined ? {} : { parentGrantId }),
    scope: { tools: [], audience: [], ...scope },
    ...(target ? { target } : {}),
    ...(issuedBy ? { issuedBy } : {}),
    ...(expiresAt ? { expiresAt: expiresAt instanceof Date ? expiresAt.toISOString() : expiresAt } : {}),
    ...(taskId ? { binding: { taskId, podId, endsOn } } : {}),
  };
};

/**
 * prepareRunEnv({ grant, baseEnv, resolveSecret, root?, require?, trace?, ctx?, grantMeta? })
 *   → { env, home, cleanup, granted: [names], grantId? }
 *
 * `require` lists credential names the adapter cannot run without; one the
 * grant does not name fails the run as credential_denied before any spawn.
 * A named credential that cannot be resolved, or that resolves to fewer than
 * MIN_CREDENTIAL_LENGTH characters, fails it the same way: a run that
 * silently lacks its key fails later and less legibly, and a value that short
 * would slip past the refusal-text reader's redaction.
 *
 * Events go to `trace`, else ctx.trace: grant.issued (only with grantMeta,
 * first), then credential.granted {names} or credential.denied {name, reason}.
 * Values never enter an event or a message, and a hook that offers
 * redact(values) is handed the resolved values so the record can scrub them
 * out of agent text too.
 */
export const prepareRunEnv = async ({
  grant, baseEnv = {}, resolveSecret, root, require: required = [], trace, ctx, grantMeta,
} = {}) => {
  const valid = validateGrant(grant);
  const hook = trace && typeof trace.emit === 'function' ? trace : traceOf(ctx);
  const issued = grantMeta ? grantIssued(grantMeta) : null;
  if (issued) hook.emit('grant.issued', issued);
  const realHomes = [...new Set([baseEnv.HOME, homedir()].filter(Boolean))];
  const DENIED = {
    not_granted: 'is not in the run grant',
    unresolved: 'could not be resolved',
    too_short: `resolved to a value shorter than ${MIN_CREDENTIAL_LENGTH} characters`,
  };
  const deny = (name, reason, values) => {
    hook.emit('credential.denied', { name, reason });
    return runFailure('credential_denied', `${name} ${DENIED[reason]}`, { credentials: values });
  };

  const granted = new Set(valid.credentials.map((c) => c.name));
  const missing = required.find((name) => !granted.has(name));
  if (missing) throw deny(missing, 'not_granted', []);

  const { home, dirs } = await makeHome(root);
  const cleanup = () => rm(home, { recursive: true, force: true });
  const env = { ...pickBaseEnv(baseEnv, realHomes), HOME: home, ...dirs };
  const values = [];
  try {
    for (const spec of valid.credentials) {
      let value;
      // A resolver's error text may quote the secret it failed on; drop it.
      try { value = await resolveOne(spec, { baseEnv, resolveSecret }); } catch { value = undefined; }
      if (!usable(value)) throw deny(spec.name, 'unresolved', values);
      // A value this short cannot be told apart from ordinary text, so the
      // refusal-text reader would not redact it. Refuse it here, before spawn.
      if (value.length < MIN_CREDENTIAL_LENGTH) throw deny(spec.name, 'too_short', values);
      values.push(value);
      env[spec.name] = value;
    }
  } catch (error) {
    await cleanup();
    throw error;
  }
  if (typeof hook.redact === 'function') hook.redact(values);
  const names = valid.credentials.map((c) => c.name);
  hook.emit('credential.granted', { names });
  return { env, home, cleanup, granted: names, ...(issued ? { grantId: issued.grantId } : {}) };
};
