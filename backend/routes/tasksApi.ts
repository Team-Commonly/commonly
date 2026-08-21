import { createHash } from 'crypto';
import type { Request, Response } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
// eslint-disable-next-line global-require
const express = require('express');
// eslint-disable-next-line global-require
const mongoose = require('mongoose');
// eslint-disable-next-line global-require
const regularAuth = require('../middleware/auth');
// eslint-disable-next-line global-require
const agentRuntimeAuth = require('../middleware/agentRuntimeAuth');
// eslint-disable-next-line global-require
const Pod = require('../models/Pod');
// eslint-disable-next-line global-require
const Task = require('../models/Task');
// eslint-disable-next-line global-require
const User = require('../models/User');
// eslint-disable-next-line global-require
const GitHubAppService = require('../services/githubAppService');
// eslint-disable-next-line global-require
const { emitTaskUpdated, notifyPodAgents } = require('../services/taskEventService');

/**
 * Who made this board change, for the agent fan-out.
 *
 * `isAgent` prices the wake against the cascade cap, so it is derived from the
 * auth shape rather than guessed: `agentRuntimeAuth` sets `req.agentUser` and
 * never `req.user`. Returned explicitly as `false` for humans because
 * `notifyPodAgents` treats *undefined* as "assume agent" — the safe default
 * there, and not one to trip over by accident here.
 */
const actorOf = (req: any) => {
  const isAgent = Boolean(req.agentUser?._id || req.user?.isBot);
  // Identity, not just a user id. The self-skip downstream keys on
  // (agentName, instanceId) because `installedBy` means the agent on a
  // self-install and the HUMAN on a human-install — supplying only userId let a
  // human-installed agent fail to match its own install and wake itself.
  // Both auth shapes carry the same metadata: agentRuntimeAuth sets
  // `req.agentUser`, the dual-auth path leaves the bot on `req.user`.
  const meta = req.agentUser?.botMetadata || req.user?.botMetadata || {};
  return {
    userId: req.userId || req.user?._id || req.user?.id || req.agentUser?._id,
    isAgent,
    agentName: isAgent ? (meta.agentName || undefined) : undefined,
    instanceId: isAgent ? (meta.instanceId || 'default') : undefined,
  };
};

/**
 * Board change -> pod agents. Deliberately NOT folded into `emitTaskUpdated`:
 * that is a synchronous best-effort socket emit, this is an async DB fan-out.
 *
 * try/catch AND .catch, deliberately. A promise `.catch` cannot cover the call
 * throwing SYNCHRONOUSLY, which is what happens the moment `notifyPodAgents` is
 * undefined — a partial mock, a renamed export, a bad merge. That threw through
 * into the route and turned every board write into a 500: strictly worse than
 * the silent fan-out this exists to fix.
 */
const notifyAgents = (req: any, podId: unknown, task: unknown, kind: string) => {
  try {
    const pending = notifyPodAgents(podId, task, kind, actorOf(req));
    if (pending?.catch) {
      pending.catch((e: Error) => console.warn('[tasks] agent notify failed:', e.message));
    }
  } catch (e) {
    console.warn('[tasks] agent notify threw:', (e as Error).message);
  }
};

interface AuthReq {
  userId?: string;
  user?: { id?: string; _id?: unknown; isBot?: boolean; botMetadata?: { instanceId?: string; agentName?: string } };
  agentUser?: { _id?: unknown };
  params?: Record<string, string>;
  query?: Record<string, string>;
  body?: Record<string, unknown>;
  header?: (name: string) => string | undefined;
}
interface Res {
  status: (n: number) => Res;
  json: (d: unknown) => void;
}

function auth(req: AuthReq, res: Res, next: () => void) {
  const token = ((req.header?.('Authorization') || '').replace('Bearer ', ''));
  if (token.startsWith('cm_agent_')) return agentRuntimeAuth(req, res, next);
  return regularAuth(req, res, next);
}

const router: ReturnType<typeof express.Router> = express.Router();

const taskWriteRateLimitKey = (req: Request): string => {
  const authHeader = req.get('Authorization') || req.get('x-auth-token');
  if (authHeader) {
    return `tok:${createHash('sha256').update(authHeader).digest('hex').slice(0, 16)}`;
  }
  return req.ip ? ipKeyGenerator(req.ip) : 'anon';
};

