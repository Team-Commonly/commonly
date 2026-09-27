import type { Request, Response } from 'express';

// eslint-disable-next-line global-require
const PGPod = require('../models/pg/Pod');
// eslint-disable-next-line global-require
const PGMessage = require('../models/pg/Message');
// eslint-disable-next-line global-require
const { isListedPodMember } = require('../utils/isPodMember');
// eslint-disable-next-line global-require
const MongoPod = require('../models/Pod');
// eslint-disable-next-line global-require
const { deliverMessageToAgents } = require('../services/messageAgentDeliveryService');
// eslint-disable-next-line global-require
const { syncPodFromMongo } = require('../services/pgPodSyncService');

interface AuthRequest extends Request {
  userId?: string;
  user?: { id: string; username?: string };
}

type CreatedMessage = {
  _id?: string;
  id?: string;
  content?: string;
  text?: string;
  messageType?: string;
  message_type?: string;
  createdAt?: unknown;
  created_at?: unknown;
  username?: string;
  user?: { username?: string };
  userId?: { username?: string } | string;
};

// Mongo `members` is the membership truth for the PG chat path (TASK-162). The
// PG `pod_members` row is a lazily-synced mirror, and it used to be trusted as
// proof: `PGPod.create` inserts the owner unconditionally and `syncPodFromMongo`
// backfills Mongo's `createdBy`, so a leave plus any later backfill re-created a
// row for someone no longer in the pod. Measured read-only on production
// (Vera 74648, 727 rows): 77 rows present in PG and absent from their pod's
// Mongo `members` — 36 of them the pod's own creator — plus 140 rows pointing at
// a pod id Mongo does not have, which passed membership because the fallback
// never consulted Mongo. Reading Mongo at request time settles both classes,
// and the stored-row cleanup is a separate script.
//
// The rule is the one `createMessage` runs (controllers/messageController.ts):
// `pod.members` alone. A PG write must not admit anyone the pod's own write path
// would refuse.
async function isPodMemberInMongo(podId: string, userId: string): Promise<boolean> {
  try {
    // CastError for a malformed id and a null row for a pod Mongo no longer has
    // both mean "not a member" rather than an error.
    const mongoPod = await MongoPod.findById(podId).select('members').lean();
    if (!isListedPodMember(mongoPod, userId)) return false;
    // Warm the mirror the PG listings still read. This write grants nothing:
    // the row was the defect, not the fix. Failure to warm a cache must not deny
    // a member either, so it is swallowed rather than failing the request — and
    // it is awaited, not detached, so a rejection cannot surface as an
    // unhandled one.
    try {
      await PGPod.addMember(podId, userId);
    } catch {
      // cache write only
    }
    return true;
  } catch {
    return false;
  }
}

exports.getMessages = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { podId } = req.params;
    const { limit = 50, before } = req.query as { limit?: number; before?: string };

    if (!podId) {
      res.status(400).json({ msg: 'Pod ID is required' });
      return;
    }

    const userId = req.userId || req.user?.id;
    if (!userId) {
      res.status(401).json({ msg: 'User authentication failed' });
      return;
    }

    // Order matters. syncPodFromMongo inserts the pod's owner into pod_members
    // as a side effect of PGPod.create, so backfilling BEFORE the membership
    // check let a non-member manufacture the very row the check then read back
    // — a complete read bypass on any pod not yet mirrored into PG. Existence
    // is resolved first (read-only, so it cannot grant anything) to preserve
    // the 404-for-missing / 401-for-non-member contract, then authorization,
    // and only then the backfill.
    let pod = await PGPod.findById(podId);
    if (!pod) {
      const mongoPod = await MongoPod.findById(podId).select('_id').lean();
      if (!mongoPod) {
        res.status(404).json({ msg: 'Pod not found' });
        return;
      }
    }

    const isMember = await isPodMemberInMongo(podId, userId);
    if (!isMember) {
      res.status(401).json({ msg: 'Not authorized to view messages in this pod' });
      return;
    }

    if (!pod) {
      pod = await syncPodFromMongo(podId, userId);
      if (!pod) {
        res.status(404).json({ msg: 'Pod not found' });
        return;
      }
    }

    const messages = await PGMessage.findByPodId(podId, limit, before);
    res.json(messages);
  } catch (err) {
    const e = err as { message?: string; kind?: string };
    console.error('Error in PG getMessages:', e.message);
    if (e.kind === 'ObjectId') {
      res.status(404).json({ msg: 'Pod not found' });
      return;
    }
    res.status(500).send('Server Error');
  }
};

