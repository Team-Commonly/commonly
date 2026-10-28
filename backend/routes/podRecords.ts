import express from 'express';
import rateLimit from 'express-rate-limit';
import mongoose from 'mongoose';
import { cloudflareIpRateLimitKeyGenerator } from '../middleware/ipRateLimit';
import { MAX_PAGE_LINES } from '../repositories/recordChainRepository';
import {
  isRecordEnabled, readRecordExport, RecordStoreUnavailableError, toOtlp, type ChainPage,
} from '../services/recordService';

/* eslint-disable @typescript-eslint/no-require-imports, global-require */
const auth = require('../middleware/dualAuth');
const Pod = require('../models/Pod');
const Task = require('../models/Task');
const DMService = require('../services/dmService');
/* eslint-enable @typescript-eslint/no-require-imports, global-require */

const router = express.Router();
const recordReadLimit = rateLimit({
  windowMs: 60_000, limit: 120, standardHeaders: 'draft-7', legacyHeaders: false,
  keyGenerator: cloudflareIpRateLimitKeyGenerator,
});

// Task ids are board tokens (TASK-513); anything else is refused before a read.
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;

type RecordReq = express.Request & {
  userId?: unknown;
  user?: { _id?: unknown };
  agentUser?: { _id?: unknown };
};

const notFound = (res: express.Response) => res.status(404).json({ error: 'record_not_found' });

// A page cursor: `after` is a seq (0 is the start), `limit` 1..MAX_PAGE_LINES.
const SEQ = /^\d{1,9}$/;
const readPage = (query: express.Request['query']): ChainPage | null => {
  const { after, limit } = query;
  if (after !== undefined && (typeof after !== 'string' || !SEQ.test(after))) return null;
  if (limit !== undefined && (typeof limit !== 'string' || !SEQ.test(limit)
    || Number(limit) < 1 || Number(limit) > MAX_PAGE_LINES)) return null;
  return {
    ...(after !== undefined ? { after: Number(after) } : {}),
    ...(limit !== undefined ? { limit: Number(limit) } : {}),
  };
};

/**
 * A chain as record-v1 JSONL, or `?format=otlp` for the spec's OTLP/JSON
 * export. `taskId` null is the pod's taskless chain (grants and the calls
 * made under them).
 *
 * Access follows today's pod access (canViewPod), checked before any record
 * byte is loaded, and fails as not-found so the route never confirms a pod or
 * task. Lines then go to actual members only: they carry approver and
 * credential-owner ids verbatim, and a hash-chained line can't be redacted
 * without breaking verification. That is the same set runTraces shows those
 * ids to, so admins and agent-DM observers who pass canViewPod get a 403.
 *
 * One read returns at most MAX_PAGE_LINES lines after `?after=<seq>`. While
 * more remain, `X-Record-Next-After` names the cursor for the next page; the
 * head headers always describe the whole chain.
 */
const serveRecord = async (req: RecordReq, res: express.Response, taskId: string | null) => {
  try {
    const { podId } = req.params;
    if (!mongoose.isObjectIdOrHexString(podId) || (taskId !== null && !TASK_ID.test(taskId))) return notFound(res);
    const page = readPage(req.query);
    if (!page) return res.status(400).json({ error: 'record_bad_cursor' });
    if (!isRecordEnabled(podId)) return notFound(res);
    const userId = req.userId || req.user?._id || req.agentUser?._id;
    const pod = await Pod.findById(podId).select('members type').lean();
    if (!pod || !await DMService.canViewPod(userId, pod)) return notFound(res);
    // Lean and unpopulated, so members are ObjectIds.
    const isMember = (pod.members || []).some((member: unknown) => String(member) === String(userId));
    if (!isMember) return res.status(403).json({ error: 'record_requires_membership' });
    if (taskId !== null && !await Task.findOne({ podId: pod._id, taskId }).select('_id').lean()) return notFound(res);

    let record;
    try {
      const ref = { podId: String(pod._id), ...(taskId !== null ? { taskId } : {}) };
      record = await readRecordExport(ref, undefined, page);
    } catch (error) {
      // A store outage is an error, never an apparently empty record.
      if (!(error instanceof RecordStoreUnavailableError)) {
        const err = error as Error;
        console.error('[record] read failed:', err.name, String(err.message || '').slice(0, 160));
      }
      return res.status(503).json({ error: 'record_store_unavailable' });
    }
    res.set('Cache-Control', 'no-store');
    res.set('X-Record-Entries', String(record.entries));
    // The spec's outside record of the head (§4): it covers the last line.
    if (record.head) res.set('X-Record-Head', record.head);
    if (record.runId) res.set('X-Record-Run-Id', record.runId);
    if (record.nextAfter !== null) res.set('X-Record-Next-After', String(record.nextAfter));
    if (req.query.format === 'otlp') return res.json(toOtlp(record.jsonl));
    res.type('application/x-ndjson; charset=utf-8');
    return res.send(record.jsonl);
  } catch (error) {
    console.error('GET /record error:', (error as Error).name, String((error as Error).message || '').slice(0, 160));
    return res.status(500).json({ error: 'Failed to read record' });
  }
};

router.get('/:podId/record/tasks/:taskId', recordReadLimit, auth, (req: RecordReq, res: express.Response) => (
  serveRecord(req, res, String(req.params.taskId))
));
router.get('/:podId/record', recordReadLimit, auth, (req: RecordReq, res: express.Response) => (
  serveRecord(req, res, null)
));

module.exports = router;