// Create and claim were limited; complete, updates and patch were not, though
// all five write to Mongo behind the same auth. CodeQL surfaced only the one
// this PR happened to touch (`js/missing-rate-limiting` on the complete
// handler) — fixing that line alone would have left two siblings open for the
// next diff to rediscover. Same key function as the others, so a caller's
// budget is per-token rather than per-IP.
const taskWriteRateLimit = (max: number) => rateLimit({
  windowMs: 60_000,
  max,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: taskWriteRateLimitKey,
  handler: (_req: Request, res: Response) => res.status(429).json({
    error: `rate limit exceeded: ${max} task writes per 60s`,
  }),
});

async function resolveAuthor(req: AuthReq): Promise<string> {
  const agentInstance = req.user?.isBot ? (req.user.botMetadata?.instanceId || req.user.botMetadata?.agentName) : null;
  if (agentInstance) return agentInstance;
  const userId = req.userId || req.user?._id || req.user?.id || req.agentUser?._id;
  if (userId) {
    const u = await User.findById(userId).select('username').lean() as { username?: string } | null;
    if (u?.username) return u.username;
  }
  return 'unknown';
}

function resolveAgentInstanceId(req: AuthReq): string | null {
  if (!req.user?.isBot) return null;
  return req.user.botMetadata?.instanceId || req.user.botMetadata?.agentName || null;
}

async function requirePodMember(podId: string, userId: unknown, { write = false } = {}): Promise<{ error?: string; status?: number; pod?: unknown }> {
  const pod = await Pod.findById(podId).lean() as { type?: string; members?: Array<{ userId?: { toString: () => string }; toString: () => string; role?: string }> } | null;
  if (!pod) return { error: 'Pod not found', status: 404 };
  const membership = pod.members?.find((m) => {
    if (!m) return false;
    const id = m.userId ? m.userId.toString() : m.toString();
    return id === (userId as { toString: () => string }).toString();
  });
  // Read access on agent-dm pods follows §3.7 (shared-pod readers
  // allowed). Write access stays member-only — non-members can observe
  // but not post tasks into someone else's bot-bot DM. The viewer-role
  // gate below applies to writes regardless.
  if (!membership) {
    if (write) return { error: 'Write access denied', status: 403 };
    // eslint-disable-next-line global-require
    const DMService = require('../services/dmService');
    const canView = await DMService.canViewPod(userId, pod);
    if (!canView) return { error: 'Access denied', status: 403 };
    return { pod };
  }
  if (write && (membership as { role?: string }).role === 'viewer') return { error: 'Write access denied', status: 403 };
  return { pod };
}

async function nextTaskId(podId: string): Promise<{ taskId: string; taskNum: number }> {
  const last = await Task.findOne({ podId, taskId: { $exists: true } }).sort({ taskId: -1 }).select('taskId').lean() as { taskId?: string } | null;
  const lastNum = last ? parseInt((last.taskId || '').replace('TASK-', ''), 10) : 0;
  const num = lastNum + 1;
  return { taskId: `TASK-${String(num).padStart(3, '0')}`, taskNum: num };
}

router.get('/:podId', auth, async (req: AuthReq, res: Res) => {
  try {
    const { podId } = req.params || {};
    const userId = req.userId || req.user?._id || req.agentUser?._id;
    // Coerced at the boundary rather than destructured. Express's extended
    // query parser turns `?assignee[$ne]=x` into an OBJECT and `?status=a&status=b`
    // into an ARRAY, and both used to flow straight into the Mongo query below:
    // the first as an operator injection, the second as a silent switch from
    // String.includes to Array.includes, where `status.includes(',')` stops
    // meaning what it reads as. Anything that is not a string is dropped.
    const assignee = typeof req.query?.assignee === 'string' ? req.query.assignee : undefined;
    const status = typeof req.query?.status === 'string' ? req.query.status : undefined;
    // Deliberately absent from the MCP tool schema, and NOT an oversight to
    // close. Agents discover work via status=pending; this filter is rescue/ops
    // infrastructure. Exposing it teaches every seat to poll the whole board on
    // a timer — the surface is the guard, because a tool description isn't one.
    const claimable = req.query?.claimable === 'true';
    const access = await requirePodMember(podId || '', userId);
    if (access.error) return res.status(access.status || 500).json({ error: access.error });
    const query: Record<string, unknown> = { podId: mongoose.Types.ObjectId.createFromHexString(podId || '') };
    if (assignee) query.assignee = assignee;
    if (status) query.status = status.includes(',') ? { $in: status.split(',') } : status;
    // Composes with `status` by AND rather than overriding it, so
    // ?status=claimed&claimable=true asks the useful narrow question — show me
    // the lapsed claims specifically — while ?claimable=true alone answers
    // "what can this pod's agents pick up right now", lapsed leases included.
    if (claimable) query.$or = claimableConditions(new Date());
    const tasks = await Task.find(query).sort({ taskNum: 1 }).lean();
    // One `now` for the whole page: derived per row, two rows either side of a
    // tick boundary could otherwise report lease states that never coexisted.
    const now = new Date();
    return res.json({
      tasks: tasks.map((task: Record<string, unknown>) => ({ ...task, leaseState: deriveLeaseState(task, now) })),
    });
  } catch (err) {
    console.error('GET /tasks error:', err);
    return res.status(500).json({ error: 'Failed to list tasks' });
  }
});

