const Pod = require('../models/Pod');
const Message = require('../models/Message');
const Post = require('../models/Post');
const Summary = require('../models/Summary');
const PodAsset = require('../models/PodAsset');
const Integration = require('../models/Integration');
const { AgentRegistry, AgentInstallation } = require('../models/AgentRegistry');
const AgentProfile = require('../models/AgentProfile');
const AgentIdentityService = require('../services/agentIdentityService');
const User = require('../models/User');
// Add PGPod at the top level if it's available
let PGPod: any;
let PGMessage: any;
if (process.env.PG_HOST) {
  PGPod = require('../models/pg/Pod');
  PGMessage = require('../models/pg/Message');
}

const VALID_POD_TYPES = ['chat', 'study', 'games', 'project', 'agent-ensemble', 'agent-admin', 'agent-room', 'team'];
const DEFAULT_POD_AGENT = process.env.DEFAULT_POD_AGENT_NAME || 'commonly-bot';
const DEFAULT_POD_AGENT_SCOPES = [
  'context:read',
  'summaries:read',
  'messages:write',
  'integration:read',
  'integration:messages:read',
  'integration:write',
];

const buildDefaultAgentProfileId = (agentName: any, instanceId = 'default') => (
  `${agentName.toLowerCase()}:${instanceId || 'default'}`
);

const isGlobalAdminRequest = async (req: any) => {
  if (req.user?.role === 'admin') return true;
  const userId = req.userId || req.user?.id || req.user?._id;
  if (!userId) return false;
  const user = await User.findById(userId).select('role').lean();
  return Boolean(user && user.role === 'admin');
};

const ensureDefaultAgentRegistryEntry = async (agentName: any) => {
  const normalized = String(agentName || '').trim().toLowerCase();
  if (!normalized) return null;

  let agent = await AgentRegistry.findOne({ agentName: normalized });
  if (agent) return agent;

  if (normalized !== 'commonly-bot') {
    return null;
  }

  const commonlyBotType = AgentIdentityService.getAgentTypeConfig('commonly-bot');
  const capabilities = (commonlyBotType?.capabilities || ['summarize', 'digest', 'integrations'])
    .map((name: any) => ({ name, description: name }));

  agent = await AgentRegistry.create({
    agentName: 'commonly-bot',
    displayName: commonlyBotType?.officialDisplayName || 'Commonly Bot',
    description: commonlyBotType?.officialDescription
      || 'Built-in summary agent for pod activity, integrations, and daily digest context',
    registry: 'commonly-official',
    categories: ['automation', 'summaries', 'communication'],
    tags: ['summaries', 'digest', 'integrations', 'commonly'],
    verified: true,
    iconUrl: '/icons/commonly-bot.png',
    manifest: {
      name: 'commonly-bot',
      version: '1.0.0',
      capabilities,
      context: {
        required: ['context:read', 'summaries:read', 'messages:write'],
      },
      runtime: {
        type: 'standalone',
        connection: 'rest',
      },
    },
    latestVersion: '1.0.0',
    versions: [{ version: '1.0.0', publishedAt: new Date() }],
    stats: { installs: 0, rating: 0, ratingCount: 0 },
  });

  return agent;
};

