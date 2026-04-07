import type { Request, Response } from 'express';

// eslint-disable-next-line global-require
const Pod = require('../models/Pod');
// eslint-disable-next-line global-require
const Message = require('../models/Message');
// eslint-disable-next-line global-require
const Post = require('../models/Post');
// eslint-disable-next-line global-require
const Summary = require('../models/Summary');
// eslint-disable-next-line global-require
const PodAsset = require('../models/PodAsset');
// eslint-disable-next-line global-require
const Integration = require('../models/Integration');
// eslint-disable-next-line global-require
const { AgentRegistry, AgentInstallation, AgentProfile } = require('../models/AgentRegistry');
// eslint-disable-next-line global-require
const AgentIdentityService = require('../services/agentIdentityService');
// eslint-disable-next-line global-require
const User = require('../models/User');

const VALID_POD_TYPES = ['chat', 'study', 'games', 'agent-ensemble', 'agent-admin', 'team'] as const;
type PodType = typeof VALID_POD_TYPES[number];

const DEFAULT_POD_AGENT = 'commonly-bot';
const DEFAULT_POD_AGENT_SCOPES = [
  'context:read',
  'summaries:read',
  'messages:write',
  'integration:read',
  'integration:messages:read',
  'integration:write',
];

interface AuthRequest extends Request {
  userId?: string;
  user?: { id: string; role?: string };
}

interface CreatePodBody {
  name?: string;
  description?: string;
  type?: PodType;
  joinPolicy?: 'open' | 'invite-only';
  parentPod?: string;
}

function isGlobalAdminRequest(req: AuthRequest): boolean {
  return req.user?.role === 'admin';
}

async function ensureDefaultAgentRegistryEntry(agentName: string): Promise<unknown> {
  let entry = await AgentRegistry.findOne({ agentName });
  if (!entry) {
    entry = await AgentRegistry.create({
      agentName,
      displayName: agentName,
      description: 'Default pod agent',
      isPublic: true,
    });
  }
  return entry;
}

function buildDefaultAgentProfileId(agentName: string, instanceId: string): string {
  return `${agentName}:${instanceId}`;
}

async function installDefaultAgentForPod(params: { pod: { _id: unknown; name?: string; type?: string }; userId: string }): Promise<void> {
  try {
    const { pod, userId } = params;
    const agentUser = await AgentIdentityService.getOrCreateAgentUser('openclaw', { instanceId: DEFAULT_POD_AGENT });
    await ensureDefaultAgentRegistryEntry(DEFAULT_POD_AGENT);

    const existing = await AgentInstallation.findOne({
      agentName: DEFAULT_POD_AGENT,
      podId: pod._id,
      status: 'active',
    });
    if (existing) return;

    await AgentInstallation.install({
      agentName: DEFAULT_POD_AGENT,
      instanceId: DEFAULT_POD_AGENT,
      podId: pod._id,
      installedBy: userId,
      config: {
        preset: 'default-pod-agent',
        autoInstalled: true,
        scopes: DEFAULT_POD_AGENT_SCOPES,
        version: '1.0.0',
        displayName: DEFAULT_POD_AGENT,
        instanceId: DEFAULT_POD_AGENT,
      },
    });

    if (agentUser && !pod.members) {
      await Pod.findByIdAndUpdate(pod._id, { $addToSet: { members: agentUser._id } });
    }
  } catch (err) {
    const e = err as { message?: string };
    console.warn('[podController] Failed to install default agent:', e.message);
  }
}

exports.getAllPods = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { type } = req.query as { type?: string };
    const filter: Record<string, unknown> = {};
    if (type) {
      filter.type = type;
    } else if (!isGlobalAdminRequest(req)) {
      filter.type = { $ne: 'agent-admin' };
    }
    const pods = await Pod.find(filter)
      .populate('createdBy', 'username profilePicture')
      .populate('members', 'username profilePicture')
      .lean();
    res.json(pods);
  } catch (err) {
    const e = err as { message?: string };
    console.error(e.message);
    res.status(500).send('Server Error');
  }
};

exports.getPodsByType = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { type } = req.params;
    const pods = await Pod.find({ type })
      .populate('createdBy', 'username profilePicture')
      .populate('members', 'username profilePicture')
      .lean();
    res.json(pods);
  } catch (err) {
    const e = err as { message?: string };
    console.error(e.message);
    res.status(500).send('Server Error');
  }
};