router.post('/:podId', rateLimit({
  windowMs: 60_000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: taskWriteRateLimitKey,
  handler: (_req: Request, res: Response) => res.status(429).json({ error: 'rate limit exceeded: 20 task creates per 60s' }),
}), auth, async (req: AuthReq, res: Res) => {
  try {
    const { podId } = req.params || {};
    const userId = req.userId || req.user?._id || req.agentUser?._id;
    const {
      title: titleInput,
      assignee: assigneeInput,
      dep: depInput,
      depMockOk: depMockOkInput,
      parentTask: parentTaskInput,
      source: sourceInput,
      sourceRef: sourceRefInput,
      githubIssueNumber: githubIssueNumberInput,
      githubIssueUrl: githubIssueUrlInput,
      createGithubIssue: createGithubIssueInput,
    } = req.body || {};
    const stringInputs: Record<string, unknown> = {
      title: titleInput,
      assignee: assigneeInput,
      dep: depInput,
      parentTask: parentTaskInput,
      source: sourceInput,
      sourceRef: sourceRefInput,
      githubIssueUrl: githubIssueUrlInput,
    };
    const invalidStringField = Object.entries(stringInputs)
      .find(([, value]) => value !== undefined && typeof value !== 'string');
    if (invalidStringField) {
      return res.status(400).json({ error: `${invalidStringField[0]} must be a string` });
    }
    if (githubIssueNumberInput !== undefined
      && (typeof githubIssueNumberInput !== 'number'
        || !Number.isSafeInteger(githubIssueNumberInput)
        || githubIssueNumberInput < 1)) {
      return res.status(400).json({ error: 'githubIssueNumber must be a positive integer' });
    }
    if (depMockOkInput !== undefined && typeof depMockOkInput !== 'boolean') {
      return res.status(400).json({ error: 'depMockOk must be a boolean' });
    }
    if (createGithubIssueInput !== undefined && typeof createGithubIssueInput !== 'boolean') {
      return res.status(400).json({ error: 'createGithubIssue must be a boolean' });
    }
    // Materialize primitives after runtime validation so Mongo never receives
    // user-supplied query objects (for example, operator-shaped values).
    const title = titleInput === undefined ? undefined : String(titleInput);
    const assignee = assigneeInput === undefined ? undefined : String(assigneeInput);
    const dep = depInput === undefined ? undefined : String(depInput);
    const parentTask = parentTaskInput === undefined ? undefined : String(parentTaskInput);
    const source = sourceInput === undefined ? undefined : String(sourceInput);
    const sourceRef = sourceRefInput === undefined ? undefined : String(sourceRefInput);
    const githubIssueUrl = githubIssueUrlInput === undefined ? undefined : String(githubIssueUrlInput);
    const githubIssueNumber = githubIssueNumberInput === undefined ? undefined : Number(githubIssueNumberInput);
    const depMockOk = depMockOkInput === true;
    const createGithubIssue = createGithubIssueInput === true;
    if (!title) return res.status(400).json({ error: 'title is required' });
    const access = await requirePodMember(podId || '', userId, { write: true });
    if (access.error) return res.status(access.status || 500).json({ error: access.error });
    if (sourceRef) {
      const existing = await Task.findOne({ podId: mongoose.Types.ObjectId.createFromHexString(podId || ''), sourceRef }) as { status?: string; assignee?: string; claimedAt?: Date | null; claimExpiresAt?: Date | null; notes?: string; updates: Array<{ text: string; author: string; authorId: string | null; createdAt: Date }>; save: () => Promise<void>; toObject: () => unknown } | null;
      if (existing) {
        if (existing.status === 'done') {
          existing.status = 'pending';
          existing.assignee = assignee || undefined;
          existing.claimedAt = null;
          existing.claimExpiresAt = null;
          existing.notes = 'Reopened — previously completed but issue is still open.';
          existing.updates.push({ text: 'Reopened: task was done but linked issue is still open — picking up again.', author: 'system', authorId: null, createdAt: new Date() });
          await existing.save();
          const reopenedObj = existing.toObject();
          emitTaskUpdated(podId, reopenedObj, 'updated');
          notifyAgents(req, podId, reopenedObj, 'updated');
          return res.json({ task: reopenedObj, alreadyExists: false, reopened: true });
        }
        return res.json({ task: existing.toObject(), alreadyExists: true });
      }
    }
    let ghNumber = githubIssueNumber || null;
    let ghUrl = githubIssueUrl || null;
    // Provenance, not decoration. `githubIssueNumber` arrives from the caller
    // and is validated only as a positive integer — it can name ANY issue in
    // the repo. Only an issue this server opened may later be written to.
    let ghOwned = false;
    if (createGithubIssue && title && GitHubAppService.isPatConfigured()) {
      try {
        const bodyParts: string[] = [];
        if (assignee) bodyParts.push(`Assigned to: ${assignee}`);
        if (parentTask) bodyParts.push(`Parent task: ${parentTask}`);
        if (dep) bodyParts.push(`Blocked by: ${dep}`);
        const issue = await GitHubAppService.createIssue({ title, body: bodyParts.join('\n') || undefined }) as { number: number; html_url: string };
        ghNumber = issue.number;
        ghUrl = issue.html_url;
        ghOwned = true;
      } catch (ghErr) {
        console.warn('createGithubIssue failed (non-fatal):', (ghErr as Error).message);
      }
    }
    const author = await resolveAuthor(req);
    const { taskId, taskNum } = await nextTaskId(podId || '');
    const initUpdate: { text: string; author: string; authorId: string | null; createdAt: Date } = { text: `Created by ${author}`, author, authorId: userId?.toString() || null, createdAt: new Date() };
    if (assignee) initUpdate.text = `Created by ${author} · assigned to ${assignee}`;
    if (sourceRef) initUpdate.text = `Created by ${author} from ${sourceRef}${assignee ? ` · assigned to ${assignee}` : ''}`;
    if (ghNumber) initUpdate.text += ` · GH#${ghNumber}`;
    if (parentTask) initUpdate.text += ` · sub-task of ${parentTask}`;
    // `source` is provenance for task creation, so an agent-authenticated
    // caller may not self-identify as human (or any other source) through
    // the request body. Human callers retain the existing source override
    // for GitHub/import workflows.
    const taskSource = req.agentUser?._id
      ? 'agent'
      : source || (ghNumber ? 'github' : 'human');
    let task;
    try {
      task = await Task.create({ podId, taskNum, taskId, title, assignee: assignee || null, dep: dep || null, depMockOk: !!depMockOk, parentTask: parentTask || null, source: taskSource, sourceRef: sourceRef || (ghNumber ? `GH#${ghNumber}` : undefined), githubIssueNumber: ghNumber, githubIssueUrl: ghUrl, githubIssueOwned: ghOwned, updates: [initUpdate] });
    } catch (createErr) {
      const duplicate = createErr as {
        code?: number;
        keyPattern?: Record<string, number>;
        message?: string;
      };
      const sourceRefIndexCollision = duplicate.code === 11000
        && !!sourceRef
        && (
          (
            duplicate.keyPattern?.podId === 1
            && duplicate.keyPattern?.sourceRef === 1
            && duplicate.keyPattern?.taskId === undefined
          )
          || duplicate.message?.includes('podId_1_sourceRef_1_partial')
        );
      if (!sourceRefIndexCollision) throw createErr;

      // The pre-check can lose a race to another request. Re-read the winner
      // only after Mongo identifies the sourceRef index as the collision.
      // Do not reopen here: the concurrent winner has just created a fresh
      // task, so this request is an idempotent replay of that creation.
      const existing = await Task.findOne({
        podId: mongoose.Types.ObjectId.createFromHexString(podId || ''),
        sourceRef,
      }) as { toObject: () => unknown } | null;
      if (!existing) throw createErr;
      return res.json({ task: existing.toObject(), alreadyExists: true });
    }
    if (parentTask && GitHubAppService.isPatConfigured()) {
      try {
        const parent = await Task.findOne({ podId: mongoose.Types.ObjectId.createFromHexString(podId || ''), taskId: parentTask }).lean() as { githubIssueNumber?: number; githubIssueOwned?: boolean } | null;
        // Same provenance gate as the close path: a parent task's issue number
        // is caller-supplied too, so commenting on it unowned would let any
        // caller post attacker-chosen text (`title`) to an arbitrary issue.
        if (parent?.githubIssueNumber && parent.githubIssueOwned) {
          const depNote = dep ? ` (blocked by ${dep})` : '';
          GitHubAppService.addIssueComment({ issueNumber: parent.githubIssueNumber, comment: `**Sub-task created:** ${taskId} — ${title}${depNote}\nAssigned to: ${assignee || 'unassigned'}` }).catch((e: Error) => console.warn('GH sub-task comment failed:', e.message));
        }
      } catch (e) {
        console.warn('Parent GH lookup failed (non-fatal):', (e as Error).message);
      }
    }
    emitTaskUpdated(podId, task, 'created');
    notifyAgents(req, podId, task, 'created');
    return res.status(201).json({ task });
  } catch (err) {
    console.error('POST /tasks error:', err);
    return res.status(500).json({ error: 'Failed to create task' });
  }
});

