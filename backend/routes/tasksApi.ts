import { requirePodMember } from '../services/podMembershipService';
import { onTaskClosed } from '../services/roomGrantService';
import { compareTaskPriority, isTaskPriority } from '../utils/taskPriority';
import { createHash } from 'crypto';
import type { Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { cloudflareIpRateLimitKeyGenerator } from '../middleware/ipRateLimit';
// eslint-disable-next-line global-require
const express = require('express');
// eslint-disable-next-line global-require
const mongoose = require('mongoose');
// eslint-disable-next-line global-require
const auth = require('../middleware/dualAuth');
const { resolveDualAuthCredential } = auth;
// eslint-disable-next-line global-require
const Pod = require('../models/Pod');
// eslint-disable-next-line global-require
const Task = require('../models/Task');
// eslint-disable-next-line global-require
const User = require('../models/User');
// eslint-disable-next-line global-require
const AgentSendFreshness = require('../services/agentSendFreshness');
// eslint-disable-next-line global-require
const { emitTaskUpdated, notifyPodAgents } = require('../services/taskEventService');
// eslint-disable-next-line global-require
const { emitSystemActionLine } = require('../services/systemActionLineService');
// eslint-disable-next-line global-require
const { resolveAgentDisplayLabel } = require('../services/agentIdentityService');
// eslint-disable-next-line global-require
const { recordTaskAttention, resolveTaskAttention } = require('../services/attentionItemService');
// eslint-disable-next-line global-require
const { parseAssignee, toSingleLineTitle } = require('../utils/taskFieldNormalization');
// eslint-disable-next-line global-require
const { boardNameOf, canonicalAssignee } = require('../services/taskAssigneeService');
// eslint-disable-next-line global-require
const { isRecordEnabled, isRecordReader, requestActor } = require('../services/recordService');
// eslint-disable-next-line global-require
const { recordTaskTransition } = require('../services/taskRecordService');

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
const notifyAgentsAs = (
  actor: ReturnType<typeof actorOf>, podId: unknown, task: unknown, kind: string, previousTask?: unknown,
) => {
  try {
    const pending = notifyPodAgents(podId, task, kind, actor, previousTask);
    if (pending?.catch) {
      pending.catch((e: Error) => console.warn('[tasks] agent notify failed:', e.message));
    }
  } catch (e) {
    console.warn('[tasks] agent notify threw:', (e as Error).message);
  }
};
const notifyAgents = (req: any, podId: unknown, task: unknown, kind: string, previousTask?: unknown) => (
  notifyAgentsAs(actorOf(req), podId, task, kind, previousTask)
);

interface AuthReq {
  userId?: string;
  // `username` is here because the sweep can write it into `lapsedFrom`
  // (provenance falls back through holder.label = assignee || username ||
  // claimedBy), so the restore path must be able to match on it.
  user?: { id?: string; _id?: unknown; isBot?: boolean; username?: string; profilePicture?: string; botMetadata?: { displayName?: string; instanceId?: string; agentName?: string } };
  // Same reason as `user.username` above: `agentRuntimeAuth` puts the bot's
  // User row here, and its username is what the sweep writes into
  // `lapsedFrom` for an agent holder.
  agentUser?: { _id?: unknown; username?: string; profilePicture?: string; isBot?: boolean; botMetadata?: { displayName?: string; instanceId?: string; agentName?: string } };
  params?: Record<string, string>;
  query?: Record<string, string>;
  body?: Record<string, unknown>;
  header?: (name: string) => string | undefined;
}
interface Res {
  status: (n: number) => Res;
  json: (d: unknown) => void;
}

const router: ReturnType<typeof express.Router> = express.Router();

// A pending unassigned row is offered again only when updatedAt advances past
// offeredAt. Mongoose's wall-clock timestamp can run behind a revision bumped
// by a concurrent PATCH, so task writes in this route reserve the next value
// against the stored revision instead of letting a later write move it back.
const updateTaskWithRevisionSnapshot = async (
  filter: Record<string, unknown>,
  update: Record<string, unknown>,
) => {
  const key = { podId: filter.podId, taskId: filter.taskId };
  for (let attempt = 0; attempt < 4; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop
    const current = await Task.findOne(key).select('updatedAt claimedBy lapsedFrom assignee status').lean();
    if (!current) return null;
    const writeTime = new Date(Math.max(Date.now(), current.updatedAt.getTime() + 1));
    // eslint-disable-next-line no-await-in-loop
    const task = await Task.findOneAndUpdate(
      {
        ...filter,
        updatedAt: current.updatedAt,
        assignee: current.assignee ?? null,
        // A caller may already constrain claimedBy (note renewal). Preserve
        // that predicate; otherwise bind the ownership snapshot to this CAS.
        ...('claimedBy' in filter ? {} : { claimedBy: current.claimedBy ?? null }),
      },
      { ...update, $set: { ...(update.$set as Record<string, unknown> || {}), updatedAt: writeTime } },
      { new: true, timestamps: false },
    );
    // The revision and ownership predicates bind this snapshot to the write.
    if (task) return { task, previous: current };
    // Retry a changed revision, owner, or status; otherwise a caller predicate
    // (such as a live lease) refused the write.
    // eslint-disable-next-line no-await-in-loop
    const latest = await Task.findOne(key).select('updatedAt assignee claimedBy status').lean();
    if (!latest || (latest.updatedAt.getTime() === current.updatedAt.getTime()
      && (latest.assignee ?? null) === (current.assignee ?? null)
      && (latest.claimedBy ?? null) === (current.claimedBy ?? null)
      && latest.status === current.status)) return null;
  }
  return null;
};

const updateTaskWithRevision = async (
  filter: Record<string, unknown>,
  update: Record<string, unknown>,
) => (await updateTaskWithRevisionSnapshot(filter, update))?.task || null;

const taskWriteRateLimitKey = (req: Request): string => {
  const authHeader = resolveDualAuthCredential(req).token;
  if (authHeader) {
    return `tok:${createHash('sha256').update(authHeader).digest('hex').slice(0, 16)}`;
  }
  return cloudflareIpRateLimitKeyGenerator(req as never);
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
const taskReadIpRateLimit = rateLimit({
  windowMs: 60_000,
  max: 3000,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: cloudflareIpRateLimitKeyGenerator,
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

// The caller's board name, or undefined for a person (F45). A `cm_agent_`
// token arrives with req.agentUser.botMetadata. An agent on a plain `cm_` user
// token takes the human path, whose req.user carries neither isBot nor
// botMetadata, so its own row is read.
async function callerBoardName(req: AuthReq, userId: unknown): Promise<string | undefined> {
  const meta = req.agentUser?.botMetadata;
  if (meta?.agentName) return boardNameOf(meta);
  if (!userId || !mongoose.isValidObjectId(String(userId))) return undefined;
  const row = await User.findById(userId).select('isBot botMetadata').lean() as
    { isBot?: boolean; botMetadata?: { agentName?: string; instanceId?: string } } | null;
  return row?.isBot && row.botMetadata?.agentName ? boardNameOf(row.botMetadata) : undefined;
}

function resolveAgentInstanceId(req: AuthReq): string | null {
  if (!req.user?.isBot) return null;
  return req.user.botMetadata?.instanceId || req.user.botMetadata?.agentName || null;
}


async function nextTaskId(podId: string): Promise<{ taskId: string; taskNum: number }> {
  const last = await Task.findOne({ podId, taskId: { $exists: true } }).sort({ taskId: -1 }).select('taskId').lean() as { taskId?: string } | null;
  const lastNum = last ? parseInt((last.taskId || '').replace('TASK-', ''), 10) : 0;
  const num = lastNum + 1;
  return { taskId: `TASK-${String(num).padStart(3, '0')}`, taskNum: num };
}

router.get('/:podId', taskReadIpRateLimit, auth, async (req: AuthReq, res: Res) => {
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
    // Read the filter the way the writers store it, so a seat that assigned a
    // row by an agent's handle finds it again by that handle. The spelling as
    // typed still matches a row stored before the writers canonicalized.
    if (assignee) {
      const stored = await canonicalAssignee(podId || '', assignee);
      query.assignee = stored === assignee ? assignee : { $in: [stored, assignee] };
    }
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
    // The same holder id the claim route writes, so a seat can tell its own
    // claims from a peer's without knowing its user id (TASK-640).
    const caller = resolveAgentInstanceId(req) || userId?.toString() || '';
    return res.json({
      permissions: {
        canWrite: access.canWrite === true,
        // The board shows a task's record link only to someone the record
        // route will serve (routes/podRecords.ts).
        canReadRecord: isRecordEnabled(podId) && isRecordReader((access.pod as { members?: unknown })?.members, userId),
      },
      tasks: tasks.sort(compareTaskPriority).map((task: Record<string, unknown>) => ({
        ...task,
        leaseState: deriveLeaseState(task, now),
        claimedByMe: Boolean(caller) && task.claimedBy === caller,
      })),
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
      priority: priorityInput,
      assignee: assigneeInput,
      dep: depInput,
      depMockOk: depMockOkInput,
      parentTask: parentTaskInput,
      source: sourceInput,
      sourceRef: sourceRefInput,
    } = req.body || {};
    if (priorityInput !== undefined && !isTaskPriority(priorityInput)) {
      return res.status(400).json({ error: 'priority must be P0, P1, P2 or P3' });
    }
    const stringInputs: Record<string, unknown> = {
      title: titleInput,
      assignee: assigneeInput,
      dep: depInput,
      parentTask: parentTaskInput,
      source: sourceInput,
      sourceRef: sourceRefInput,
    };
    const invalidStringField = Object.entries(stringInputs)
      .find(([, value]) => value !== undefined && typeof value !== 'string');
    if (invalidStringField) {
      return res.status(400).json({ error: `${invalidStringField[0]} must be a string` });
    }
    if (depMockOkInput !== undefined && typeof depMockOkInput !== 'boolean') {
      return res.status(400).json({ error: 'depMockOk must be a boolean' });
    }
    // Materialize primitives after runtime validation so Mongo never receives
    // user-supplied query objects (for example, operator-shaped values).
    const title = titleInput === undefined ? undefined : toSingleLineTitle(String(titleInput));
    const assigneeParsed = assigneeInput === undefined ? undefined : parseAssignee(String(assigneeInput));
    if (assigneeParsed?.error) return res.status(400).json({ error: assigneeParsed.error });
    const typedAssignee = assigneeParsed?.value ?? undefined;
    const dep = depInput === undefined ? undefined : String(depInput);
    const parentTask = parentTaskInput === undefined ? undefined : String(parentTaskInput);
    const source = sourceInput === undefined ? undefined : String(sourceInput);
    const sourceRef = sourceRefInput === undefined ? undefined : String(sourceRefInput);
    const depMockOk = depMockOkInput === true;
    if (!title) return res.status(400).json({ error: 'title is required' });
    const access = await requirePodMember(podId || '', userId, { write: true });
    if (access.error) return res.status(access.status || 500).json({ error: access.error });
    // Resolved only for a member: an agent named by any of its names is stored by its board name.
    const assignee = (await canonicalAssignee(podId || '', typedAssignee)) ?? undefined;
    if (sourceRef) {
      // A create's identity is the (sourceRef, title) PAIR: the ref says where
      // the ask came from, the title says which ask it is. Keying on the ref
      // alone made a second ask from one source adopt the first ask's row and
      // discard the caller's title (TASK-063). Same pair = idempotent retry.
      // Rows written before titles were collapsed hold the raw text (`Fix\nboard`);
      // a replay of that input must still find them, or the pair index admits a twin.
      // The exact raw title is tried first so a `Fix board` row cannot shadow it.
      const titleCandidates = [titleInput === undefined ? undefined : String(titleInput), title].filter((t, i, all) => t !== undefined && all.indexOf(t) === i);
      let existing = null as { _id: unknown; title?: string; status?: string; assignee?: string; claimedAt?: Date | null; claimExpiresAt?: Date | null; notes?: string; updatedAt: Date; toObject: () => unknown } | null;
      for (const candidate of titleCandidates) {
        // eslint-disable-next-line no-await-in-loop
        existing = await Task.findOne({ podId: mongoose.Types.ObjectId.createFromHexString(podId || ''), sourceRef, title: candidate }) as typeof existing;
        if (existing) break;
      }
      if (existing) {
        if (existing.status === 'done') {
          // `sourceRef` + `title` are an idempotency key (a unique partial
          // index backs the pair), so a settled row with the same ref AND the
          // same title is reopened in place rather than duplicated — the same
          // source is active again.
          //
          // It deliberately does NOT discard the previous `notes`. They are
          // moved into the append-only `updates` history before the reopen note
          // replaces them; a reopen used to overwrite a completed row's writeup
          // with one sentence, losing the only durable record of that work.
          //
          // A differing title cannot reach this branch: it is a different ask,
          // and the pre-check above does not match it. It used to reopen here
          // and report the mismatch, which put a completed row back to pending
          // under a title its caller never chose (TASK-063).
          const previousNotes = (existing.notes || '').trim();
          const history = previousNotes ? [{
            text: `Previous notes preserved from the completed run:\n${previousNotes}`,
            author: 'system', authorId: null, createdAt: new Date(),
          }] : [];
          history.push({
            text: 'Reopened: task was done but its source is active again — picking up again.',
            author: 'system', authorId: null, createdAt: new Date(),
          });
          const writeTime = new Date(Math.max(Date.now(), existing.updatedAt.getTime() + 1));
          const reopened = await Task.findOneAndUpdate(
            { _id: existing._id, status: 'done', updatedAt: existing.updatedAt },
            {
              $set: {
                status: 'pending', assignee: assignee || null, claimedByUserId: null, claimedAt: null,
                claimExpiresAt: null, notes: 'Reopened — the same source is active again.',
                updatedAt: writeTime,
              },
              $push: { updates: { $each: history } },
            },
            { new: true, timestamps: false },
          );
          if (!reopened) return res.status(409).json({ error: 'Task changed concurrently; retry' });
          const reopenedObj = reopened.toObject();
          emitTaskUpdated(podId, reopenedObj, 'updated');
          notifyAgents(req, podId, reopenedObj, 'updated');
          // `alreadyExists: true`, because it does: this request did not create
          // a row, it reopened one. It used to answer `false`, and
          // `alreadyExists` is the field a caller branches on to decide whether
          // its create landed — so a caller concluded it had created a task
          // while holding a different task's row (TASK-063). `reopened` carries
          // what happened instead.
          return res.json({ task: reopenedObj, alreadyExists: true, reopened: true });
        }
        return res.json({ task: existing.toObject(), alreadyExists: true });
      }
    }
    const author = await resolveAuthor(req);
    const { taskId, taskNum } = await nextTaskId(podId || '');
    const initUpdate: { text: string; author: string; authorId: string | null; createdAt: Date } = { text: `Created by ${author}`, author, authorId: userId?.toString() || null, createdAt: new Date() };
    if (assignee) initUpdate.text = `Created by ${author} · assigned to ${assignee}`;
    if (sourceRef) initUpdate.text = `Created by ${author} from ${sourceRef}${assignee ? ` · assigned to ${assignee}` : ''}`;
    if (parentTask) initUpdate.text += ` · sub-task of ${parentTask}`;
    // `source` is provenance for task creation, so an agent-authenticated
    // caller may not self-identify as human (or any other source) through the
    // request body. Human callers retain the explicit source override.
    const taskSource = req.agentUser?._id
      ? 'agent'
      : source || 'human';
    let task;
    try {
      task = await Task.create({ podId, taskNum, taskId, title, priority: priorityInput || 'P2', assignee: assignee || null, dep: dep || null, depMockOk: !!depMockOk, parentTask: parentTask || null, source: taskSource, sourceRef, createdByUserId: userId?.toString() || null, updates: [initUpdate] });
    } catch (createErr) {
      const duplicate = createErr as {
        code?: number;
        keyPattern?: Record<string, number>;
        message?: string;
      };
      // A database still carrying the pre-TASK-063 ref-only index cannot honour
      // the (sourceRef, title) key: a second title under one ref collides there,
      // so the create the caller asked for is not the create this database can
      // perform. Name the migration instead of returning a generic 500 — the
      // operator response is a command, not a code hunt.
      const legacySourceRefIndex = duplicate.code === 11000
        && !!sourceRef
        && duplicate.keyPattern?.podId === 1
        && duplicate.keyPattern?.sourceRef === 1
        && duplicate.keyPattern?.title === undefined
        && duplicate.keyPattern?.taskId === undefined;
      const sourceRefIndexCollision = duplicate.code === 11000
        && !!sourceRef
        && (
          (
            duplicate.keyPattern?.podId === 1
            && duplicate.keyPattern?.sourceRef === 1
            && duplicate.keyPattern?.title === 1
            && duplicate.keyPattern?.taskId === undefined
          )
          || duplicate.message?.includes('podId_1_sourceRef_1_title_1_partial')
        );
      if (legacySourceRefIndex) {
        console.error('POST /tasks: tasks index is still podId_1_sourceRef_1_partial — run `npm run migrate:task-source-ref-identity`');
        return res.status(503).json({
          error: 'task sourceRef index migration pending: run `npm run migrate:task-source-ref-identity`',
          code: 'task_source_ref_index_migration_pending',
        });
      }
      if (!sourceRefIndexCollision) throw createErr;

      // The pre-check can lose a race to another request. Re-read the winner
      // only after Mongo identifies the sourceRef index as the collision.
      // Do not reopen here: the concurrent winner has just created a fresh
      // task, so this request is an idempotent replay of that creation.
      const existing = await Task.findOne({
        podId: mongoose.Types.ObjectId.createFromHexString(podId || ''),
        sourceRef,
        title,
      }) as { toObject: () => unknown } | null;
      if (!existing) throw createErr;
      return res.json({ task: existing.toObject(), alreadyExists: true });
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

// The write-side counterpart to `deriveLeaseState`, for the two routes that change
// a row's FIELDS or its terminal state. Returns the holder when a DIFFERENT seat
// holds a live lease, else null.
//
// Deliberately not "must be claimable". `claimableConditions` has no branch for
// `status: 'done'`, so a guard built on it would refuse every retitle or
// after-the-fact prUrl on a finished row; and refusing on a LAPSED lease would
// strand work behind a dead seat, which is the objection that kept this out of the
// kernel until 2026-09-19 (AX entry 61: `complete` wrote through a peer's live
// claim and reported `done` beside their unexpired `claimedBy`). `held` already
// means only "someone holds a live lease", and comparing the caller keeps the
// holder able to write its own row — the same relation the CAS draws with branch 2.
const liveLeaseHolder = (
  task: { status?: string; claimedAt?: Date | string | null; claimExpiresAt?: Date | string | null; claimedBy?: string | null },
  now: Date,
  claimKey: string,
): { claimedBy: string; claimExpiresAt: Date | null } | null => {
  if (deriveLeaseState(task, now) !== 'held') return null;
  const holder = task.claimedBy || null;
  if (!holder || holder === claimKey) return null;
  // A claim that predates leases carries a null `claimExpiresAt` and derives its
  // expiry from `claimedAt` (CAS branch 4). Report that instant rather than a bare
  // null, or a refused writer is told to retry never.
  const expiry = task.claimExpiresAt
    ? new Date(task.claimExpiresAt)
    : task.claimedAt
      ? new Date(new Date(task.claimedAt).getTime() + TASK_CLAIM_LEASE_MS)
      : null;
  return { claimedBy: holder, claimExpiresAt: expiry };
};

// Seats hold leases; people do not, so only a seat is ever refused. Both auth paths
// in `agentRuntimeAuth` set `req.agentUser`, the bot user row also arrives as
// `req.user.isBot` (which is what `resolveAgentInstanceId` reads), and a human JWT
// sets neither — so either signal means "a seat is calling".
const isSeatCaller = (req: AuthReq): boolean => Boolean(req.agentUser || req.user?.isBot);

type LeaseCheck = { refusal: Record<string, unknown> | null; overridesHolder: string | null };

// The refusal every conflicting write path shares, so the two cannot drift into
// disagreeing about what a live lease is, and so the body has one shape: the fields
// `claim` already returns on a lost race, which is what tells a refused writer who
// holds the row and when it frees. `refusal` is null when the write may proceed;
// `overridesHolder` names the holder a creator is writing over, for the update note.
const leaseCheckForWrite = async (
  podId: string,
  taskId: string,
  req: AuthReq,
  userId: unknown,
  { creatorOverride = false }: { creatorOverride?: boolean } = {},
): Promise<LeaseCheck> => {
  if (!isSeatCaller(req)) return { refusal: null, overridesHolder: null };
  const claimKey = resolveAgentInstanceId(req) || userId?.toString() || '';
  const current = await Task.findOne({
    podId: mongoose.Types.ObjectId.createFromHexString(podId || ''),
    taskId,
  }).select('status claimedBy claimedAt claimExpiresAt createdByUserId').lean() as {
    status?: string; claimedBy?: string | null; claimedAt?: Date | null; claimExpiresAt?: Date | null;
    createdByUserId?: string | null;
  } | null;
  const holder = current ? liveLeaseHolder(current, new Date(), claimKey) : null;
  if (!holder) return { refusal: null, overridesHolder: null };
  // The creator is the stamp the create route wrote, never inferred from `updates`:
  // on a native row the first claim or note would otherwise make its author the creator.
  if (creatorOverride && userId && current?.createdByUserId === String(userId)) {
    return { refusal: null, overridesHolder: holder.claimedBy };
  }
  return {
    refusal: {
      error: 'Task is claimed by another seat',
      status: current?.status || 'claimed',
      claimedBy: holder.claimedBy,
      claimExpiresAt: holder.claimExpiresAt,
    },
    overridesHolder: null,
  };
};

// Recheck the same lease at the Mongo write boundary. A read-only refusal
// above can race with a peer claiming the row before findOneAndUpdate runs.
// The creator clause is the write-side twin of the override above, so a race
// cannot refuse the creator a write its read allowed.
const writableLeaseCondition = (
  req: AuthReq,
  userId: unknown,
  now: Date,
  { creatorOverride = false }: { creatorOverride?: boolean } = {},
): Record<string, unknown> => {
  if (!isSeatCaller(req)) return {};
  const claimKey = resolveAgentInstanceId(req) || userId?.toString() || '';
  return { $or: [
    { status: { $ne: 'claimed' } },
    { claimedBy: claimKey },
    { claimedBy: { $in: [null, ''] } },
    { claimExpiresAt: { $lt: now } },
    { claimExpiresAt: null, claimedAt: { $lt: new Date(now.getTime() - TASK_CLAIM_LEASE_MS) } },
    ...(creatorOverride && userId ? [{ createdByUserId: String(userId) }] : []),
  ] };
};

/**
 * Who a claim is written as. `userId` is the authenticated User and becomes
 * `claimedByUserId`, the field `assertGrantUsable` reads as a task-bound grant's
 * authority, so it must come from authentication, never from a body or a model.
 */
interface TaskClaimant {
  userId: string;
  claimedBy: string;
  author: string;
  actorUser: AuthReq['agentUser'] | AuthReq['user'] | null;
  notifyAs: ReturnType<typeof actorOf>;
  recordAs: ReturnType<typeof requestActor>;
}

// One derivation from an authenticated caller, so a hosted agent's claim is
// keyed exactly as the same bot's claim through this route would be.
const claimantOf = async (req: AuthReq): Promise<TaskClaimant> => {
  const userId = String(req.userId || req.user?._id || req.agentUser?._id || '');
  return {
    userId,
    claimedBy: resolveAgentInstanceId(req) || userId,
    author: await resolveAuthor(req),
    actorUser: req.agentUser || req.user || null,
    notifyAs: actorOf(req),
    recordAs: requestActor(req),
  };
};

type TaskClaimResult = { status: 200; task: unknown } | { status: number; body: Record<string, unknown> };

/**
 * The claim: the membership write check, the CAS, and what a claim tells the
 * room. The route and the native runtime's `commonly_claim_task` both call it,
 * so a hosted agent claims by exactly the rules a seat does (TASK-340). The
 * freshness hold stays in the route: it reads a CAP caller's read cursor, which
 * a hosted agent does not keep, since its turn is handed the pod's recent messages.
 */
const claimTaskAs = async (podId: string, taskId: string, claimant: TaskClaimant): Promise<TaskClaimResult> => {
  const access = await requirePodMember(podId, claimant.userId, { write: true });
  if (access.error) return { status: access.status || 500, body: { error: access.error } };
  const { userId, claimedBy, author } = claimant;
    const now = new Date();
    // Classify the current holder only after this claim's CAS wins:
    // a same-holder continuation (renewal, or re-take after the holder's own
    // lapse) is no news to the room and must not fan out (the redundant wakes
    // burned a model turn per seat per renewal and filled a pod with seats
    // narrating why they won't act — measured 2026-08-25, 4 wakes in one
    // session for one task). The revision CAS binds the ownership snapshot to
    // this successful write, even if an assignee PATCH raced the claim.
    // `rescueDeferrals` and `lapsedFrom` reset on every claim (#1080 part 2/3).
    // The deferral budget is per-lease, not per-task: a seat that renews
    // normally must never inherit a predecessor's spent budget, or the third
    // holder of a hot task gets rescued on its first lapse.
    const update = { $set: { status: 'claimed', claimedBy, claimedByUserId: userId || null, claimedAt: now, claimExpiresAt: new Date(now.getTime() + TASK_CLAIM_LEASE_MS), rescueDeferrals: 0, lapsedFrom: null }, $push: { updates: { text: `Claimed by ${author}`, author, authorId: userId || null, createdAt: now } } };
    // The primary CAS stamps authenticated ownership. Five ways to win: the task is unclaimed; the caller already
    // holds it (renewal); the holder's lease lapsed; the claim predates
    // leases entirely (claimExpiresAt null) and is older than one lease; or
    // this named task is blocked. Legacy claims get their effective expiry
    // derived from claimedAt, so no migration and no instant steal of work
    // someone claimed minutes ago.
    let result = await updateTaskWithRevisionSnapshot({
      podId: mongoose.Types.ObjectId.createFromHexString(podId),
      taskId,
      // A blocked row is deliberately resumable only when a seat names its
      // task id. Do not add it to claimableConditions: that predicate also
      // drives the discovery query, where a parked dependency is not work a
      // peer may pick up speculatively.
      $or: [
        ...claimableConditions(now),
        { status: 'claimed', claimedBy, $or: [
          { claimedByUserId: userId },
          // Legacy runtime-bearer claims already used this immutable ID.
          { claimedByUserId: null, claimedBy: userId },
        ] },
        { status: 'blocked' },
      ],
    }, update);
    if (!result && claimedBy !== userId) {
      // Preserve name-only legacy renewal, but never promote a display key to
      // authenticated grant authority. A fresh claim after release/expiry does.
      result = await updateTaskWithRevisionSnapshot({
        podId: mongoose.Types.ObjectId.createFromHexString(podId), taskId,
        status: 'claimed', claimedBy, claimedByUserId: null,
      }, { ...update, $set: { ...update.$set, claimedByUserId: null } });
    }
    if (!result) {
      const existing = await Task.findOne({ podId: mongoose.Types.ObjectId.createFromHexString(podId), taskId }).lean() as { claimedBy?: string; status?: string; claimExpiresAt?: Date | null } | null;
      if (!existing) return { status: 404, body: { error: 'Task not found' } };
      // Name the live holder AND when the lease frees — a loser standing
      // down should know when racing again is legitimate (D3: informed, not
      // blind).
      return {
        status: 409,
        body: {
          error: 'Task already claimed',
          claimedBy: existing.claimedBy,
          status: existing.status,
          claimExpiresAt: existing.claimExpiresAt || null,
        },
      };
    }
    const { task, previous: preClaim } = result;
    emitTaskUpdated(podId, task, 'updated');
    recordTaskTransition({
      podId,
      task,
      from: preClaim?.status,
      to: 'claimed',
      at: now,
      actor: claimant.recordAs,
      leaseUntil: task.claimExpiresAt,
      renewal: preClaim?.status === 'claimed' && preClaim.claimedBy === claimedBy,
    });
    // Same-holder continuation: the seat that already held (or just lapsed
    // from) this task re-claimed it. The board UI still updates (socket emit
    // above); the room is NOT woken — a lease timestamp is not an event.
    // A fresh claim and a takeover both still fan out.
    const isSameHolderContinuation = !!preClaim
      && (preClaim.claimedBy === claimedBy || preClaim.lapsedFrom === claimedBy);
    if (!isSameHolderContinuation) {
      notifyAgentsAs(claimant.notifyAs, podId, task, 'updated', preClaim);
      const { actorUser } = claimant;
      const actorName = actorUser?.isBot
        ? resolveAgentDisplayLabel(actorUser, author)
        : actorUser?.username || author;
      // The claim CAS has committed. This quiet timeline projection is
      // best-effort and never changes the claim's HTTP result.
      void emitSystemActionLine({
        podId: String(podId),
        actorUserId: String(userId),
        actorName,
        actorUsername: actorUser?.username || author,
        actorAvatarUrl: actorUser?.profilePicture || null,
        actorIsBot: !!actorUser?.isBot,
        action: 'task-claimed',
        taskId: String(task.taskId || taskId),
      }).catch((error: Error) => console.warn('[tasks] system action line failed:', error.message));
    }
    return { status: 200, task };
};

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
    // Checked here as well as in claimTaskAs: the freshness hold below answers
    // with previews of pod messages, so membership must gate it first.
    const access = await requirePodMember(podId || '', userId, { write: true });
    if (access.error) return res.status(access.status || 500).json({ error: access.error });
    if (actorOf(req).isAgent && req.body?.continueAnyway !== true) {
      const hold = await AgentSendFreshness.unseenMessages(userId, podId);
      if (hold) return res.status(409).json(hold);
    }
    const result = await claimTaskAs(podId || '', taskId || '', await claimantOf(req));
    if ('body' in result) return res.status(result.status).json(result.body);
    return res.json({ task: result.task });
  } catch (err) {
    console.error('POST /tasks/claim error:', err);
    return res.status(500).json({ error: 'Failed to claim task' });
  }
});

// ADR-012 §4: the task-completed trigger, fired by every close path (`complete`, and a
// PATCH to `done`), so a row closed either way reaches the same downstream. Fire-and-forget;
// only writes when the assignee is a recognized agent member of the pod.
const dispatchTaskCompleted = (podId: unknown, task: unknown, prUrl?: string | null): void => {
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
};

router.post('/:podId/:taskId/complete', taskWriteRateLimit(30), auth, async (req: AuthReq, res: Res) => {
  try {
    const { podId, taskId } = req.params || {};
    const userId = req.userId || req.user?._id || req.agentUser?._id;
    const { prUrl, notes } = (req.body || {}) as { prUrl?: string; notes?: string };
    const author = await resolveAuthor(req);
    const access = await requirePodMember(podId || '', userId, { write: true });
    if (access.error) return res.status(access.status || 500).json({ error: access.error });
    // AX entry 61 (2026-09-19): the write below filters on `status` alone, so this
    // route reported `done` through a peer's live lease. A seat must stand down; a
    // person never is. TASK-669: the row's creator may close over a live claim, and
    // the close names the claim it overrode.
    const lease = await leaseCheckForWrite(podId || '', taskId || '', req, userId, { creatorOverride: true });
    if (lease.refusal) return res.status(409).json(lease.refusal);
    const overNote = lease.overridesHolder ? ` (overrode ${lease.overridesHolder}'s live claim)` : '';
    const updateText = `${prUrl ? `Completed by ${author} · PR: ${prUrl}` : `Completed by ${author}`}${overNote}`;
    const now = new Date();
    const update = { $inc: { grantEpoch: 1 }, $set: { status: 'done', claimedByUserId: null, completedAt: now, ...(prUrl && { prUrl }), ...(notes && { notes }) }, $push: { updates: { text: updateText, author, authorId: userId?.toString() || null, createdAt: now } } };
    const task = await updateTaskWithRevision({
      podId: mongoose.Types.ObjectId.createFromHexString(podId || ''),
      taskId,
      status: { $in: ['claimed', 'pending'] },
      ...writableLeaseCondition(req, userId, now, { creatorOverride: true }),
    }, update) as { podId?: unknown; taskId?: string; status?: string; grantEpoch?: number; updates?: unknown[] } | null;
    if (!task) {
      const racedLease = await leaseCheckForWrite(podId || '', taskId || '', req, userId, { creatorOverride: true });
      if (racedLease.refusal) return res.status(409).json(racedLease.refusal);
      const existing = await Task.findOne({ podId: mongoose.Types.ObjectId.createFromHexString(podId || ''), taskId }).lean() as { status?: string } | null;
      if (!existing) return res.status(404).json({ error: 'Task not found' });
      const error = existing.status === 'done'
        ? 'Task is already done'
        : existing.status === 'blocked'
          ? 'Task is blocked; claim it first to resume work before completing it'
          : `Task cannot be completed from status '${existing.status || 'unknown'}'`;
      return res.status(409).json({ error, status: existing.status });
    }
    dispatchTaskCompleted(podId, task, prUrl);
    // A done task needs no human: close its outstanding handoff cards. The
    // PATCH gate already does this on a status change; this route wrote
    // `done` without it, and 11 of 12 open handoffs on 2026-09-19 pointed at
    // tasks completed here.
    // task.done is queued before the close hook's grant.revoked (ADR-033 §4).
    recordTaskTransition({ podId, task, from: null, to: 'done', at: now, doneBy: userId });
    await onTaskClosed(task);
    await resolveTaskAttention(task);
    emitTaskUpdated(podId, task, 'updated');
    notifyAgents(req, podId, task, 'updated', { status: 'claimed' });
    return res.json({ task });
  } catch (err) {
    console.error('POST /tasks/complete error:', err);
    return res.status(500).json({ error: 'Failed to complete task' });
  }
});

// Following is a self-service digest subscription, never task ownership.
router.post('/:podId/:taskId/watch', taskWriteRateLimit(60), auth, async (req: AuthReq, res: Res) => {
  try {
    const { podId, taskId } = req.params || {};
    const userId = req.userId || req.user?._id || req.agentUser?._id;
    const { following } = req.body || {};
    if (typeof following !== 'boolean') return res.status(400).json({ error: 'following must be a boolean' });
    const access = await requirePodMember(podId || '', userId, { memberOnly: true });
    if (access.error) return res.status(access.status || 500).json({ error: access.error });
    const task = await Task.findOneAndUpdate(
      { podId: mongoose.Types.ObjectId.createFromHexString(podId || ''), taskId },
      following ? { $addToSet: { watchers: userId } } : { $pull: { watchers: userId } },
      { new: true, timestamps: false },
    ).lean();
    if (!task) return res.status(404).json({ error: 'Task not found' });
    // Socket readers see the new follower count. No AgentEvent, attention item,
    // task revision or ownership wake is produced by a subscription change.
    emitTaskUpdated(podId, task, 'updated');
    return res.json({ task });
  } catch (error) {
    console.error('POST /tasks/watch error:', error);
    return res.status(500).json({ error: 'Failed to update task subscription' });
  }
});

router.post('/:podId/:taskId/updates', taskWriteRateLimit(60), auth, async (req: AuthReq, res: Res) => {
  try {
    const { podId, taskId } = req.params || {};
    const userId = req.userId || req.user?._id || req.agentUser?._id;
    const { text, priority } = (req.body || {}) as { text?: string; priority?: unknown };
    if (priority !== undefined && !isTaskPriority(priority)) {
      return res.status(400).json({ error: 'priority must be P0, P1, P2 or P3' });
    }
    if (!text?.trim()) return res.status(400).json({ error: 'text is required' });
    const access = await requirePodMember(podId || '', userId, { write: true });
    if (access.error) return res.status(access.status || 500).json({ error: access.error });
    if (actorOf(req).isAgent && req.body?.continueAnyway !== true) {
      const hold = await AgentSendFreshness.unseenMessages(userId, podId);
      if (hold) return res.status(409).json(hold);
    }
    if (priority !== undefined) {
      // Not creator-overridable: a priority change is a PATCH field, and the
      // override is recorded there (TASK-669).
      const refusal = (await leaseCheckForWrite(podId || '', taskId || '', req, userId)).refusal;
      if (refusal) return res.status(409).json(refusal);
    }
    const priorityUpdate = priority === undefined ? {} : { priority };
    const author = await resolveAuthor(req);
    const now = new Date();
    const note = { updates: { text: text.trim(), author, authorId: userId?.toString() || null, createdAt: now } };
    const podFilter = mongoose.Types.ObjectId.createFromHexString(podId || '');

    // #1080 part 1 (fable's ruling; @sprint-impl's shape): renewal derives
    // from WORK. A progress note is the signal a working holder naturally
    // produces, and the lease ignored it — @sprint-review measured exactly
    // that on TASK-015, where a 09:27:30 rebase note did not stop a 09:51:11
    // lapse. So a note from the holder renews; a note from anyone else does
    // not, or any passing peer could keep a dead seat's claim alive forever.
    //
    // Holder-match is evaluated SERVER-SIDE, in the filter, never from a
    // snapshot — same rule the rescue CAS follows. Two attempts rather than
    // one conditional write: the renewing form first, the note-only form as
    // fallback. The note lands either way; only the lease extension is gated.
    const claimKey = resolveAgentInstanceId(req) || userId?.toString() || '';
    let task = claimKey
      ? await updateTaskWithRevision(
        { podId: podFilter, taskId, status: 'claimed', claimedBy: claimKey },
        // `rescueDeferrals: 0` alongside the lease. Found by @sprint-review
        // (pod 56544) after #1082 shipped: the note-renewal wrote only
        // `claimExpiresAt`, so a holder who renews by posting progress —
        // the natural habit, since you write updates anyway — extended the
        // lease indefinitely while the deferral budget ticked down and never
        // came back. Three lapses later the kernel rescues them for doing
        // exactly what its own cue told them to do ("Renew by posting a task
        // update or re-claiming", offered as equivalent choices).
        //
        // Part 1 (renewal-from-work) and part 2 (the deferral budget) shipped
        // in one PR and were never composed. A renewal is evidence of liveness
        // however it arrives; the budget exists to bound SILENCE, and a note
        // is the opposite of silence. Observed live on TASK-025: note at
        // 04:35:54 moved claimExpiresAt to 05:05:54 with rescueDeferrals stuck
        // at 1.
        { $set: { ...priorityUpdate, claimExpiresAt: new Date(now.getTime() + TASK_CLAIM_LEASE_MS), rescueDeferrals: 0 }, $push: note },
      )
      : null;
    let leaseRenewed = Boolean(task);

    // Second attempt: the row was already swept back to `pending` before the
    // note arrived. The renewing filter above requires `status: 'claimed'`, so
    // it misses — and the note-only fallback below then returns 200 with no
    // lease, leaving the caller believing it renewed when it did not.
    //
    // That is not a hypothetical. The deferral warning tells the holder "post a
    // task update or re-claim — either renews the lease", and delivery latency
    // means the warning routinely ARRIVES after the sweep it was warning about.
    // Observed on TASK-029, 2026-08-22: warning written 12:24 (2 deferrals
    // left), row swept to pending 12:54, note posted 12:56 landed with
    // status still `pending` and claimedBy null. The seat only noticed because
    // it read the response body.
    //
    // `lapsedFrom` names the seat the sweep took it from, so this restores the
    // claim to its former holder and NOBODY else. If a peer claimed the row in
    // between, status is `claimed` with their id and both filters miss — the
    // race is won by the peer, which is the whole point of returning it to the
    // board. This makes the cue's two options actually equivalent.
    // `lapsedFrom` is POLYMORPHIC by design and must be matched as such. The
    // sweep writes `provenance = holder?.label || t.assignee || t.claimedBy`,
    // and `label` is itself `assignee || holder?.username || claimedBy`. So the
    // field can hold an assignee NAME, a bot USERNAME, or a User ObjectId
    // string, depending on which fallback fired.
    //
    // The first version of this matched `lapsedFrom: claimKey` — one shape —
    // and claimKey is the ObjectId for MCP-authenticated agents. Verified live
    // on TASK-029: lapsedFrom was "pod-architect" (the username) while
    // claimedBy had been "6a693bfb…", so the restore never fired and the
    // response honestly reported leaseRenewed:false. Dead code in the common
    // case, and it only had a test because the fixture set lapsedFrom to the
    // same value the test passed as the caller.
    //
    // Same name-vs-id trap as `assignee` (a name) versus `claimedBy` (an id):
    // two string fields in one document whose value spaces never overlap.
    // THREE sources, matched to what can actually be written. `lapsedFrom`
    // has exactly one value-writer — kernelWorkSweepService:279,
    // `lapsedFrom: provenance`, where
    //   provenance = holder?.label || t.assignee || t.claimedBy
    //   label      = assignee || holder?.username || claimedBy
    // so the reachable value space is {assignee, username, claimedBy}, and
    // nothing else can ever land in the column.
    //
    // Two terms have been removed for being unreachable against that space.
    // `resolveAgentInstanceId(req)` because `claimKey` above already IS it
    // when it exists and is filtered out when it does not
    // (@sprint-review 57050). And `botMetadata.agentName`, which no writer
    // ever produces — worth being glad about rather than merely tidy, since
    // for OpenClaw seats that value is the literal string 'openclaw' for
    // EVERY instance. Had it been reachable, one openclaw agent could have
    // restored another's lapsed row.
    //
    // WHAT THIS FIX SPENDS, named because it is now a precondition rather
    // than an observation (@sprint-review 57051). Matching one shape could
    // only ever MISS. A `$in` across three can MISMATCH: two of the three
    // reachable values are free strings, so a caller whose `username` equals
    // the `assignee` string on someone else's lapsed row would restore it.
    // Narrow — it needs a real collision between a username and an assignee
    // in the same pod — and it is a new failure direction, not a smaller one.
    // The next widening should know it is buying reach with precision.
    //
    // BOTH request shapes, and only the username from each. `agentRuntimeAuth`
    // assigns `req.agentUser` and never `req.user` (the standing CLAUDE.md
    // rule), so on every MCP-authenticated call — which is every seat that
    // touches this endpoint — the human term above is undefined and the list
    // collected the ObjectId alone: exactly the pre-widening state, which is
    // why TASK-029 read `leaseRenewed: false` on both sides of #1124.
    //
    // Deliberately NOT `agentUser.botMetadata.agentName` or `.instanceId`,
    // though both are now in reach. The value-space argument above rules them
    // out unchanged: no writer produces either, and `agentName` is the literal
    // string 'openclaw' for every OpenClaw seat, so making it matchable would
    // let one agent restore another's lapsed row. The agent path gets the
    // same single term the human path gets.
    //
    // One exception, and it is the BOARD NAME, not either raw field (F45). The
    // board stores an agent assignee by its board name (the instanceId, or the
    // agentName when the instance is "default"), and the sweep writes the
    // assignee into lapsedFrom first. For openclaw/nova that is `nova`, which is
    // neither its id nor its username, so its own lapsed rows never restored.
    // The board name is what the assigned-task wake already matches, so this
    // restores to the seat the board treats as assigned and no other. A shared
    // agentName like 'openclaw' is still unmatchable for any non-default seat.
    const identities = [
      claimKey,
      userId?.toString(),
      req.user?.username,
      req.agentUser?.username,
      // Read only when a restore is possible: it can cost a lookup.
      task ? undefined : await callerBoardName(req, userId),
    ].filter((v): v is string => typeof v === 'string' && v.length > 0);

    if (!task && identities.length) {
      task = await updateTaskWithRevision(
        { podId: podFilter, taskId, status: 'pending', lapsedFrom: { $in: identities } },
        {
          $set: {
            ...priorityUpdate,
            status: 'claimed',
            claimedBy: claimKey,
            // Legacy restoration matches display provenance, not an authenticated holder.
            claimedByUserId: null,
            claimedAt: now,
            claimExpiresAt: new Date(now.getTime() + TASK_CLAIM_LEASE_MS),
            rescueDeferrals: 0,
            lapsedFrom: null,
          },
          $push: note,
        },
      );
      leaseRenewed = Boolean(task);
      // A note that restores a lapsed claim is a claim, and the record says so.
      if (task) {
        recordTaskTransition({
          podId,
          task,
          from: 'pending',
          to: 'claimed',
          at: now,
          actor: requestActor(req),
          leaseUntil: task.claimExpiresAt,
        });
      }
    }

    if (!task) {
      task = await updateTaskWithRevision({ podId: podFilter, taskId, ...(priority === undefined ? {} : writableLeaseCondition(req, userId, now)) },
        { $set: priorityUpdate, $push: note });
    }
    if (!task) {
      const existing = await Task.findOne({ podId: podFilter, taskId }).select('_id').lean();
      return existing
        ? res.status(409).json({ error: 'Task changed concurrently; retry' })
        : res.status(404).json({ error: 'Task not found' });
    }
    await recordTaskAttention(task);
    emitTaskUpdated(podId, task, 'updated');
    notifyAgents(req, podId, task, 'updated');
    // Reported explicitly. A note that did not renew is a legitimate outcome
    // (a peer now holds the row, or you never did), but it must never be
    // indistinguishable from one that did — that silence is the whole bug.
    return res.json({ task, leaseRenewed });
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
    const allowed = ['title', 'priority', 'assignee', 'dep', 'depMockOk', 'parentTask', 'status', 'notes', 'prUrl'];
    const fieldUpdates: Record<string, unknown> = {};
    const body = (req.body || {}) as Record<string, unknown>;
    allowed.forEach((k) => { if (body[k] !== undefined) fieldUpdates[k] = body[k]; });
    if (fieldUpdates.priority !== undefined && !isTaskPriority(fieldUpdates.priority)) {
      return res.status(400).json({ error: 'priority must be P0, P1, P2 or P3' });
    }
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
    if (fieldUpdates.title !== undefined) {
      if (typeof fieldUpdates.title !== 'string') return res.status(400).json({ error: 'title must be a string' });
      fieldUpdates.title = toSingleLineTitle(fieldUpdates.title);
      if (!fieldUpdates.title) return res.status(400).json({ error: 'title is required' });
    }
    if (typeof fieldUpdates.assignee === 'string') {
      const parsed = parseAssignee(fieldUpdates.assignee);
      if (parsed.error) return res.status(400).json({ error: parsed.error });
      fieldUpdates.assignee = parsed.value;
    }
    if (Object.keys(fieldUpdates).length === 0) return res.status(400).json({ error: 'No updatable fields provided' });
    if (fieldUpdates.status !== undefined) {
      const raw = String(fieldUpdates.status).trim().toLowerCase();
      const normalized = TASK_STATUS_ALIASES[raw] || raw;
      if (!VALID_TASK_STATUSES.includes(normalized)) {
        return res.status(400).json({
          error: `status must be one of ${VALID_TASK_STATUSES.join('|')} (got '${fieldUpdates.status}'). `
            + 'Aliases accepted: completed→done, todo→pending.',
        });
      }
      // A seat cannot PATCH a claim. A claim is a lease, and this route writes none for a
      // seat, so the row would sit `claimed` under a lease nobody renews. A person's Start
      // is still a PATCH: it writes no lease, and any lease the row carries stays as it is.
      // Whether a Start should carry a lease is TASK-723.
      if (normalized === 'claimed' && isSeatCaller(req)) {
        return res.status(400).json({ error: "status 'claimed' takes a lease: claim the row with commonly_claim_task (POST /:podId/:taskId/claim)" });
      }
      fieldUpdates.status = normalized;
      if (normalized !== 'claimed') fieldUpdates.claimedByUserId = null;
    }
    const access = await requirePodMember(podId || '', userId, { write: true });
    if (access.error) return res.status(access.status || 500).json({ error: access.error });
    // Same guard as /complete. PATCH is the wider hole of the two: it is how the
    // board editor and the openclaw `commonly_update_task` retitle or reassign a
    // row. The note-append route above is deliberately NOT gated — a note on
    // someone else's row is the coordination a claim exists to enable, and posting
    // one is also how a holder renews. The row's creator may edit over a live claim
    // (TASK-669), and the edit names the claim it overrode.
    const lease = await leaseCheckForWrite(podId || '', taskId || '', req, userId, { creatorOverride: true });
    if (lease.refusal) return res.status(409).json(lease.refusal);
    if (typeof fieldUpdates.assignee === 'string') {
      fieldUpdates.assignee = await canonicalAssignee(podId || '', fieldUpdates.assignee);
    }
    // A PATCH to done on a row that is already done is not a second completion. It keeps
    // the original completedAt and fires no close side effects; the other fields in the
    // same PATCH still apply. The write filter below makes the transition itself atomic.
    if (fieldUpdates.status === 'done') {
      const current = await Task.findOne({ podId: mongoose.Types.ObjectId.createFromHexString(podId || ''), taskId });
      if (current?.status === 'done') {
        delete fieldUpdates.status;
        delete fieldUpdates.claimedByUserId;
        if (Object.keys(fieldUpdates).length === 0) return res.json({ task: current });
      }
    }
    const author = await resolveAuthor(req);
    const needsPriorOwner = fieldUpdates.assignee !== undefined || fieldUpdates.status !== undefined;
    const changeParts: string[] = [];
    if (fieldUpdates.assignee !== undefined) changeParts.push(`reassigned to ${fieldUpdates.assignee || 'unassigned'}`);
    if (fieldUpdates.status !== undefined) changeParts.push(`status → ${fieldUpdates.status}`);
    if (fieldUpdates.dep !== undefined) changeParts.push(`dep → ${fieldUpdates.dep || 'none'}`);
    if (fieldUpdates.parentTask !== undefined) changeParts.push(`parent → ${fieldUpdates.parentTask || 'none'}`);
    if (fieldUpdates.prUrl !== undefined) changeParts.push(`PR: ${fieldUpdates.prUrl}`);
    if (fieldUpdates.notes !== undefined) changeParts.push('notes updated');
    if (fieldUpdates.priority !== undefined) changeParts.push(`priority → ${fieldUpdates.priority}`);
    if (fieldUpdates.title !== undefined) changeParts.push('title updated');
    if (lease.overridesHolder) changeParts.push(`overrode ${lease.overridesHolder}'s live claim`);
    let writeTime = needsPriorOwner ? new Date() : null;
    // A done row carries its completion time, as `complete` writes it (CodeRabbit, #3089).
    if (fieldUpdates.status === 'done') fieldUpdates.completedAt = writeTime;
    const update: Record<string, unknown> = {
      $set: writeTime ? { ...fieldUpdates, updatedAt: writeTime } : fieldUpdates,
    };
    if (fieldUpdates.status === 'done') update.$inc = { grantEpoch: 1 };
    if (changeParts.length > 0) update.$push = { updates: { text: `${author} updated: ${changeParts.join(', ')}`, author, authorId: userId?.toString() || null, createdAt: new Date() } };
    const taskFilter = {
      podId: mongoose.Types.ObjectId.createFromHexString(podId || ''),
      taskId,
      ...writableLeaseCondition(req, userId, new Date(), { creatorOverride: true }),
      // Only a row that is not done yet can move into done, so completedAt, the grant
      // epoch and the close hooks fire once even when two PATCHes race.
      ...(fieldUpdates.status === 'done' ? { status: { $ne: 'done' } } : {}),
    };
    let task = null;
    let racedRevision = false;
    // The pre-image names the exact prior owner. Also keep updatedAt strictly
    // increasing if a second writer commits while this request waits for Mongo.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      // eslint-disable-next-line no-await-in-loop
      task = needsPriorOwner
        // eslint-disable-next-line no-await-in-loop
        ? await Task.findOneAndUpdate(
          { ...taskFilter, updatedAt: { $lt: writeTime } },
          update,
          { new: false, timestamps: false },
        )
        // eslint-disable-next-line no-await-in-loop
        : await updateTaskWithRevision(taskFilter, update);
      if (task || !needsPriorOwner) break;
      // eslint-disable-next-line no-await-in-loop
      const current = await Task.findOne({ podId: taskFilter.podId, taskId }).select('updatedAt').lean();
      if (!current) break;
      racedRevision = true;
      writeTime = new Date(Math.max(Date.now(), current.updatedAt.getTime() + 1));
      (update.$set as Record<string, unknown>).updatedAt = writeTime;
      if (fieldUpdates.status === 'done') (update.$set as Record<string, unknown>).completedAt = writeTime;
    }
    if (!task) {
      const racedLease = await leaseCheckForWrite(podId || '', taskId || '', req, userId, { creatorOverride: true });
      if (racedLease.refusal) return res.status(409).json(racedLease.refusal);
      if (racedRevision) return res.status(409).json({ error: 'Task changed concurrently; retry' });
      if (!needsPriorOwner) {
        const existing = await Task.findOne({ podId: taskFilter.podId, taskId }).select('_id').lean();
        if (existing) return res.status(409).json({ error: 'Task changed concurrently; retry' });
      }
      return res.status(404).json({ error: 'Task not found' });
    }
    // For ownership/status writes, the atomic update returns its pre-image.
    // A separate read can race a second writer and wake a stale owner. Capture
    // the pre-image before projecting this successful write onto the response.
    const previousTask = needsPriorOwner
      ? { assignee: task.assignee, claimedBy: task.claimedBy, status: task.status }
      : null;
    if (needsPriorOwner) {
      if (typeof task.set === 'function') task.set(fieldUpdates);
      else Object.assign(task, fieldUpdates);
      if (update.$push) {
        if (!task.updates) task.updates = [];
        task.updates.push((update.$push as { updates: unknown }).updates);
      }
      task.updatedAt = writeTime;
    }
    // Before the close hook, so task.done precedes its grant.revoked (ADR-033 §4).
    if (fieldUpdates.status !== undefined && previousTask && writeTime) {
      recordTaskTransition({
        podId,
        task,
        from: previousTask.status,
        to: String(fieldUpdates.status),
        at: writeTime,
        actor: requestActor(req),
        doneBy: userId,
      });
    }
    if (fieldUpdates.status === 'blocked') await recordTaskAttention(task, { includeBlocked: true });
    if (fieldUpdates.status === 'done') {
      task.grantEpoch = (task.grantEpoch || 0) + 1;
      await onTaskClosed(task);
      // Only the transition into done announces the completion; a repeated PATCH to done does not.
      if (previousTask?.status !== 'done') dispatchTaskCompleted(podId, task, null);
    }
    if (fieldUpdates.status !== undefined && fieldUpdates.status !== 'blocked') await resolveTaskAttention(task);
    emitTaskUpdated(podId, task, 'updated');
    notifyAgents(req, podId, task, 'updated', previousTask);
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
// The native runtime's commonly_claim_task claims through the same function (TASK-340).
module.exports.claimTaskAs = claimTaskAs;
module.exports.claimantOf = claimantOf;

export {};
