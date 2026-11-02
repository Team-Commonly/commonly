#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Guard-name canary: after a deploy, agents whose names complete one of the
 * injection guard's keywords each get one real turn on production.
 *
 * Why. On 2026-11-01 a hosted agent whose name began with "Dan" was blocked on
 * every turn. Its system prompt opened "You are Dan…", which contains the
 * guard's always-block keyword "you are dan". Staging has no model key, so
 * staging-smoke never runs a turn through LiteLLM, and no test agent's name
 * ever came near a keyword.
 *
 * What it does, once per run:
 *   1. keywords  reads the guard's always-block keywords from
 *                CANARY_GUARD_KEYWORDS, the JSON that
 *                scripts/guard-keywords-dump.py prints from the litellm pod. A
 *                keyword the guard adds later is covered on the next deploy.
 *   2. names     each persona keyword ("you are DAN", "act as DAN", "you are
 *                now") gives a name that completes it: "Dan Canary", "Now
 *                Canary". "Dan Canary" is always tried, list or no list.
 *   3. setup     ensures the canary account (eng-guard-canary, on
 *                ops.commonly.invalid, cloudAgents entitled, no usable
 *                password) and its pod. It signs a 20-minute session for it
 *                here, from JWT_SECRET; no token is stored anywhere.
 *   4. checks    for each name, a hosted agent and a native one (task-clerk)
 *                are installed under that name through the same routes the
 *                product uses, asked a plain question, and judged: a mention
 *                turn that succeeded, a reply from the agent after the
 *                question, and no guard-blocked run since install. Each is
 *                uninstalled afterwards, pass or fail.
 *
 * It waits for LiteLLM to report ready before the first check, and runs an
 * inconclusive check once more: a restart window must not read as a red.
 *
 * Exit: 0 every check passed · 1 a run was stopped by the guard (the release
 * must not stand) · 2 inconclusive (no verdict: an install failed, nothing
 * replied in time, or the keyword list was unreadable). Every step prints one
 * JSON line; the last is {canary, result, exit}.
 *
 * Run it in ops-runner, never in the serving backend:
 *   KW=$(kubectl exec -i -n NS deploy/litellm -c litellm -- /app/.venv/bin/python3 -I - < scripts/guard-keywords-dump.py)
 *   kubectl exec -i -n NS deploy/ops-runner -c ops-runner -- env NODE_PATH=/app/node_modules \
 *     CANARY_RUN=1 CANARY_GUARD_KEYWORDS="$KW" node - < scripts/guard-name-canary.js
 * Runbook: docs/runbooks/guard-name-canary.md.
 */

const CANARY = 'guard-name';
const CANARY_USERNAME = 'eng-guard-canary';
const CANARY_EMAIL_DOMAIN = 'ops.commonly.invalid';
const CANARY_POD_NAME = 'Guard-name canary';
const HOSTED_AGENT = 'guard-canary';
// A seeded first-party native app that answers mentions (config/native-agents).
const NATIVE_AGENT = 'task-clerk';
// The name that broke on 2026-11-01. Tried even when the list can't be read.
const FLOOR_STEMS = ['dan'];
// Text our prompts could put right before an agent's name. A keyword that
// starts with one of these is completed by a name that starts with the rest.
const PERSONA_LEADS = [
  'you are', "you're", 'act as', 'acting as', 'pretend to be', 'pretend you are',
  'roleplay as', 'role-play as', 'role play as', 'behave as', 'respond as', 'speak as',
  'your name is', 'you will be', 'you will now be',
];
const MAX_STEM_WORDS = 3;
const MAX_NAME_CHARS = 60;
// The keyword list must not decide how many turns a release pays for. A name
// past the cap is reported, and the run reads as inconclusive.
const MAX_NAMES = 8;

// ── pure parts (tested in backend/__tests__/unit/scripts/guardNameCanary.test.js) ──

/** The dump's JSON, flattened to one lowercased list; ok:false when unreadable. */
function parseKeywordPayload(raw) {
  let data;
  try {
    data = JSON.parse(String(raw || ''));
  } catch (err) {
    return { ok: false, keywords: [], categories: [], error: raw ? 'unparseable' : 'empty' };
  }
  if (!data || typeof data !== 'object' || data.error || !data.categories || typeof data.categories !== 'object') {
    return { ok: false, keywords: [], categories: [], error: String((data && data.error) || 'no categories').slice(0, 200) };
  }
  const categories = Object.keys(data.categories);
  const seen = new Set();
  const keywords = [];
  for (const category of categories) {
    for (const keyword of data.categories[category] || []) {
      const k = String(keyword || '').trim().toLowerCase();
      if (k && !seen.has(k)) { seen.add(k); keywords.push(k); }
    }
  }
  if (!keywords.length) return { ok: false, keywords: [], categories, error: 'no keywords' };
  return { ok: true, keywords, categories };
}

/** The first keyword the text contains, case-insensitively, or null. */
function findKeyword(text, keywords) {
  const haystack = String(text || '').toLowerCase();
  for (const k of keywords) {
    if (k && haystack.includes(String(k).toLowerCase())) return String(k).toLowerCase();
  }
  return null;
}

const titleCase = (stem) => stem.split(/\s+/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
const slug = (text) => text.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '');

/**
 * One canary name per stem: the floor stems first, then each persona keyword's
 * tail in list order. A name that itself contains a whole keyword is skipped:
 * a person @-mentioning it would type that keyword, and that block is the
 * guard doing its job, not our text tripping it.
 */
function deriveCanaryNames(keywords) {
  const byStem = new Map();
  const skipped = [];
  const add = (stem, keyword) => {
    if (!byStem.has(stem)) byStem.set(stem, []);
    if (keyword && !byStem.get(stem).includes(keyword)) byStem.get(stem).push(keyword);
  };
  for (const stem of FLOOR_STEMS) add(stem, null);
  for (const keyword of keywords) {
    const lead = PERSONA_LEADS.find((l) => keyword.startsWith(`${l} `));
    if (!lead) continue;
    const stem = keyword.slice(lead.length).trim().replace(/\s+/g, ' ');
    if (!stem) continue;
    if (stem.split(' ').length > MAX_STEM_WORDS) {
      skipped.push({ stem, keyword, reason: 'stem_too_long' });
      continue;
    }
    const displayName = `${titleCase(stem)} Canary`;
    if (displayName.length > MAX_NAME_CHARS) {
      skipped.push({ stem: stem.slice(0, 40), keyword: keyword.slice(0, 80), reason: 'name_too_long' });
      continue;
    }
    if (findKeyword(displayName, keywords)) {
      skipped.push({ stem, keyword, reason: 'name_contains_keyword' });
      continue;
    }
    if (!byStem.has(stem) && byStem.size >= MAX_NAMES) {
      skipped.push({ stem, keyword, reason: 'over_cap' });
      continue;
    }
    add(stem, keyword);
  }
  const names = [...byStem.entries()].map(([stem, kws]) => {
    const displayName = `${titleCase(stem)} Canary`;
    return { stem, displayName, instanceId: slug(displayName), keywords: kws };
  });
  return { names, skipped };
}

/**
 * What the canary account posts: a plain question that carries no keyword, so
 * the guard has no reason of its own to stop it. Not "repeat this code": the
 * first live run asked for that, and every model declined it as a relay request.
 */
function mentionText(handle) {
  return `@${handle} quick check from the release canary: what is 2 + 3? One short sentence is plenty.`;
}

/** One check's verdict from what happened since its install. */
function classifyCheck({ installError, runs, replied }) {
  if (installError) return { verdict: 'inconclusive', reason: `install: ${installError}` };
  const blocked = (runs || []).find((r) => r && r.errorKind === 'guardrail_blocked');
  if (blocked) return { verdict: 'blocked', reason: `guardrail_blocked on ${blocked.trigger || 'unknown'}` };
  if (!runs || !runs.length) return { verdict: 'inconclusive', reason: 'no_run' };
  const failed = runs.find((r) => r && r.status === 'failed');
  if (failed) return { verdict: 'inconclusive', reason: `run failed: ${failed.errorKind || 'unknown'}` };
  if (!replied) return { verdict: 'inconclusive', reason: 'no_reply' };
  // The greeting can post after the question; only the mention's own turn counts.
  if (!runs.some((r) => r && r.trigger === 'mention' && r.status === 'succeeded')) {
    return { verdict: 'inconclusive', reason: 'no_mention_run' };
  }
  return { verdict: 'pass' };
}

/**
 * 1 if any check was blocked; 2 if no checks ran, any was inconclusive, the
 * list was unread, or names past the cap went untried; else 0.
 */
function exitCodeFor(results, keywordsRead, capped = false) {
  if (results.some((r) => r.verdict === 'blocked')) return 1;
  if (!results.length || results.some((r) => r.verdict !== 'pass') || !keywordsRead || capped) return 2;
  return 0;
}

module.exports = {
  parseKeywordPayload, findKeyword, deriveCanaryNames, mentionText, classifyCheck, exitCodeFor,
};

// ── the run (only with CANARY_RUN=1, in ops-runner) ─────────────────────────

const log = (fields) => console.log(JSON.stringify({ canary: CANARY, ...fields }));
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

async function waitForLitellm(deadlineMs) {
  const base = process.env.LITELLM_BASE_URL;
  if (!base) return { ok: false, reason: 'LITELLM_BASE_URL unset' };
  const url = `${new URL(base).origin}/health/readiness`;
  const t0 = Date.now();
  let last = '';
  while (Date.now() - t0 < deadlineMs) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (res.ok) return { ok: true, ms: Date.now() - t0 };
      last = `HTTP ${res.status}`;
    } catch (err) {
      last = String(err.message || err).slice(0, 80);
    }
    await sleep(3000);
  }
  return { ok: false, reason: last || 'timeout', ms: Date.now() - t0 };
}