const installDefaultAgentForPod = async ({ pod, userId }: { pod: any; userId: any }) => {
  if (!pod?._id || !userId) return;
  if (process.env.AUTO_INSTALL_DEFAULT_AGENT === '0') return;

  const agent = await ensureDefaultAgentRegistryEntry(DEFAULT_POD_AGENT);
  if (!agent) {
    console.warn(`[pod] default agent "${DEFAULT_POD_AGENT}" not found; skipping auto-install`);
    return;
  }

  const instanceId = 'default';
  const alreadyInstalled = await AgentInstallation.isInstalled(agent.agentName, pod._id, instanceId);
  if (alreadyInstalled) return;

  const requiredScopes = agent.manifest?.context?.required || [];
  const scopes = Array.from(new Set([...requiredScopes, ...DEFAULT_POD_AGENT_SCOPES]));

  const installation = await AgentInstallation.install(agent.agentName, pod._id, {
    version: agent.latestVersion || '1.0.0',
    config: { preset: 'default-pod-agent', autoInstalled: true },
    scopes,
    installedBy: userId,
    instanceId,
    displayName: agent.displayName || 'Commonly Bot',
  });

  await AgentRegistry.incrementInstalls(agent.agentName);

  await AgentProfile.updateOne(
    {
      podId: pod._id,
      agentName: agent.agentName,
      instanceId,
    },
    {
      $setOnInsert: {
        agentId: buildDefaultAgentProfileId(agent.agentName, instanceId),
        name: installation.displayName || agent.displayName || 'Commonly Bot',
        purpose: 'Social helper that summarizes pod activity, surfaces interesting external signals, and contributes daily digest context.',
        instructions: 'You act as a friendly social helper: summarize key activity, suggest timely conversation starters, and keep updates concise and useful.',
        createdBy: userId,
      },
      $set: {
        status: 'active',
        persona: {
          tone: 'friendly',
          specialties: ['summarization', 'community updates', 'conversation starters', 'digest highlights'],
        },
      },
    },
    { upsert: true },
  );

  try {
    const agentUser = await AgentIdentityService.getOrCreateAgentUser(agent.agentName, {
      instanceId,
      displayName: installation.displayName || agent.displayName || 'Commonly Bot',
    });
    await AgentIdentityService.ensureAgentInPod(agentUser, pod._id);
  } catch (identityError: any) {
    console.warn('[pod] failed to provision default agent user identity:', identityError.message);
  }
};

// Get all pods or filter by type
exports.getAllPods = async (req: any, res: any) => {
  try {
    const { type } = req.query;
    // Exclude agent-admin DM pods from default listing; only show when
    // explicitly requested and the caller is a member.
    const query = type ? { type } : { type: { $ne: 'agent-admin' } };

    let pods = await Pod.find(query)
      .populate('createdBy', 'username profilePicture')
      .populate('members', 'username profilePicture')
      .populate('parentPod', 'name _id')
      .sort({ updatedAt: -1 });

    // Personal pod types: only return pods the requester belongs to
    if ((type === 'agent-admin' || type === 'agent-room') && req.userId) {
      const uid = String(req.userId);
      pods = pods.filter((p: any) => p.members.some((m: any) => String(m._id || m) === uid));
    }

    return res.json(pods);
  } catch (err: any) {
    console.error(err.message);
    return res.status(500).json({ error: 'Server Error' });
  }
};

// Get pods by type
exports.getPodsByType = async (req: any, res: any) => {
  try {
    const { type } = req.params;

    if (!VALID_POD_TYPES.includes(type)) {
      return res.status(400).json({ error: 'Invalid pod type' });
    }

    const pods = await Pod.find({ type })
      .populate('createdBy', 'username profilePicture')
      .populate('members', 'username profilePicture')
      .sort({ updatedAt: -1 });

    if ((type === 'agent-admin' || type === 'agent-room') && req.userId) {
      const uid = String(req.userId);
      const memberPods = pods.filter((p: any) => p.members.some((m: any) => String(m._id || m) === uid));
      return res.json(memberPods);
    }

    return res.json(pods);
  } catch (err: any) {
    console.error(err.message);
    return res.status(500).json({ error: 'Server Error' });
  }
};

// Get a specific pod
exports.getPodById = async (req: any, res: any) => {
  try {
    const { id, type } = req.params;

    if (!id) {
      return res.status(400).json({ error: 'Pod ID is required' });
    }

    // Get the pod with populated data
    const pod = await Pod.findById(id)
      .populate('createdBy', 'username profilePicture')
      .populate('members', 'username profilePicture')
      .populate('parentPod', 'name _id');

    if (!pod) {
      return res.status(404).json({ error: 'Pod not found' });
    }

    // If type is specified, ensure pod is of that type
    if (type && pod.type !== type) {
      return res
        .status(404)
        .json({ error: 'Pod not found or is not of specified type' });
    }

    return res.json(pod);
  } catch (err: any) {
    console.error('Error in getPodById:', err.message);
    if (err.kind === 'ObjectId') {
      return res.status(404).json({ error: 'Pod not found' });
    }
    return res.status(500).json({ error: 'Server Error' });
  }
};

