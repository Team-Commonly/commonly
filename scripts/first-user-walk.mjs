#!/usr/bin/env node
/**
 * Daily first-user walk (TASK-706). A brand-new non-admin account, as a
 * stranger would meet Commonly: sign up, get a hosted agent reply in the first
 * pod, and invite a person whose link opens. Every step prints pass/fail, its
 * duration, and the first error text. A failure exits 1 and names the step.
 *
 * Walk accounts are recognisable by WALK_PREFIX (`walk-`), which Growth's
 * numbers exclude. Each run removes the seat, the pods it created and its own
 * account, then checks each of them is gone. What the walk's token cannot
 * reach (Scout, the hosted agent's User) is recorded by id in a per-run
 * manifest under the state dir, for SRE's admin purge. Password comes from
 * COMMONLY_WALK_PASSWORD, never from this file.
 *
 * Machine-readable signal (TASK-729): every run also overwrites a result file
 * (default ~/.commonly/state/walk-729/result.json, override COMMONLY_WALK_RESULT)
 * with the sha, timings, each step's pass / fail / not-covered and its reason,
 * the cleanup outcome and `overall` (pass | fail | incomplete). The exit code
 * matches: 0 pass, 1 fail, 2 incomplete. The file never holds the password, the
 * token or the email.
 *
 * Usage:
 *   COMMONLY_WALK_PROD_EMAIL=... COMMONLY_WALK_PROD_PASSWORD=... \
 *     node scripts/first-user-walk.mjs [--base https://api.commonly.me]
 *
 * Prod: no signup. The run signs in to one existing test account (the PROD
 * variables above), runs the six covered steps, removes only what it created, and
 * never deletes that account. Without COMMONLY_WALK_PROD_EMAIL a prod run is refused.
 *
 * Staging: signup needs a verified email, so SRE's shared walk account is used
 * instead. Set COMMONLY_WALK_EMAIL and COMMONLY_WALK_PASSWORD from env (never a
 * flag default or a file in the repo) and pass the staging API as --base. The
 * run signs in, removes only its own pods, seats and agents, and never deletes
 * that account. A COMMONLY_WALK_EMAIL aimed at any other host is refused.
 *
 * Not yet covered: the Bring your own connect step (copy the command, run it
 * under a throwaway HOME, get a live reply). It is recorded as not-covered and
 * the run is `incomplete` (exit 2), so a green run never claims more than it checked.
 */

import { mkdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanupRun, ownerOf, recoverRunPods } from './first-user-walk-cleanup.mjs';
import { chooseWalkMode } from './first-user-walk-mode.mjs';

const WALK_PREFIX = 'walk-';
// Every request is bounded, cleanup included, so one stalled socket cannot
// hold the run or the report open.
const REQUEST_TIMEOUT_MS = 20_000;
const HOSTED_REPLY_WAIT_MS = 120_000;

const DEFAULT_STATE_DIR = path.join(homedir(), '.commonly', 'state', 'walk-706');
const DEFAULT_RESULT_PATH = path.join(homedir(), '.commonly', 'state', 'walk-729', 'result.json');

const NOT_COVERED = 'Bring your own connect step is not implemented yet';

const expect = (cond, msg) => { if (!cond) throw new Error(msg); };

/**
 * One walk run. Every dependency is injectable so the production path can be
 * exercised under test without the network or the clock.
 *   base       API origin, e.g. https://api.commonly.me
 *   env        COMMONLY_WALK_PASSWORD, COMMONLY_WALK_EMAIL (never logged)
 *   fetchImpl  fetch-compatible
 *   stateDir   per-run manifest directory (ids only)
 *   resultPath machine-readable result file (overwritten each run)
 *   sha        deployed sha recorded in the result, or null
 * Resolves to { exitCode, result }. It never calls process.exit.
 */