// ADR-018 D4: a task claim is a LEASE, not a tenure. Before this, claimedBy
// had no deadline — a dead claimant (closed laptop, killed wrapper) held the
// task forever, invisibly. 30 minutes matches the pod convention that peers
// race on work stalled ~30 min ("claim-the-orphan"), and renewal is the same
// call: a holder re-claiming wins against itself and gets a fresh lease —
// identical semantics to message claims (messageClaimService).
const TASK_CLAIM_LEASE_MS = 30 * 60 * 1000;

// The single definition of "claimable", shared by the CLAIM path and the LIST
// path. They used to disagree: the CAS below grants a lapsed lease, while
// GET /tasks could only filter on stored `status`, so a lapsed task was
// grantable and unfindable at the same time. That is why
// tasks.claim-lease.test.js:154 ("a lapsed lease is claimable by a peer")
// passes while no peer can reach the task — it drives the CAS directly and
// never asks whether the work can be discovered.
//
// ADR-018 put kernel enforcement of claims out of scope, so there is no reaper
// and recovery is lazy: discovery IS the recovery mechanism. That makes this
// predicate load-bearing rather than a convenience filter.
//
// Parameterised, never copied. `claimedBy` adds the self-renewal branch the
// CAS needs; the list omits it deliberately, because "what can I pick up" does
// not mean work the caller already holds. One function, so the expiry rule
// cannot drift between call sites and quietly re-open this gap.
export const claimableConditions = (
  now: Date,
  claimedBy?: string,
): Record<string, unknown>[] => [
  { status: 'pending' },
  ...(claimedBy ? [{ status: 'claimed', claimedBy }] : []),
  { status: 'claimed', claimExpiresAt: { $lt: now } },
  { status: 'claimed', claimExpiresAt: null, claimedAt: { $lt: new Date(now.getTime() - TASK_CLAIM_LEASE_MS) } },
];