exports.getPodById = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const pod = await Pod.findById(req.params.id)
      .populate('createdBy', 'username profilePicture')
      .populate('members', 'username profilePicture')
      .lean();
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
    const userId = req.userId || req.user?.id;
    const { name, description, type = 'chat', joinPolicy = 'open', parentPod } = req.body as CreatePodBody;

    if (!name) {
      res.status(400).json({ msg: 'Pod name is required' });
      return;
    }
    if (!VALID_POD_TYPES.includes(type as PodType)) {
      res.status(400).json({ msg: `Invalid pod type. Valid types: ${VALID_POD_TYPES.join(', ')}` });
      return;
    }

    const pod = await Pod.create({
      name,
      description: description || '',
      type,
      joinPolicy,
      createdBy: userId,
      members: [userId],
      parentPod: parentPod || null,
    });

    // Auto-install default agent (fire-and-forget)
    installDefaultAgentForPod({ pod, userId: String(userId) }).catch((err) => {
      const e = err as { message?: string };
      console.warn('[podController] Default agent install failed:', e.message);
    });

    const populated = await Pod.findById(pod._id)
      .populate('createdBy', 'username profilePicture')
      .populate('members', 'username profilePicture')
      .lean();
    res.json(populated);
  } catch (err) {
    const e = err as { message?: string };
    console.error(e.message);
    res.status(500).send('Server Error');
  }
};

exports.joinPod = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.userId || req.user?.id;
    const pod = await Pod.findById(req.params.id) as {
      _id: unknown;
      joinPolicy?: string;
      members?: Array<{ toString(): string }>;
      save(): Promise<void>;
    } | null;
    if (!pod) {
      res.status(404).json({ msg: 'Pod not found' });
      return;
    }
    if (pod.joinPolicy === 'invite-only') {
      res.status(403).json({ msg: 'This pod requires an invitation' });
      return;
    }
    if (!pod.members) pod.members = [];
    const alreadyMember = pod.members.some((id) => id.toString() === String(userId));
    if (!alreadyMember) {
      pod.members.push(userId as unknown as { toString(): string });
      await pod.save();
    }
    const populated = await Pod.findById(pod._id)
      .populate('createdBy', 'username profilePicture')
      .populate('members', 'username profilePicture')
      .lean();
    res.json(populated);
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

exports.leavePod = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.userId || req.user?.id;
    const pod = await Pod.findById(req.params.id) as {
      _id: unknown;
      createdBy?: { toString(): string };
      members?: Array<{ toString(): string }>;
      save(): Promise<void>;
    } | null;
    if (!pod) {
      res.status(404).json({ msg: 'Pod not found' });
      return;
    }
    if (pod.createdBy?.toString() === String(userId)) {
      res.status(400).json({ msg: 'Pod creator cannot leave the pod' });
      return;
    }
    if (pod.members) {
      pod.members = pod.members.filter((id) => id.toString() !== String(userId));
    }
    await pod.save();
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

exports.removeMember = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.userId || req.user?.id;
    const { id: podId, memberId } = req.params;
    const pod = await Pod.findById(podId) as {
      _id: unknown;
      createdBy?: { toString(): string };
      members?: Array<{ toString(): string }>;
      save(): Promise<void>;
    } | null;
    if (!pod) {
      res.status(404).json({ msg: 'Pod not found' });
      return;
    }
    if (pod.createdBy?.toString() !== String(userId)) {
      res.status(401).json({ msg: 'Not authorized to remove members from this pod' });
      return;
    }
    if (pod.members) {
      pod.members = pod.members.filter((id) => id.toString() !== memberId);
    }
    await pod.save();
    const populated = await Pod.findById(pod._id)
      .populate('createdBy', 'username profilePicture')
      .populate('members', 'username profilePicture')
      .lean();
    res.json(populated);
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
    const userId = req.userId || req.user?.id;
    const pod = await Pod.findById(req.params.id) as {
      _id: unknown;
      createdBy?: { toString(): string };
      deleteOne?(): Promise<void>;
    } | null;
    if (!pod) {
      res.status(404).json({ msg: 'Pod not found' });
      return;
    }
    if (pod.createdBy?.toString() !== String(userId) && !isGlobalAdminRequest(req)) {
      res.status(401).json({ msg: 'Not authorized to delete this pod' });
      return;
    }
    // Cascade delete associated data
    await Promise.all([
      Message.deleteMany({ podId: pod._id }),
      Post.deleteMany({ podId: pod._id }),
      Summary.deleteMany({ podId: pod._id }),
      PodAsset.deleteMany({ podId: pod._id }),
      Integration.deleteMany({ podId: pod._id }),
      AgentInstallation.deleteMany({ podId: pod._id }),
    ]);
    await pod.deleteOne?.();
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