export const runWalk = async ({
  base,
  env = {},
  fetchImpl = fetch,
  stateDir = process.env.COMMONLY_WALK_STATE_DIR || DEFAULT_STATE_DIR,
  resultPath = process.env.COMMONLY_WALK_RESULT || DEFAULT_RESULT_PATH,
  sha = null,
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
  log = (line) => console.log(line),
  error = (line) => console.error(line),
}) => {
  const BASE = String(base).replace(/\/+$/, '');
  const startedMs = now();
  const startedAt = new Date(startedMs).toISOString();
  const stamp = startedMs.toString(36);
  const username = `${WALK_PREFIX}${stamp}`;
  let password = env.COMMONLY_WALK_PASSWORD || '';
  let email = `${username}@example.invalid`;
  const agentName = `${username}-agent`;
  const results = [];
  let step = 'init';
  // True once signup may have created the account, so cleanup knows to look for it.
  let accountMayExist = false;
  // 'signup' makes a fresh account; 'signin' uses the shared staging account and never deletes it.
  // Null until chooseWalkMode accepts the run, so a refused run is never reported as signup.
  let walkMode = null;
  let cleanupRan = false;
  // Signup returns no user id, so the manifest carries the exact username instead:
  // SRE finds the account by that name, not by a prefix. Never the email.
  const manifest = { mode: null, userId: null, username: null, podIds: [], unresolvedPodNames: [], agentName: null, botIds: [], survivors: [], status: 'running' };

  // Anything that can carry a credential is scrubbed before it reaches a log or
  // the result file. An API error body can echo what was sent.
  const redact = (text) => {
    let out = String(text);
    for (const secret of [password, email]) {
      if (!secret) continue;
      // The JSON-escaped form too: a body echo puts a quote or backslash in escaped form.
      for (const form of new Set([secret, JSON.stringify(secret).slice(1, -1)])) out = out.split(form).join('[redacted]');
    }
    return out;
  };

  const api = async (method, apiPath, { token, body } = {}) => {
    const res = await fetchImpl(`${BASE}${apiPath}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'commonly-walk/first-user',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      // A redirect would replay the JSON body, shared password included, to another origin.
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    let data = null;
    try { data = await res.json(); } catch { /* non-json */ }
    return { status: res.status, data };
  };

  // Runs one named step. A thrown error or a falsy check is a failure; the
  // first failure stops the walk, because later steps depend on earlier ones.
  const runStep = async (name, fn) => {
    step = name;
    const started = now();
    try {
      const value = await fn();
      results.push({ name, result: 'pass', ms: now() - started });
      log(`PASS ${name} (${now() - started} ms)`);
      return value;
    } catch (caught) {
      const reason = redact(caught.message);
      results.push({ name, result: 'fail', ms: now() - started, reason });
      error(`FAIL ${name} (${now() - started} ms): ${reason}`);
      throw caught;
    }
  };

  // Per-run manifest: ids only, outside the repo, for SRE's admin purge of what
  // the walk's own token cannot remove (Scout, the hosted agent's User). It holds
  // no password, token or email. It is named by the run stamp, not the username.
  // A pod whose create outcome could not be checked. Its name is unique to the run,
  // so SRE can find it by exact name, the same way as the account.
  const unresolvedSurvivors = () => manifest.unresolvedPodNames.map((name) => `pod named "${name}" (create outcome unknown)`);
  const writeManifest = () => {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    writeFileSync(path.join(stateDir, `${stamp}.json`), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  };

  // Returns false when anything survives, so the run fails loudly. Signup can
  // create the account before the walk has a token, so cleanup signs in once
  // more; if that fails the account is a survivor, not a silent gap.
  const cleanup = async (token) => {
    let session = token;
    if (!session && accountMayExist) {
      try {
        const r = await api('POST', '/api/auth/login', { body: { email, password } });
        if (r.status === 200 && r.data?.token) {
          session = r.data.token;
          manifest.userId = manifest.userId || String(r.data.user?._id || r.data.user?.id || '');
        }
      } catch {
        // A network failure here leaves no session: it is reported below as a survivor.
      }
    }
    if (!session) {
      manifest.survivors = [
        ...manifest.podIds.map((id) => `pod:${id} (no sign-in for cleanup)`),
        ...(accountMayExist ? [`account ${manifest.username} (no sign-in for cleanup)`] : []),
        ...unresolvedSurvivors(),
      ];
      manifest.status = manifest.survivors.length ? 'needs-admin-purge' : 'clean';
      writeManifest();
      if (manifest.survivors.length) error(`cleanup: ${username} survives; sign-in failed`);
      return manifest.survivors.length === 0;
    }
    try {
      const result = await cleanupRun({
        api,
        token: session,
        password,
        email,
        userId: manifest.userId,
        agentName,
        podIds: manifest.podIds,
        deleteAccount: walkMode.deleteAccount,
        // Persist each pod's bot ids before that pod is deleted, so a throw
        // later in the loop still leaves the ids SRE needs.
        onBotIds: (podId, bots) => {
          manifest.botIds = [...new Set([...manifest.botIds, ...bots])];
          writeManifest();
        },
      });
      manifest.survivors = [...result.survivors, ...unresolvedSurvivors()];
      manifest.botIds = [...new Set([...manifest.botIds, ...result.botIds])];
      manifest.status = result.ok && manifest.survivors.length === 0 ? 'clean' : 'needs-admin-purge';
    } catch (caught) {
      manifest.survivors = [`cleanup error: ${redact(caught.message)}`, ...unresolvedSurvivors()];
      manifest.status = 'needs-admin-purge';
    }
    writeManifest();
    if (manifest.status === 'clean') log(`cleanup: removed ${username}`);
    else error(`cleanup: survivors: ${manifest.survivors.map(redact).join('; ')}`);
    return manifest.status === 'clean';
  };

  const writeResult = (exitCode, cleanupOk) => {
    const overall = exitCode === 0 ? 'pass' : exitCode === 2 ? 'incomplete' : 'fail';
    const result = {
      schema: 1,
      sha,
      startedAt,
      finishedAt: new Date(now()).toISOString(),
      base: BASE,
      mode: walkMode ? walkMode.mode : 'not-chosen',
      walk: username,
      overall,
      exitCode,
      steps: results,
      // 'not-run' and ok null when cleanup never ran (a refused or failed setup).
      cleanup: cleanupRan
        ? { ok: cleanupOk, status: manifest.status, survivors: manifest.survivors.map(redact) }
        : { ok: null, status: 'not-run', survivors: [] },
    };
    mkdirSync(path.dirname(resultPath), { recursive: true, mode: 0o700 });
    const tmp = `${resultPath}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, resultPath);
    return result;
  };

  let exitCode = 0;
  // Starts false: a cleanup that throws must not be reported as ok.
  let cleanupOk = false;
  try {
    walkMode = chooseWalkMode({ base: BASE, env });
    if (walkMode.password !== undefined) password = walkMode.password;
    expect(password, walkMode.mode === 'signin-prod' ? 'COMMONLY_WALK_PROD_PASSWORD is not set' : 'COMMONLY_WALK_PASSWORD is not set');
    if (walkMode.email) email = walkMode.email;
    manifest.mode = walkMode.mode;

    let token = null;
    try {
      if (walkMode.mode === 'signup') {
        await runStep('signup', async () => {
          manifest.username = username;
          writeManifest();
          let r;
          try {
            r = await api('POST', '/api/auth/register', { body: { username, email, password } });
          } catch (caught) {
            accountMayExist = true; // the request may have landed before the failure
            throw caught;
          }
          if (r.status === 201) accountMayExist = true;
          expect(r.status === 201, `register ${r.status}: ${JSON.stringify(r.data)}`);
        });
      }

      token = await runStep('login', async () => {
        const r = await api('POST', '/api/auth/login', { body: { email, password } });
        // Status and error code only: a body could echo the shared email into the log.
        expect(r.status === 200 && r.data?.token, `login ${r.status}${r.data?.code ? ` ${r.data.code}` : ''}`);
        expect(r.data.user?.role !== 'admin', 'walk account is admin; the walk is meaningless');
        manifest.userId = String(r.data.user?._id || r.data.user?.id || '');
        expect(manifest.userId, 'login returned no user id');
        writeManifest();
        return r.data.token;
      });

      // Signup creates a workspace pod. Check it exists before the walk makes its
      // own pod, so a failed signup workspace cannot be hidden by the second pod.
      // Signup-only: on the shared account a workspace pod already exists, and
      // recording it here would make cleanup delete a pod this run did not create.
      if (walkMode.mode === 'signup') await runStep('signup-workspace', async () => {
        const list = await api('GET', '/api/pods', { token });
        const pods = Array.isArray(list.data) ? list.data : (list.data?.pods || []);
        const owned = list.status === 200 ? pods.filter((p) => ownerOf(p) === manifest.userId) : [];
        expect(owned.length > 0, `no signup workspace pod (list ${list.status}, owned ${owned.length})`);
        for (const p of owned) {
          if (!manifest.podIds.includes(String(p._id))) manifest.podIds.push(String(p._id));
        }
        writeManifest();
      });

      const pod = await runStep('first-pod', async () => {
        const podName = `${username} workspace`;
        // An error, or a reply without an id, may still mean the pod was made.
        // Look for it by its unique name before the step can fail, so cleanup
        // removes it, or the name is reported as unresolved.
        const recover = async () => {
          if (!await recoverRunPods({ api, token, userId: manifest.userId, podName, podIds: manifest.podIds })) {
            manifest.unresolvedPodNames.push(podName);
          }
          writeManifest();
        };
        let r;
        try {
          r = await api('POST', '/api/pods', { token, body: { name: podName, type: 'team' } });
        } catch (caught) {
          await recover();
          throw caught;
        }
        const created = r.data?.pod || r.data;
        // Any reply without a created pod may still have committed one, including a
        // 4xx or 5xx, so the outcome is checked by name rather than trusted.
        if (!(r.status < 300 && created?._id)) await recover();
        expect(r.status < 300 && created?._id, `pod create ${r.status}: ${JSON.stringify(r.data)}`);
        manifest.podIds.push(String(created._id));
        writeManifest();
        return created;
      });

      await runStep('hosted-install', async () => {
        manifest.agentName = agentName;
        writeManifest();
        const r = await api('POST', '/api/registry/install', {
          token,
          body: { agentName, podId: pod._id, displayName: agentName, config: { runtime: { runtimeType: 'hosted' } }, scopes: [] },
        });
        expect(r.status < 400, `install ${r.status}: ${JSON.stringify(r.data)}`);
        const p = await api('POST', '/api/hosted/provision', { token, body: { agentName } });
        expect(p.status === 200 && p.data?.provisioned, `provision ${p.status}: ${JSON.stringify(p.data)}`);
      });

      await runStep('hosted-reply', async () => {
        const m = await api('POST', `/api/messages/${pod._id}`, {
          token,
          body: { content: `@${agentName} walk check: reply with one short sentence containing KINGFISHER.` },
        });
        expect(m.status === 200, `mention ${m.status}: ${JSON.stringify(m.data)}`);
        expect((m.data?.agentDelivery?.enqueued ?? 0) >= 1, 'mention was not enqueued to the agent');
        const deadline = now() + HOSTED_REPLY_WAIT_MS;
        while (now() < deadline) {
          const msgs = await api('GET', `/api/messages/${pod._id}`, { token });
          const list = Array.isArray(msgs.data) ? msgs.data : (msgs.data?.messages || []);
          if (list.some((x) => x.username === agentName && /KINGFISHER/i.test(x.content || ''))) return;
          await sleep(3000);
        }
        throw new Error('no agent reply containing KINGFISHER within 120s');
      });

      // API only: this checks the invite preview endpoint. The link is not opened
      // in a browser, so a PASS here does not show that the rendered page loads.
      await runStep('invite-preview-api', async () => {
        const r = await api('POST', `/api/pods/${pod._id}/invites`, { token, body: {} });
        expect(r.status < 300 && r.data?.token, `invite create ${r.status}: ${JSON.stringify(r.data)}`);
        const preview = await api('GET', `/api/invites/${r.data.token}/preview`);
        expect(preview.status === 200, `invite preview ${preview.status}: ${JSON.stringify(preview.data)}`);
      });

      // Recorded, not run: a step that is not covered never counts as a pass.
      results.push({ name: 'byo-connect', result: 'not-covered', ms: 0, reason: NOT_COVERED });
      log(`NOT COVERED byo-connect: ${NOT_COVERED}`);
      exitCode = 2;
    } catch {
      exitCode = 1;
    } finally {
      cleanupRan = true;
      cleanupOk = await cleanup(token);
      if (!cleanupOk) exitCode = 1;
    }
  } catch (caught) {
    // Setup failed before any step ran (for example, no password was given).
    error(`FAIL ${step}: ${redact(caught.message)}`);
    results.push({ name: step, result: 'fail', ms: 0, reason: redact(caught.message) });
    exitCode = 1;
  }

  const result = writeResult(exitCode, cleanupOk);
  log(JSON.stringify({ walk: username, overall: result.overall, steps: results }, null, 2));
  return { exitCode, result };
};

const parseArgs = (argv) => {
  const i = argv.indexOf('--base');
  return i >= 0 ? argv[i + 1] : undefined;
};

// The deployed sha is the one the scheduler names (WALK_SHA). The local checkout's
// HEAD is not the deploy, so a rollback must never target it: no WALK_SHA, no sha.
const shaFromEnv = (env) => env.WALK_SHA || null;

// import.meta.url is the resolved path, so argv[1] is resolved the same way: a
// symlinked path (/tmp on macOS) must still run the walk, not exit 0 silently.
const isEntry = process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntry) {
  const base = parseArgs(process.argv.slice(2)) || process.env.COMMONLY_API_URL || 'https://api.commonly.me';
  runWalk({ base, env: process.env, sha: shaFromEnv(process.env) })
    .then(({ exitCode }) => process.exit(exitCode))
    .catch((caught) => {
      console.error(`FAIL walk: ${caught.message}`);
      process.exit(1);
    });
}