export type TaskLeaseState = 'unleased' | 'held' | 'lapsed';

// `claimableConditions` above is a QUERY PREDICATE — it selects rows, and for the
// CAS it also takes the caller. It cannot LABEL a row, and a rescuer needs the
// label: theo must tell "assign this" (unleased) from "rescue this" (lapsed) in
// one pass over a board it already has. So this is a second expression of the
// same expiry rule, kept deliberately and pinned to the first by the differential
// in tasksApi.leaseState.test.js — mutate either side and that test reds.
//
// Both read one `TASK_CLAIM_LEASE_MS`. That shared constant is what makes the two
// shapes agree; the test is what proves they still do.
//
// It is deliberately NOT called `claimable`, and the difference is load-bearing.
// Claimability is a RELATION between a row and an asker: the CAS's second branch
// (`{ status: 'claimed', claimedBy }`) admits the current holder renewing its own
// lease, and no per-row field can express that — the same row is claimable by its
// holder and not by anyone else, simultaneously. So read `held` as "someone holds
// a live lease", never as "do not attempt": a seat resuming ITS OWN task must
// still call claim and will still win. Three of the CAS's four branches are
// representable here; the fourth is structurally out of reach.
//
// Combine with `status` before deciding anything. A `done` row is `unleased`
// because nobody holds a lease on it, not because it is available to work.
function deriveLeaseState(
  task: { status?: string; claimedAt?: Date | string | null; claimExpiresAt?: Date | string | null },
  now: Date,
): TaskLeaseState {
  if (task?.status !== 'claimed') return 'unleased';
  // Mirrors CAS branch 3 (`claimExpiresAt: { $lt: now }`), strict-less included.
  if (task.claimExpiresAt) {
    return new Date(task.claimExpiresAt).getTime() < now.getTime() ? 'lapsed' : 'held';
  }
  // Mirrors CAS branch 4: claims that predate leases entirely carry a null
  // `claimExpiresAt`, so their expiry is derived from `claimedAt` — they lapse one
  // lease after they were taken, not instantly, so nobody steals work claimed two
  // minutes ago during a rollout. A claimed row carrying NEITHER timestamp cannot
  // be proven lapsed and the CAS refuses it too, so it reads `held`.
  if (!task.claimedAt) return 'held';
  return new Date(task.claimedAt).getTime() < now.getTime() - TASK_CLAIM_LEASE_MS ? 'lapsed' : 'held';
}