// Create a pod
exports.createPod = async (req: any, res: any) => {
  try {
    const {
      name, description, type, joinPolicy, parentPod, projectMeta,
    } = req.body;

    if (!name || !type) {
      return res.status(400).json({ msg: 'Name and type are required' });
    }

    if (!VALID_POD_TYPES.includes(type)) {
      return res.status(400).json({ msg: 'Invalid pod type' });
    }

    const newPod = new Pod({
      name,
      description,
      type,
      joinPolicy: joinPolicy === 'invite-only' ? 'invite-only' : 'open',
      projectMeta: type === 'project'
        ? {
            goal: projectMeta?.goal || description || '',
            scope: projectMeta?.scope || '',
            successCriteria: Array.isArray(projectMeta?.successCriteria) ? projectMeta.successCriteria : [],
            status: projectMeta?.status || 'planning',
            dueDate: projectMeta?.dueDate || null,
            ownerIds: Array.isArray(projectMeta?.ownerIds) && projectMeta.ownerIds.length
              ? projectMeta.ownerIds
              : [req.userId],
            keyLinks: Array.isArray(projectMeta?.keyLinks) ? projectMeta.keyLinks : [],
          }
        : undefined,
      parentPod: parentPod || null,
      createdBy: req.userId,
      members: [req.userId],
    });

    const pod = await newPod.save();

    // Populate the user data
    await pod.populate('createdBy', 'username profilePicture');
    await pod.populate('members', 'username profilePicture');

    // Also create in PostgreSQL if available
    try {
      if (process.env.PG_HOST && PGPod) {
        console.log('Creating pod in PostgreSQL as well:', pod._id);

        // Insert into PostgreSQL with the same ID
        await PGPod.create(
          name,
          description,
          type,
          req.userId,
          pod._id.toString(), // Pass the MongoDB ID
        );

        console.log('Pod successfully created in PostgreSQL');
      }
    } catch (pgErr: any) {
      console.error('Error creating pod in PostgreSQL:', pgErr.message);
      // We don't fail the request if PostgreSQL creation fails
      // The synchronization script can fix this later
    }

    try {
      await installDefaultAgentForPod({
        pod,
        userId: req.userId,
      });
    } catch (defaultAgentError: any) {
      console.warn('[pod] default agent auto-install failed:', defaultAgentError.message);
    }

    res.json(pod);
  } catch (err: any) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
};

exports.updatePod = async (req: any, res: any) => {
  try {
    const { id } = req.params;
    const {
      name, description, joinPolicy, parentPod, projectMeta,
    } = req.body || {};

    const pod = await Pod.findById(id);
    if (!pod) {
      return res.status(404).json({ msg: 'Pod not found' });
    }

    const requesterId = req.userId || req.user?.id || req.user?._id;
    const isCreator = pod.createdBy.toString() === requesterId?.toString();
    const isGlobalAdmin = await isGlobalAdminRequest(req);
    if (!isCreator && !isGlobalAdmin) {
      return res.status(403).json({ msg: 'Not authorized to update this pod' });
    }

    if (typeof name === 'string') pod.name = name.trim();
    if (typeof description === 'string') pod.description = description.trim();
    if (joinPolicy === 'invite-only' || joinPolicy === 'open') pod.joinPolicy = joinPolicy;
    if (parentPod !== undefined) pod.parentPod = parentPod || null;

    if (pod.type === 'project' && projectMeta && typeof projectMeta === 'object') {
      if (typeof projectMeta.goal === 'string') pod.projectMeta.goal = projectMeta.goal.trim();
      if (typeof projectMeta.scope === 'string') pod.projectMeta.scope = projectMeta.scope.trim();
      if (Array.isArray(projectMeta.successCriteria)) {
        pod.projectMeta.successCriteria = projectMeta.successCriteria
          .map((value: unknown) => String(value || '').trim())
          .filter(Boolean);
      }
      if (['planning', 'on-track', 'at-risk', 'blocked', 'complete'].includes(String(projectMeta.status))) {
        pod.projectMeta.status = String(projectMeta.status);
      }
      if (projectMeta.dueDate === null || projectMeta.dueDate === '') {
        pod.projectMeta.dueDate = null;
      } else if (projectMeta.dueDate) {
        pod.projectMeta.dueDate = new Date(projectMeta.dueDate);
      }
      if (Array.isArray(projectMeta.ownerIds)) {
        pod.projectMeta.ownerIds = projectMeta.ownerIds;
      }
      if (Array.isArray(projectMeta.keyLinks)) {
        pod.projectMeta.keyLinks = projectMeta.keyLinks
          .map((link: any) => ({
            label: String(link?.label || '').trim(),
            url: String(link?.url || '').trim(),
          }))
          .filter((link: any) => link.label || link.url);
      }
    }

    pod.updatedAt = Date.now();
    await pod.save();
    await pod.populate('createdBy', 'username profilePicture');
    await pod.populate('members', 'username profilePicture');

    return res.json(pod);
  } catch (err: any) {
    console.error('Error updating pod:', err.message);
    if (err.kind === 'ObjectId') {
      return res.status(404).json({ msg: 'Pod not found' });
    }
    return res.status(500).json({ msg: 'Server Error' });
  }
};

