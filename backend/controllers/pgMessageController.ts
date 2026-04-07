import type { Request, Response } from 'express';

// eslint-disable-next-line global-require
const PGPod = require('../models/pg/Pod');
// eslint-disable-next-line global-require
const PGMessage = require('../models/pg/Message');
// eslint-disable-next-line global-require
const MongoPod = require('../models/Pod');

interface AuthRequest extends Request {
  userId?: string;
  user?: { id: string };
}

async function syncPodFromMongo(podId: string, requestingUserId: string): Promise<unknown> {
  const mongoPod = await MongoPod.findById(podId).lean() as {
    name?: string;
    description?: string;
    type?: string;
  } | null;
  if (!mongoPod) return null;
  return PGPod.create(
    mongoPod.name,
    mongoPod.description || '',
    mongoPod.type || 'chat',
    requestingUserId,
    podId,
  );
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

    console.log(`Checking message access for pod ${podId} by user ${userId}`);

    const isMember = await PGPod.isMember(podId, userId);
    if (!isMember) {
      console.error(`User ${userId} is not a member of pod ${podId}`);
      try {
        console.log(`Attempting to resolve membership for user ${userId} in pod ${podId}`);
        await PGPod.addMember(podId, userId);
        const verifyMembership = await PGPod.isMember(podId, userId);
        if (verifyMembership) {
          console.log(`Successfully resolved membership for user ${userId} in pod ${podId}`);
        } else {
          console.error(`Failed to resolve membership for user ${userId} in pod ${podId}`);
          res.status(401).json({ msg: 'Not authorized to view messages in this pod' });
          return;
        }
      } catch (membershipError) {
        const me = membershipError as { message?: string };
        console.error(`Error resolving membership: ${me.message}`);
        res.status(401).json({ msg: 'Not authorized to view messages in this pod' });
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

    const isMember = await PGPod.isMember(podId, userId);
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