router.post('/:podId/:taskId/claim', rateLimit({
  windowMs: 60_000,
  // Higher than task-create's 20: a claimant renews by re-claiming, and a
  // busy agent can be racing several tasks in a minute. Still low enough
  // that a runaway loop hits the wall inside one lease window.
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: taskWriteRateLimitKey,
  handler: (_req: Request, res: Response) => res.status(429).json({ error: 'rate limit exceeded: 30 task claims per 60s' }),
}), auth, async (req: AuthReq, res: Res) => {
  try {
    const { podId, taskId } = req.params || {};
    const userId = req.userId || req.user?._id || req.agentUser?._id;
    const agentId = resolveAgentInstanceId(req);
    const claimedBy = agentId || userId?.toString() || '';
    const author = await resolveAuthor(req);
    const access = await requirePodMember(podId || '', userId, { write: true });
    if (access.error) return res.status(access.status || 500).json({ error: access.error });
    const now = new Date();
    const update = { $set: { status: 'claimed', claimedBy, claimedAt: now, claimExpiresAt: new Date(now.getTime() + TASK_CLAIM_LEASE_MS) }, $push: { updates: { text: `Claimed by ${author}`, author, authorId: userId?.toString() || null, createdAt: now } } };
    // One CAS, four ways to win: the task is unclaimed; the caller already
    // holds it (renewal); the holder's lease lapsed; or the claim predates
    // leases entirely (claimExpiresAt null) and is older than one lease —
    // legacy claims get their effective expiry derived from claimedAt, so no
    // migration and no instant steal of work someone claimed minutes ago.
    const task = await Task.findOneAndUpdate({
      podId: mongoose.Types.ObjectId.createFromHexString(podId || ''),
      taskId,
      $or: claimableConditions(now, claimedBy),
    }, update, { new: true });
    if (!task) {
      const existing = await Task.findOne({ podId: mongoose.Types.ObjectId.createFromHexString(podId || ''), taskId }).lean() as { claimedBy?: string; status?: string; claimExpiresAt?: Date | null } | null;
      if (!existing) return res.status(404).json({ error: 'Task not found' });
      // Name the live holder AND when the lease frees — a loser standing
      // down should know when racing again is legitimate (D3: informed, not
      // blind).
      return res.status(409).json({
        error: 'Task already claimed',
        claimedBy: existing.claimedBy,
        status: existing.status,
        claimExpiresAt: existing.claimExpiresAt || null,
      });
    }
    emitTaskUpdated(podId, task, 'updated');
    notifyAgents(req, podId, task, 'updated');
    return res.json({ task });
  } catch (err) {
    console.error('POST /tasks/claim error:', err);
    return res.status(500).json({ error: 'Failed to claim task' });
  }
});

