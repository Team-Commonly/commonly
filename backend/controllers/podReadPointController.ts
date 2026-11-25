/* eslint-disable @typescript-eslint/no-require-imports */
// GET/PUT /api/pods/:id/read-point (first minute back). A member reads and
// moves their OWN read point in the pod's main channel. The person is always
// the authenticated caller; nothing in the request can name another one.
const PodReadPoint = require('../models/pg/PodReadPoint');
const { getCallerId, callerHasPodWriteAccess } = require('../services/podWriteAccessService');
const { parseReadAt } = require('./threadStateController');
const { seedPodReadPoint } = require('../services/podReadPointSeed');
const { logOutboundFailure } = require('../utils/safeErrorLog');

interface Req {
  params: { id?: string };
  body?: { at?: unknown };
  user?: { _id?: unknown };
  userId?: unknown;
  agentUser?: { _id?: unknown };
}
interface Res {
  status: (n: number) => Res;
  json: (d: unknown) => void;
}

// Membership decides, the same check the thread read point uses. Read-only
// viewers of an agent-dm are not members, so they get a 403 and the client
// simply opens the pod at its end.
async function authorize(req: Req, res: Res): Promise<{ podId: string; userId: string } | null> {
  const userId = getCallerId(req);
  if (!userId) {
    res.status(401).json({ msg: 'auth required' });
    return null;
  }
  const podId = String(req.params.id || '');
  if (!(await callerHasPodWriteAccess(podId, userId, req as never))) {
    res.status(403).json({ msg: 'not a member of this pod' });
    return null;
  }
  return { podId, userId };
}

export async function getPodReadPoint(req: Req, res: Res): Promise<void> {
  try {
    const ctx = await authorize(req, res);
    if (!ctx) return;
    let lastReadAt = await PodReadPoint.get(ctx.podId, ctx.userId);
    if (!lastReadAt) {
      // First visit since read points shipped: seed one from what this member
      // already did in the pod. Never last-active here, because opening the
      // pod just moved it to now. A failed seed opens the pod at its end.
      try {
        lastReadAt = await seedPodReadPoint({ podId: ctx.podId, userId: ctx.userId });
      } catch (err: any) {
        console.warn('[pod-read-point] seed failed:', err?.message);
        lastReadAt = null;
      }
    }
    res.status(200).json({ podId: ctx.podId, lastReadAt });
  } catch (err: any) {
    logOutboundFailure('getPodReadPoint failed:', err);
    res.status(500).json({ msg: 'failed to read the read point', error: 'Internal server error' });
  }
}

export async function setPodReadPoint(req: Req, res: Res): Promise<void> {
  try {
    const at = parseReadAt((req.body || {}).at);
    if (!at) {
      res.status(400).json({ msg: 'at (ISO 8601 date-time) is required' });
      return;
    }
    const ctx = await authorize(req, res);
    if (!ctx) return;
    const lastReadAt = await PodReadPoint.markRead(ctx.podId, ctx.userId, at);
    res.status(200).json({ podId: ctx.podId, lastReadAt });
  } catch (err: any) {
    logOutboundFailure('setPodReadPoint failed:', err);
    res.status(500).json({ msg: 'failed to set the read point', error: 'Internal server error' });
  }
}

module.exports = { getPodReadPoint, setPodReadPoint };
Object.assign(module.exports, exports);