async function main() {
  const crypto = require('crypto');
  const mongoose = require('mongoose');
  const jwt = require('jsonwebtoken');
  const bcrypt = require('bcryptjs');

  const API = String(process.env.CANARY_API_URL || process.env.COMMONLY_API_URL || 'http://backend:5000').replace(/\/+$/, '');
  const CHECK_BUDGET_MS = Number(process.env.CANARY_CHECK_BUDGET_MS) || 120_000;
  const started = Date.now();

  const kw = parseKeywordPayload(process.env.CANARY_GUARD_KEYWORDS);
  log({ step: 'keywords', ok: kw.ok, count: kw.keywords.length, categories: kw.categories, ...(kw.ok ? {} : { error: kw.error }) });
  const { names, skipped } = deriveCanaryNames(kw.keywords);
  log({ step: 'names', names: names.map((n) => ({ name: n.displayName, keywords: n.keywords })), skipped });

  await mongoose.connect(process.env.MONGO_URI);
  const db = mongoose.connection.db;

  // The canary account. It has no usable password (a hash of a random secret
  // that is dropped here) and is reached only through the session signed below.
  const users = db.collection('users');
  const now = new Date();
  await users.updateOne({ username: CANARY_USERNAME }, {
    $setOnInsert: {
      username: CANARY_USERNAME,
      email: `${CANARY_USERNAME}@${CANARY_EMAIL_DOMAIN}`,
      password: bcrypt.hashSync(crypto.randomBytes(32).toString('hex'), 10),
      verified: true,
      isBot: false,
      role: 'user',
      tokenVersion: 0,
      entitlements: { cloudAgents: true },
      createdAt: now,
      updatedAt: now,
    },
  }, { upsert: true });
  const account = await users.findOne(
    { username: CANARY_USERNAME },
    { projection: { _id: 1, tokenVersion: 1, isBot: 1, entitlements: 1 } },
  );
  if (!account || account.isBot || !(account.entitlements && account.entitlements.cloudAgents === true)) {
    log({ step: 'account', ok: false, error: 'canary account missing, a bot, or not cloudAgents-entitled' });
    log({ result: 'inconclusive', exit: 2 });
    await mongoose.disconnect();
    return 2;
  }
  const token = jwt.sign(
    { id: String(account._id), tokenVersion: account.tokenVersion || 0 },
    process.env.JWT_SECRET,
    { expiresIn: '20m' },
  );
  log({ step: 'account', ok: true });

  const api = async (method, path, body) => {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'commonly-guard-canary/1.0',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    let data = text;
    try { data = JSON.parse(text); } catch (err) { /* not JSON */ }
    if (!res.ok) {
      const detail = data && typeof data === 'object' ? (data.code || data.error || data.msg || '') : '';
      throw new Error(`HTTP ${res.status} ${String(detail).slice(0, 80)}`.trim());
    }
    return data;
  };

  // The canary's pod, reused across runs.
  const podsRes = await api('GET', '/api/pods');
  const pods = Array.isArray(podsRes) ? podsRes : (podsRes && podsRes.pods) || [];
  let pod = pods.find((p) => p && p.name === CANARY_POD_NAME);
  if (!pod) {
    pod = await api('POST', '/api/pods', {
      name: CANARY_POD_NAME,
      type: 'chat',
      // Invite-only: a stranger in this pod could @-mention a canary agent
      // with a keyword and fail the release (security review, this PR).
      joinPolicy: 'invite-only',
      description: 'Release check: agents named after guard keywords each get one real turn.',
    });
  }
  const podId = String(pod._id || pod.id);
  // Only the canary account may be a human in this pod. A pod someone else can
  // reach, or did reach, yields no verdict: their message could be what the
  // guard stops.
  const podRow = await db.collection('pods').findOne(
    { _id: new mongoose.Types.ObjectId(podId) },
    { projection: { joinPolicy: 1, members: 1 } },
  );
  const otherHumans = podRow ? await users.countDocuments({
    _id: { $in: (podRow.members || []).filter((m) => String(m) !== String(account._id)) },
    isBot: { $ne: true },
  }) : -1;
  if (!podRow || podRow.joinPolicy !== 'invite-only' || otherHumans !== 0) {
    log({ step: 'pod', ok: false, podId, joinPolicy: podRow ? podRow.joinPolicy || null : null, otherHumans });
    log({ result: 'inconclusive', exit: 2 });
    await mongoose.disconnect();
    return 2;
  }
  log({ step: 'pod', ok: true, podId });

  const uninstall = async (agentName, instanceId) => {
    try {
      await api('DELETE', `/api/registry/agents/${encodeURIComponent(agentName)}/pods/${podId}?instanceId=${encodeURIComponent(instanceId)}`);
      return true;
    } catch (err) {
      log({ step: 'uninstall', ok: false, agentName, instanceId, error: err.message });
      return false;
    }
  };

  // A run that died before its cleanup leaves an install behind, and the
  // hosted cap is one per account. Only the canary's own two agents are touched.
  try {
    const roster = await api('GET', `/api/registry/pods/${podId}/agents`);
    for (const a of (roster && roster.agents) || []) {
      if (a && (a.name === HOSTED_AGENT || a.name === NATIVE_AGENT)) {
        const removed = await uninstall(a.name, a.instanceId || 'default');
        log({ step: 'sweep', agentName: a.name, instanceId: a.instanceId || 'default', removed });
      }
    }
  } catch (err) {
    log({ step: 'sweep', ok: false, error: err.message });
  }

  const ready = await waitForLitellm(120_000);
  log({ step: 'litellm-ready', ...ready });

  const checkOnce = async (runtimeType, name) => {
    const agentName = runtimeType === 'hosted' ? HOSTED_AGENT : NATIVE_AGENT;
    const handle = `${agentName}-${name.instanceId}`;
    const since = new Date(Date.now() - 5000);
    const t0 = Date.now();
    let installError = null;
    let replied = false;
    let runs = [];
    try {
      try {
        await api('POST', '/api/registry/install', {
          agentName,
          podId,
          displayName: name.displayName,
          instanceId: name.instanceId,
          scopes: [],
          config: { runtime: { runtimeType } },
        });
        if (runtimeType === 'hosted') {
          await api('POST', '/api/hosted/provision', { agentName, instanceId: name.instanceId });
        }
      } catch (err) {
        installError = err.message;
      }
      // The agent's own user row, by the canonical handle install gives it.
      // Messages are matched on its id: the list route returns `userId` as an
      // object only when it can join a username, so the first live run's
      // username match missed every reply.
      const bot = installError ? null : await users.findOne({ username: handle }, { projection: { _id: 1 } });
      if (!installError && !bot) installError = 'no agent user';
      if (!installError) {
        const botId = String(bot._id);
        const asked = await api('POST', `/api/messages/${podId}`, { content: mentionText(handle) });
        const askedAt = new Date((asked && asked.createdAt) || Date.now()).getTime();
        while (Date.now() - t0 < CHECK_BUDGET_MS) {
          await sleep(3000);
          runs = await db.collection('agentruns').find(
            {
              podId: new mongoose.Types.ObjectId(podId), agentName, instanceId: name.instanceId, startedAt: { $gte: since },
            },
            { projection: { _id: 0, status: 1, errorKind: 1, trigger: 1 } },
          ).toArray();
          if (runs.some((r) => r.errorKind === 'guardrail_blocked')) break;
          const messages = await api('GET', `/api/messages/${podId}?limit=30`);
          replied = (Array.isArray(messages) ? messages : []).some((m) => {
            const author = m && (typeof m.userId === 'object' && m.userId ? m.userId._id : (m.user_id || m.userId));
            return String(author || '') === botId && new Date(m.createdAt).getTime() > askedAt;
          });
          const mentionDone = runs.some((r) => r.trigger === 'mention' && ['succeeded', 'failed', 'interrupted'].includes(r.status));
          if (replied && mentionDone) break;
        }
      }
    } catch (err) {
      installError = installError || `check: ${err.message}`;
    } finally {
      await uninstall(agentName, name.instanceId);
    }
    return { ...classifyCheck({ installError, runs, replied }), ms: Date.now() - t0 };
  };

  const results = [];
  for (const name of names) {
    // The hosted cap is one per account, so names run one after another; the
    // native check for the same name runs beside the hosted one.
    const pair = await Promise.all(['hosted', 'native'].map(async (runtimeType) => {
      let outcome = await checkOnce(runtimeType, name);
      let attempts = 1;
      if (outcome.verdict === 'inconclusive') {
        // One retry, after LiteLLM reports ready again: a restart window or a
        // slow model must not stall a release.
        await waitForLitellm(60_000);
        outcome = await checkOnce(runtimeType, name);
        attempts = 2;
      }
      const result = { step: 'check', runtime: runtimeType, name: name.displayName, keywords: name.keywords, attempts, ...outcome };
      log(result);
      return result;
    }));
    results.push(...pair);
  }

  const code = exitCodeFor(results, kw.ok, skipped.some((x) => x.reason === 'over_cap'));
  log({ result: code === 0 ? 'pass' : code === 1 ? 'blocked' : 'inconclusive', exit: code, checks: results.length, ms: Date.now() - started });
  await mongoose.disconnect();
  return code;
}

if (process.env.CANARY_RUN === '1') {
  main().then((code) => process.exit(code)).catch((err) => {
    // Name and code only: a driver error can quote its connection string.
    log({ result: 'inconclusive', exit: 2, error: String((err && err.name) || 'Error'), code: (err && err.code) || null });
    process.exit(2);
  });
}