router.post('/:podId/:taskId/complete', taskWriteRateLimit(30), auth, async (req: AuthReq, res: Res) => {
  try {
    const { podId, taskId } = req.params || {};
    const userId = req.userId || req.user?._id || req.agentUser?._id;
    const { prUrl, notes } = (req.body || {}) as { prUrl?: string; notes?: string };
    const author = await resolveAuthor(req);
    const access = await requirePodMember(podId || '', userId, { write: true });
    if (access.error) return res.status(access.status || 500).json({ error: access.error });
    const updateText = prUrl ? `Completed by ${author} · PR: ${prUrl}` : `Completed by ${author}`;
    const update = { $set: { status: 'done', completedAt: new Date(), ...(prUrl && { prUrl }), ...(notes && { notes }) }, $push: { updates: { text: updateText, author, authorId: userId?.toString() || null, createdAt: new Date() } } };
    const task = await Task.findOneAndUpdate({ podId: mongoose.Types.ObjectId.createFromHexString(podId || ''), taskId, status: { $in: ['claimed', 'pending'] } }, update, { new: true }) as { githubIssueNumber?: number; githubIssueOwned?: boolean; taskId?: string; updates?: unknown[] } | null;
    if (!task) {
      const existing = await Task.findOne({ podId: mongoose.Types.ObjectId.createFromHexString(podId || ''), taskId }).lean() as { status?: string } | null;
      if (!existing) return res.status(404).json({ error: 'Task not found' });
      return res.status(409).json({ error: 'Task is already done', status: existing.status });
    }
    // `githubIssueOwned` gates the write, NOT `githubIssueNumber`. The number is
    // caller-supplied on create and validated only as a positive integer, so
    // trusting it here let any agent token close an arbitrary issue in our
    // repository under our PAT — with `prUrl`, also caller-supplied, appearing
    // in the closing comment. Legacy tasks predate the flag and therefore no
    // longer auto-close: failing closed is the correct direction for a write we
    // cannot prove we own.
    if (task.githubIssueNumber && task.githubIssueOwned && GitHubAppService.isPatConfigured()) {
      (async () => {
        try {
          const subTasks = await Task.find({ podId: mongoose.Types.ObjectId.createFromHexString(podId || ''), parentTask: task.taskId }).select('taskId title status prUrl').lean() as Array<{ taskId?: string; title?: string; status?: string; prUrl?: string }>;
          let closeComment = prUrl ? `Completed via ${prUrl}` : `Completed by ${author}`;
          if (subTasks.length > 0) {
            const subLines = subTasks.map((s) => { const icon = s.status === 'done' ? '✅' : s.status === 'blocked' ? '❌' : '⏳'; return `${icon} ${s.taskId}: ${s.title}${s.prUrl ? ` — [PR](${s.prUrl})` : ''}`; });
            closeComment += `\n\n**Sub-tasks:**\n${subLines.join('\n')}`;
          }
          await GitHubAppService.closeIssue({ issueNumber: task.githubIssueNumber, comment: closeComment });
        } catch (err) {
          console.warn(`Failed to auto-close GH#${task.githubIssueNumber}:`, (err as Error).message);
        }
      })();
    }
    // ADR-012 §4: task-completed trigger. Fire-and-forget; only writes when
    // the assignee is a recognized agent member of the pod.
    try {
      // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
      const triggers = require('../services/systemExchangeTriggers') as {
        recordTaskCompleted: (a: {
          podId: string;
          assignee?: string | null;
          taskTitle: string;
          prUrlOrStatus?: string | null;
        }) => Promise<void>;
      };
      const taskWithFields = task as { title?: string; assignee?: string | null; prUrl?: string | null };
      void triggers.recordTaskCompleted({
        podId: String(podId),
        assignee: taskWithFields.assignee ?? null,
        taskTitle: taskWithFields.title || '',
        prUrlOrStatus: prUrl || taskWithFields.prUrl || null,
      });
    } catch (triggerErr) {
      console.warn('[system-exchange] task-completed dispatch failed:', (triggerErr as Error).message);
    }
    emitTaskUpdated(podId, task, 'updated');
    notifyAgents(req, podId, task, 'updated');
    return res.json({ task });
  } catch (err) {
    console.error('POST /tasks/complete error:', err);
    return res.status(500).json({ error: 'Failed to complete task' });
  }
});

router.post('/:podId/:taskId/updates', taskWriteRateLimit(60), auth, async (req: AuthReq, res: Res) => {
  try {
    const { podId, taskId } = req.params || {};
    const userId = req.userId || req.user?._id || req.agentUser?._id;
    const { text } = (req.body || {}) as { text?: string };
    if (!text?.trim()) return res.status(400).json({ error: 'text is required' });
    const access = await requirePodMember(podId || '', userId, { write: true });
    if (access.error) return res.status(access.status || 500).json({ error: access.error });
    const author = await resolveAuthor(req);
    const task = await Task.findOneAndUpdate({ podId: mongoose.Types.ObjectId.createFromHexString(podId || ''), taskId }, { $push: { updates: { text: text.trim(), author, authorId: userId?.toString() || null, createdAt: new Date() } } }, { new: true });
    if (!task) return res.status(404).json({ error: 'Task not found' });
    emitTaskUpdated(podId, task, 'updated');
    notifyAgents(req, podId, task, 'updated');
    return res.json({ task });
  } catch (err) {
    console.error('POST /tasks/updates error:', err);
    return res.status(500).json({ error: 'Failed to add update' });
  }
});

