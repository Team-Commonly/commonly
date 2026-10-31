#!/usr/bin/env node
/**
 * Daily first-user walk (TASK-706, D141). A brand-new non-admin account, as a
 * stranger would meet Commonly: sign up, get a hosted agent reply in the first
 * pod, and invite a person whose link opens. Every step prints pass/fail, its
 * duration, and the first error text. A failure exits 1 and names the step.
 *
 * Walk accounts are recognisable by WALK_PREFIX (`walk-`), which Growth's
 * numbers exclude. Each run deletes its own account at the end, so nothing
 * accumulates. Password comes from COMMONLY_WALK_PASSWORD, never from this file.
 *
 * Usage:
 *   COMMONLY_WALK_PASSWORD=... node scripts/first-user-walk.mjs [--base https://api.commonly.me]
 *
 * Not yet covered: the Bring your own connect step (copy the command, run it
 * under a throwaway HOME, get a live reply). It is reported as NOT COVERED and
 * the run exits 2, so a green run never claims more than it checked.
 */

const WALK_PREFIX = 'walk-';

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const BASE = (flag('base', process.env.COMMONLY_API_URL || 'https://api.commonly.me')).replace(/\/+$/, '');

const now = Date.now();
const stamp = now.toString(36);
const username = `${WALK_PREFIX}${stamp}`;
const email = `${username}@example.invalid`;
const agentName = `${username}-agent`;
const results = [];
let step = 'init';

const api = async (method, path, { token, body } = {}) => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'commonly-walk/first-user',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
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

const cleanup = async (token) => {
  if (!token) return;
  const del = await api('DELETE', '/api/users/me', { token, body: { confirmation: 'DELETE' } });
  if (del.status >= 300) console.error(`cleanup: account delete ${del.status}: ${JSON.stringify(del.data)}`);
  else console.log(`cleanup: deleted ${username}`);
};

const main = async () => {
  const password = process.env.COMMONLY_WALK_PASSWORD;
  if (!password) throw new Error('COMMONLY_WALK_PASSWORD is not set');

  let token = null;
  let exitCode = 0;
  try {
    await runStep('signup', async () => {
      const r = await api('POST', '/api/auth/register', { body: { username, email, password } });
      expect(r.status === 201, `register ${r.status}: ${JSON.stringify(r.data)}`);
    });

    token = await runStep('login', async () => {
      const r = await api('POST', '/api/auth/login', { body: { email, password } });
      expect(r.status === 200 && r.data?.token, `login ${r.status}: ${JSON.stringify(r.data)}`);
      expect(r.data.user?.role !== 'admin', 'walk account is admin; the walk is meaningless');
      return r.data.token;
    });

    const pod = await runStep('first-pod', async () => {
      const r = await api('POST', '/api/pods', { token, body: { name: `${username} workspace`, type: 'team' } });
      const created = r.data?.pod || r.data;
      expect(r.status < 300 && created?._id, `pod create ${r.status}: ${JSON.stringify(r.data)}`);
      return created;
    });

    await runStep('hosted-install', async () => {
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

    await runStep('invite-link', async () => {
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
    await cleanup(token);
  }

  console.log(JSON.stringify({ walk: username, steps: results }, null, 2));
  process.exit(exitCode);
};

main().catch((error) => {
  console.error(`FAIL ${step}: ${error.message}`);
  process.exit(1);
});