exports.createMessage = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { podId } = req.params;
    const { content } = req.body as { content?: string };

    if (!podId) {
      res.status(400).json({ msg: 'Pod ID is required' });
      return;
    }

    const userId = req.userId || req.user?.id;
    if (!userId) {
      res.status(401).json({ msg: 'User authentication failed' });
      return;
    }

    const pod = (await PGPod.findById(podId)) || (await syncPodFromMongo(podId, userId));
    if (!pod) {
      res.status(404).json({ msg: 'Pod not found' });
      return;
    }

    const isMember = await isPodMemberInMongo(podId, userId);
    if (!isMember) {
      res.status(401).json({ msg: 'Not authorized to post in this pod' });
      return;
    }

    const newMessage = await PGMessage.create(podId, userId, content);
    // Match the primary controller: the post-write JOIN supplies the author
    // for the response and wake frame, while the INSERT row remains a valid
    // persisted-message fallback if that re-read is unavailable.
    const message = ((await PGMessage.findById(newMessage.id)) || newMessage) as CreatedMessage;

    // This endpoint is older than the PG-primary /api/messages path, but it
    // still writes the same user-authored messages. It has no reply-edge
    // request field, so deliberately omit replyToMessageId here; the shared
    // delivery service distinguishes omission from the primary route's null.
    const responseMessage = await deliverMessageToAgents({
      podId,
      podType: pod.type,
      message,
      userId,
      requestUser: req.user,
    });

    res.json(responseMessage);
  } catch (err) {
    const e = err as { message?: string; kind?: string };
    console.error('Error in PG createMessage:', e.message);
    if (e.kind === 'ObjectId') {
      res.status(404).json({ msg: 'Pod not found' });
      return;
    }
    res.status(500).send('Server Error');
  }
};

exports.updateMessage = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { content } = req.body as { content?: string };
    const message = await PGMessage.findById(req.params.id) as { user_id?: string } | null;
    if (!message) {
      res.status(404).json({ msg: 'Message not found' });
      return;
    }
    if (message.user_id !== req.user?.id) {
      res.status(401).json({ msg: 'Not authorized to update this message' });
      return;
    }
    const updatedMessage = await PGMessage.update(req.params.id, content);
    res.json(updatedMessage);
  } catch (err) {
    const e = err as { message?: string; kind?: string };
    console.error(e.message);
    if (e.kind === 'ObjectId') {
      res.status(404).json({ msg: 'Message not found' });
      return;
    }
    res.status(500).send('Server Error');
  }
};

exports.deleteMessage = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    if (!id) {
      res.status(400).json({ msg: 'Message ID is required' });
      return;
    }

    const message = await PGMessage.findById(id) as { user_id?: string; pod_id?: string } | null;
    if (!message) {
      res.status(404).json({ msg: 'Message not found' });
      return;
    }

    const userId = req.userId || req.user?.id;
    if (!userId) {
      res.status(401).json({ msg: 'User authentication failed' });
      return;
    }

    if (message.user_id !== userId) {
      const pod = await PGPod.findById(message.pod_id) as { created_by?: string } | null;
      if (!pod || pod.created_by !== userId) {
        res.status(401).json({ msg: 'Not authorized to delete this message' });
        return;
      }
    }

    await PGMessage.delete(id);
    res.json({ msg: 'Message deleted' });
  } catch (err) {
    const e = err as { message?: string; kind?: string };
    console.error('Error in PG deleteMessage:', e.message);
    if (e.kind === 'ObjectId') {
      res.status(404).json({ msg: 'Message not found' });
      return;
    }
    res.status(500).send('Server Error');
  }
};