// Task.status vocabulary. findOneAndUpdate does NOT run the schema's enum
// validator, so this route is the only gate between a caller's status string
// and the DB — and agent callers routinely write the LLM-natural names
// (in_progress, completed). Unvalidated, those landed in Mongo and the board
// rendered the task in no column while still counting it in the header.
// Aliases are normalized (agents should not have to memorize our enum);
// anything else is a 400 that TEACHES the vocabulary instead of guessing.
const VALID_TASK_STATUSES = ['pending', 'claimed', 'done', 'blocked'];
const TASK_STATUS_ALIASES: Record<string, string> = {
  in_progress: 'claimed',
  'in-progress': 'claimed',
  inprogress: 'claimed',
  todo: 'pending',
  open: 'pending',
  completed: 'done',
  complete: 'done',
  finished: 'done',
};

router.patch('/:podId/:taskId', taskWriteRateLimit(60), auth, async (req: AuthReq, res: Res) => {
  try {
    const { podId, taskId } = req.params || {};
    const userId = req.userId || req.user?._id || req.agentUser?._id;
    const allowed = ['title', 'assignee', 'dep', 'depMockOk', 'parentTask', 'status', 'notes', 'prUrl'];
    const fieldUpdates: Record<string, unknown> = {};
    const body = (req.body || {}) as Record<string, unknown>;
    allowed.forEach((k) => { if (body[k] !== undefined) fieldUpdates[k] = body[k]; });
    // Unassign has two spellings and only one of them was reaching the DB. The
    // openclaw tool types `assignee` as a plain string and documents "empty string
    // to unassign", so a moltbot literally cannot send null; an MCP or HTTP caller
    // sends null. Stored as '', the row is neither null NOR missing, so theo's
    // classify-and-assign step — whose trigger is exactly "assignee is null/missing"
    // — skips it forever, and a rescued task lands in a lane no seat fetches. One
    // normalisation here beats teaching every caller which spelling this backend
    // happens to accept.
    if (typeof fieldUpdates.assignee === 'string' && fieldUpdates.assignee.trim() === '') {
      fieldUpdates.assignee = null;
    }
    if (Object.keys(fieldUpdates).length === 0) return res.status(400).json({ error: 'No updatable fields provided' });
    if (fieldUpdates.status !== undefined) {
      const raw = String(fieldUpdates.status).trim().toLowerCase();
      const normalized = TASK_STATUS_ALIASES[raw] || raw;
      if (!VALID_TASK_STATUSES.includes(normalized)) {
        return res.status(400).json({
          error: `status must be one of ${VALID_TASK_STATUSES.join('|')} (got '${fieldUpdates.status}'). `
            + 'Aliases accepted: in_progress→claimed, completed→done, todo→pending.',
        });
      }
      fieldUpdates.status = normalized;
    }
    const access = await requirePodMember(podId || '', userId, { write: true });
    if (access.error) return res.status(access.status || 500).json({ error: access.error });
    const author = await resolveAuthor(req);
    const changeParts: string[] = [];
    if (fieldUpdates.assignee !== undefined) changeParts.push(`reassigned to ${fieldUpdates.assignee || 'unassigned'}`);
    if (fieldUpdates.status !== undefined) changeParts.push(`status → ${fieldUpdates.status}`);
    if (fieldUpdates.dep !== undefined) changeParts.push(`dep → ${fieldUpdates.dep || 'none'}`);
    if (fieldUpdates.parentTask !== undefined) changeParts.push(`parent → ${fieldUpdates.parentTask || 'none'}`);
    if (fieldUpdates.prUrl !== undefined) changeParts.push(`PR: ${fieldUpdates.prUrl}`);
    if (fieldUpdates.notes !== undefined) changeParts.push('notes updated');
    if (fieldUpdates.title !== undefined) changeParts.push('title updated');
    const update: Record<string, unknown> = { $set: fieldUpdates };
    if (changeParts.length > 0) update.$push = { updates: { text: `${author} updated: ${changeParts.join(', ')}`, author, authorId: userId?.toString() || null, createdAt: new Date() } };
    const task = await Task.findOneAndUpdate({ podId: mongoose.Types.ObjectId.createFromHexString(podId || ''), taskId }, update, { new: true });
    if (!task) return res.status(404).json({ error: 'Task not found' });
    emitTaskUpdated(podId, task, 'updated');
    notifyAgents(req, podId, task, 'updated');
    return res.json({ task });
  } catch (err) {
    console.error('PATCH /tasks error:', err);
    return res.status(500).json({ error: 'Failed to update task' });
  }
});

module.exports = router;
// `module.exports = router` CLOBBERS the ES named exports above — under CJS
// require, `claimableConditions` did not survive and destructuring it returned
// undefined (found when the kernel-sweep contract pin tried to import it; the
// export had been unreachable since #1022 shipped it). Re-attached explicitly
// so the single definition of "claimable" is actually consumable.
module.exports.claimableConditions = claimableConditions;

export {};