// Join a pod
exports.joinPod = async (req: any, res: any) => {
  try {
    console.log('Join pod request received:', {
      params: req.params,
      body: req.body,
    });

    const { id } = req.params;

    if (!id) {
      return res.status(400).json({ msg: 'Pod ID is required' });
    }

    // Access the user ID safely
    const userId = req.userId || req.user.id;
    console.log('User ID from request:', userId);

    if (!userId) {
      return res.status(401).json({ msg: 'User authentication failed' });
    }

    // Check if pod exists
    console.log('Finding pod with ID:', id);
    const pod = await Pod.findById(id);

    if (!pod) {
      return res.status(404).json({ msg: 'Pod not found' });
    }

    console.log('Pod found:', { podId: pod._id, members: pod.members });

    // Check if user is already a member
    const isMember = pod.members.some(
      (member: any) => member.toString() === userId.toString(),
    );
    console.log('Is user already a member?', isMember);

    if (isMember) {
      return res.status(400).json({ msg: 'Already a member of this pod' });
    }

    // Enforce invite-only policy
    if (pod.joinPolicy === 'invite-only') {
      const isAdmin = await isGlobalAdminRequest(req);
      const isCreator = pod.createdBy.toString() === userId.toString();
      if (!isAdmin && !isCreator) {
        return res.status(403).json({ msg: 'This pod is invite-only. Ask the pod creator to add you.' });
      }
    }

    // Add user to pod members
    console.log('Adding user to pod members');
    pod.members.push(userId);
    pod.updatedAt = Date.now();

    console.log('Saving pod with new member');
    await pod.save();

    // Return the updated pod with populated data
    console.log('Retrieving updated pod with populated data');
    const updatedPod = await Pod.findById(id)
      .populate('createdBy', 'username profilePicture')
      .populate('members', 'username profilePicture');

    console.log('Join pod successful, returning updated pod');
    res.json(updatedPod);
  } catch (err: any) {
    console.error('Error in joinPod:', err.message);
    console.error('Full error:', err);

    if (err.kind === 'ObjectId') {
      return res.status(404).json({ msg: 'Pod not found' });
    }

    // Return more specific error information to help with debugging
    return res.status(500).json({
      msg: 'Server Error',
      error: err.message,
      stack: process.env.NODE_ENV === 'production' ? null : err.stack,
    });
  }
};

