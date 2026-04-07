import type { Request, Response } from 'express';

// eslint-disable-next-line global-require
const PGPod = require('../models/pg/Pod');
// eslint-disable-next-line global-require
const PGMessage = require('../models/pg/Message');

interface AuthRequest extends Request {
  user?: { id: string };
}

exports.getAllPods = async (req: Request, res: Response): Promise<void> => {
  try {
    const { type } = req.query as { type?: string };
    const pods = await PGPod.findAll(type);
    res.json(pods);
  } catch (err) {
    const e = err as { message?: string };
    console.error(e.message);
    res.status(500).send('Server Error');
  }
};

exports.getPodById = async (req: Request, res: Response): Promise<void> => {
  try {
    const pod = await PGPod.findById(req.params.id);
    if (!pod) {
      res.status(404).json({ msg: 'Pod not found' });
      return;
    }
    res.json(pod);
  } catch (err) {
    const e = err as { message?: string; kind?: string };
    console.error(e.message);
    if (e.kind === 'ObjectId') {
      res.status(404).json({ msg: 'Pod not found' });
      return;
    }
    res.status(500).send('Server Error');
  }
};

exports.createPod = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { name, description, type } = req.body as { name?: string; description?: string; type?: string };
    const newPod = await PGPod.create(name, description, type, req.user?.id);
    res.json(newPod);
  } catch (err) {
    const e = err as { message?: string };
    console.error(e.message);
    res.status(500).send('Server Error');
  }
};

exports.updatePod = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { name, description } = req.body as { name?: string; description?: string };
    const pod = await PGPod.findById(req.params.id);
    if (!pod) {
      res.status(404).json({ msg: 'Pod not found' });
      return;
    }
    if ((pod as { created_by: string }).created_by !== req.user?.id) {
      res.status(401).json({ msg: 'Not authorized to update this pod' });
      return;
    }
    const updatedPod = await PGPod.update(req.params.id, name, description);
    res.json(updatedPod);
  } catch (err) {
    const e = err as { message?: string; kind?: string };
    console.error(e.message);
    if (e.kind === 'ObjectId') {
      res.status(404).json({ msg: 'Pod not found' });
      return;
    }
    res.status(500).send('Server Error');
  }
};

exports.deletePod = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const pod = await PGPod.findById(req.params.id);
    if (!pod) {
      res.status(404).json({ msg: 'Pod not found' });
      return;
    }
    if ((pod as { created_by: string }).created_by !== req.user?.id) {
      res.status(401).json({ msg: 'Not authorized to delete this pod' });
      return;
    }
    await PGMessage.deleteByPodId(req.params.id);
    await PGPod.delete(req.params.id);
    res.json({ msg: 'Pod deleted' });
  } catch (err) {
    const e = err as { message?: string; kind?: string };
    console.error(e.message);
    if (e.kind === 'ObjectId') {
      res.status(404).json({ msg: 'Pod not found' });
      return;
    }
    res.status(500).send('Server Error');
  }
};

exports.joinPod = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    console.log('Join pod request received:', {
      podId: req.params.id,
      userId: req.user?.id,
      userIdType: typeof req.user?.id,
    });

    const pod = await PGPod.findById(req.params.id);
    if (!pod) {
      res.status(404).json({ msg: 'Pod not found' });
      return;
    }

    const isMember = await PGPod.isMember(req.params.id, req.user?.id);
    if (isMember) {
      console.log(`User ${req.user?.id} is already a member of pod ${req.params.id}`);
      const updatedPod = await PGPod.findById(req.params.id);
      res.json(updatedPod);
      return;
    }

    await PGPod.addMember(req.params.id, req.user?.id);
    console.log(`User ${req.user?.id} successfully added to pod ${req.params.id}`);

    const membershipVerified = await PGPod.isMember(req.params.id, req.user?.id);
    if (!membershipVerified) {
      console.error(`Failed to verify membership after adding user ${req.user?.id} to pod ${req.params.id}`);
    }

    const updatedPod = await PGPod.findById(req.params.id);
    res.json(updatedPod);
  } catch (err) {
    const e = err as { message?: string; kind?: string };
    console.error('Error in pgPodController.joinPod:', e.message);
    console.error('Request details:', {
      podId: req.params.id,
      userId: (req as AuthRequest).user?.id || 'undefined',
    });
    if (e.kind === 'ObjectId') {
      res.status(404).json({ msg: 'Pod not found' });
      return;
    }
    res.status(500).send('Server Error');
  }
};

exports.leavePod = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const pod = await PGPod.findById(req.params.id);
    if (!pod) {
      res.status(404).json({ msg: 'Pod not found' });
      return;
    }
    if ((pod as { created_by: string }).created_by === req.user?.id) {
      res.status(400).json({ msg: 'Pod creator cannot leave the pod' });
      return;
    }
    await PGPod.removeMember(req.params.id, req.user?.id);
    res.json({ msg: 'Left pod successfully' });
  } catch (err) {
    const e = err as { message?: string; kind?: string };
    console.error(e.message);
    if (e.kind === 'ObjectId') {
      res.status(404).json({ msg: 'Pod not found' });
      return;
    }
    res.status(500).send('Server Error');
  }
};
