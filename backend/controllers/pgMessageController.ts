import type { Request, Response } from 'express';

// eslint-disable-next-line global-require
const PGPod = require('../models/pg/Pod');
// eslint-disable-next-line global-require
const PGMessage = require('../models/pg/Message');
// eslint-disable-next-line global-require
const MongoPod = require('../models/Pod');
// eslint-disable-next-line global-require
const { syncPodFromMongo } = require('../services/pgPodSyncService');

interface AuthRequest extends Request {
  userId?: string;
  user?: { id: string };
}

// Check if user is a member via PG, falling back to MongoDB as source of truth
async function isMemberWithFallback(podId: string, userId: string): Promise<boolean> {
  const pgMember = await PGPod.isMember(podId, userId);
  if (pgMember) return true;
  // Fall back to MongoDB (may throw CastError for invalid ObjectId — treat as not found)
  try {
    const mongoPod = await MongoPod.findById(podId).lean() as {
      members?: Array<{ toString(): string }>;
    } | null;
    if (!mongoPod) return false;
    const inMongo = (mongoPod.members || []).some((m) => m.toString() === userId.toString());
    if (inMongo) {
      // Sync this member to PG for future requests
      await PGPod.addMember(podId, userId).catch(() => {});
    }
    return inMongo;
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

    let pod = await PGPod.findById(podId);
    if (!pod) {
      pod = await syncPodFromMongo(podId, userId);
      if (!pod) {
        res.status(404).json({ msg: 'Pod not found' });
        return;
      }
    }

    const isMember = await isMemberWithFallback(podId, userId);
    if (!isMember) {
      res.status(401).json({ msg: 'Not authorized to view messages in this pod' });
      return;
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

    const isMember = await isMemberWithFallback(podId, userId);
    if (!isMember) {
      res.status(401).json({ msg: 'Not authorized to post in this pod' });
      return;
    }

    const newMessage = await PGMessage.create(podId, userId, content);
    const message = await PGMessage.findById(newMessage.id);
    res.json(message);
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