// Leave a pod
exports.leavePod = async (req: any, res: any) => {
  try {
    const pod = await Pod.findById(req.params.id);

    if (!pod) {
      return res.status(404).json({ msg: 'Pod not found' });
    }

    // Check if user is a member
    if (!pod.members.includes(req.userId)) {
      return res.status(400).json({ msg: 'Not a member of this pod' });
    }

    // Remove user from members
    pod.members = pod.members.filter(
      (member: any) => member.toString() !== req.userId,
    );
    pod.updatedAt = Date.now();

    await pod.save();

    // Populate the user data
    await pod.populate('createdBy', 'username profilePicture');
    await pod.populate('members', 'username profilePicture');

    res.json(pod);
  } catch (err: any) {
    console.error(err.message);
    if (err.kind === 'ObjectId') {
      return res.status(404).json({ msg: 'Pod not found' });
    }
    res.status(500).send('Server Error');
  }
};

// Remove a member from a pod (only creator can remove)
exports.removeMember = async (req: any, res: any) => {
  try {
    const { id: podId, memberId } = req.params;
    const userId = req.userId || req.user?.id;

    if (!podId || !memberId) {
      return res.status(400).json({ msg: 'Pod ID and member ID are required' });
    }

    if (!userId) {
      return res.status(401).json({ msg: 'User authentication failed' });
    }

    const pod = await Pod.findById(podId);

    if (!pod) {
      return res.status(404).json({ msg: 'Pod not found' });
    }

    const creatorId = pod.createdBy?.toString?.() || pod.createdBy;
    if (creatorId !== userId.toString()) {
      return res.status(403).json({ msg: 'Only pod admin can remove members' });
    }

    if (memberId.toString() === creatorId.toString()) {
      return res.status(400).json({ msg: 'Cannot remove pod creator' });
    }

    const isMember = pod.members.some(
      (member: any) => member.toString() === memberId.toString(),
    );
    if (!isMember) {
      return res.status(400).json({ msg: 'User is not a member of this pod' });
    }

    pod.members = pod.members.filter(
      (member: any) => member.toString() !== memberId.toString(),
    );
    pod.updatedAt = Date.now();

    await pod.save();

    // Best-effort cleanup in PostgreSQL if available
    if (process.env.PG_HOST && PGPod) {
      try {
        await PGPod.removeMember(podId, memberId.toString());
      } catch (pgErr: any) {
        console.warn(
          'Failed to remove member from PostgreSQL pod members:',
          pgErr.message,
        );
      }
    }

    await pod.populate('createdBy', 'username profilePicture');
    await pod.populate('members', 'username profilePicture');

    return res.json(pod);
  } catch (err: any) {
    console.error('Error removing pod member:', err.message);
    if (err.kind === 'ObjectId') {
      return res.status(404).json({ msg: 'Pod not found' });
    }
    return res.status(500).json({ msg: 'Server Error' });
  }
};

// Delete a pod (only creator can delete)
exports.deletePod = async (req: any, res: any) => {
  try {
    const pod = await Pod.findById(req.params.id);

    if (!pod) {
      return res.status(404).json({ msg: 'Pod not found' });
    }

    const requesterId = req.userId || req.user?.id || req.user?._id;
    const isCreator = pod.createdBy.toString() === requesterId?.toString();
    const isGlobalAdmin = await isGlobalAdminRequest(req);

    // Check if user is the creator or global admin
    if (!isCreator && !isGlobalAdmin) {
      return res.status(401).json({ msg: 'Not authorized to delete this pod' });
    }

    // Delete all messages in the pod
    await Message.deleteMany({ podId: req.params.id });
    if (PGMessage) {
      await PGMessage.deleteByPodId(req.params.id);
    }

    await Promise.allSettled([
      Post.deleteMany({ podId: req.params.id }),
      Summary.deleteMany({ podId: req.params.id }),
      PodAsset.deleteMany({ podId: req.params.id }),
      Integration.deleteMany({ podId: req.params.id }),
      AgentInstallation.deleteMany({ podId: req.params.id }),
      AgentProfile.deleteMany({ podId: req.params.id }),
    ]);

    if (PGPod) {
      await PGPod.delete(req.params.id);
    }

    // Delete the pod
    await Pod.deleteOne({ _id: req.params.id });

    res.json({ msg: 'Pod deleted' });
  } catch (err: any) {
    console.error(err.message);
    if (err.kind === 'ObjectId') {
      return res.status(404).json({ msg: 'Pod not found' });
    }
    res.status(500).send('Server Error');
  }
};

export {};
