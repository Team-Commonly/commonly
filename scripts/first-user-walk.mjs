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
 * manifest under the state dir, for SRE's admin purge. Password comes from COMMONLY_WALK_PASSWORD, never from this file.
 *
 * Usage:
 *   COMMONLY_WALK_PASSWORD=... node scripts/first-user-walk.mjs [--base https://api.commonly.me]
 *
 * Staging: signup needs a verified email, so SRE's shared walk account is used
 * instead. Set COMMONLY_WALK_EMAIL and COMMONLY_WALK_PASSWORD from env (never a
 * flag default or a file in the repo) and pass the staging API as --base. The
 * run signs in, removes only its own pods, seats and agents, and never deletes
 * that account. A COMMONLY_WALK_EMAIL aimed at any other host is refused.
 *
 * Not yet covered: the Bring your own connect step (copy the command, run it
 * under a throwaway HOME, get a live reply). It is reported as NOT COVERED and
 * the run exits 2, so a green run never claims more than it checked.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { cleanupRun, ownerOf, recoverRunPods } from './first-user-walk-cleanup.mjs';
import { chooseWalkMode } from './first-user-walk-mode.mjs';

const WALK_PREFIX = 'walk-';
// Every request is bounded, cleanup included, so one stalled socket cannot
// hold the run or the report open.
const REQUEST_TIMEOUT_MS = 20_000;

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const BASE = (flag('base', process.env.COMMONLY_API_URL || 'https://api.commonly.me')).replace(/\/+$/, '');

const now = Date.now();
const stamp = now.toString(36);
const username = `${WALK_PREFIX}${stamp}`;
let email = `${username}@example.invalid`;
const agentName = `${username}-agent`;
const results = [];
let step = 'init';
// True once signup may have created the account, so cleanup knows to look for it.
let accountMayExist = false;
// 'signup' makes a fresh account; 'signin' uses the shared staging account and never deletes it.
let walkMode = { mode: 'signup' };

const api = async (method, path, { token, body } = {}) => {
  const res = await fetch(`${BASE}${path}`, {
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
  const started = Date.now();
  try {
    const value = await fn();
    results.push({ name, ok: true, ms: Date.now() - started });
    console.log(`PASS ${name} (${Date.now() - started} ms)`);
    return value;
  } catch (error) {
    results.push({ name, ok: false, ms: Date.now() - started, error: error.message });
    console.error(`FAIL ${name} (${Date.now() - started} ms): ${error.message}`);
    throw error;
  }
};

const expect = (cond, msg) => { if (!cond) throw new Error(msg); };

// Per-run manifest: ids only, outside the repo, for SRE's admin purge of what
// the walk's own token cannot remove (Scout, the hosted agent's User). It holds
// no password, token or email. It is named by the run stamp, not the username.
const STATE_DIR = process.env.COMMONLY_WALK_STATE_DIR || path.join(homedir(), '.commonly', 'state', 'walk-706');
// Signup returns no user id, so the manifest carries the exact username instead:
// SRE finds the account by that name, not by a prefix. Never the email.
const manifest = { mode: null, userId: null, username: null, podIds: [], unresolvedPodNames: [], agentName: null, botIds: [], survivors: [], status: 'running' };
// A pod whose create outcome could not be checked. Its name is unique to the run,
// so SRE can find it by exact name, the same way as the account.
const unresolvedSurvivors = () => manifest.unresolvedPodNames.map((name) => `pod named "${name}" (create outcome unknown)`);
const writeManifest = () => {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(STATE_DIR, `${stamp}.json`), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
};

// Returns false when anything survives, so the run fails loudly. Signup can
// create the account before the walk has a token, so cleanup signs in once
// more; if that fails the account is a survivor, not a silent gap.
const cleanup = async (token, password) => {
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
    if (manifest.survivors.length) console.error(`cleanup: ${username} survives; sign-in failed`);
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
  } catch (error) {
    manifest.survivors = [`cleanup error: ${error.message}`, ...unresolvedSurvivors()];
    manifest.status = 'needs-admin-purge';
  }
  writeManifest();
  if (manifest.status === 'clean') console.log(`cleanup: removed ${username}`);
  else console.error(`cleanup: survivors: ${manifest.survivors.join('; ')}`);
  return manifest.status === 'clean';
};

const main = async () => {
  const password = process.env.COMMONLY_WALK_PASSWORD;
  if (!password) throw new Error('COMMONLY_WALK_PASSWORD is not set');
  walkMode = chooseWalkMode({ base: BASE, env: process.env });
  if (walkMode.mode === 'signin') email = walkMode.email;
  manifest.mode = walkMode.mode;

  let token = null;
  let exitCode = 0;
  try {
    if (walkMode.mode === 'signup') {
      await runStep('signup', async () => {
        manifest.username = username;
        writeManifest();
        let r;
        try {
          r = await api('POST', '/api/auth/register', { body: { username, email, password } });
        } catch (error) {
          accountMayExist = true; // the request may have landed before the failure
          throw error;
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
      } catch (error) {
        await recover();
        throw error;
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
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline) {
        const msgs = await api('GET', `/api/messages/${pod._id}`, { token });
        const list = Array.isArray(msgs.data) ? msgs.data : (msgs.data?.messages || []);
        if (list.some((x) => x.username === agentName && /KINGFISHER/i.test(x.content || ''))) return;
        await new Promise((resolve) => { setTimeout(resolve, 3000); });
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

    await runStep('byo-connect', async () => {
      throw new Error('NOT COVERED: Bring your own connect step is not implemented yet');
    }).catch(() => { exitCode = 2; });
  } catch {
    exitCode = 1;
  } finally {
    if (!await cleanup(token, password)) exitCode = 1;
  }

  console.log(JSON.stringify({ walk: username, steps: results }, null, 2));
  process.exit(exitCode);
};

main().catch((error) => {
  console.error(`FAIL ${step}: ${error.message}`);
  process.exit(1);
});
