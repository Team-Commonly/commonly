import express from 'express';
import rateLimit from 'express-rate-limit';
import mongoose from 'mongoose';
import { cloudflareIpRateLimitKeyGenerator } from '../middleware/ipRateLimit';
import {
  isRecordEnabled, readRecordExport, RecordStoreUnavailableError, toOtlp,
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

/**
 * One task's record as record-v1 JSONL, or `?format=otlp` for the spec's
 * OTLP/JSON export.
 *
 * Access follows today's pod access (canViewPod), checked before any record
 * byte is loaded, and fails as not-found so the route never confirms a pod or
 * task. Lines then go to actual members only: they carry approver and
 * credential-owner ids verbatim, and a hash-chained line can't be redacted
 * without breaking verification. That is the same set runTraces shows those
 * ids to, so admins and agent-DM observers who pass canViewPod get a 403.
 */
router.get('/:podId/record/tasks/:taskId', recordReadLimit, auth, async (req: RecordReq, res) => {
  try {
    const { podId, taskId } = req.params;
    if (!mongoose.isObjectIdOrHexString(podId) || !TASK_ID.test(String(taskId))) return notFound(res);
    if (!isRecordEnabled(podId)) return notFound(res);
    const userId = req.userId || req.user?._id || req.agentUser?._id;
    const pod = await Pod.findById(podId).select('members type').lean();
    if (!pod || !await DMService.canViewPod(userId, pod)) return notFound(res);
    // Lean and unpopulated, so members are ObjectIds.
    const isMember = (pod.members || []).some((member: unknown) => String(member) === String(userId));
    if (!isMember) return res.status(403).json({ error: 'record_requires_membership' });
    const task = await Task.findOne({ podId: pod._id, taskId }).select('_id').lean();
    if (!task) return notFound(res);

    let record;
    try {
      record = await readRecordExport({ podId: String(pod._id), taskId: String(taskId) });
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
    if (req.query.format === 'otlp') return res.json(toOtlp(record.jsonl));
    res.type('application/x-ndjson; charset=utf-8');
    return res.send(record.jsonl);
  } catch (error) {
    console.error('GET /record error:', (error as Error).name, String((error as Error).message || '').slice(0, 160));
    return res.status(500).json({ error: 'Failed to read record' });
  }
});

module.exports = router;
