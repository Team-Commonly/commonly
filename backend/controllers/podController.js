const Pod = require('../models/Pod');
const Message = require('../models/Message');
const _User = require('../models/User');
// Add PGPod at the top level if it's available
let PGPod;
if (process.env.PG_HOST) {
  PGPod = require('../models/pg/Pod');
}

// Get all pods or filter by type
exports.getAllPods = async (req, res) => {
  try {
    const { type } = req.query;
    const query = type ? { type } : {};

    const pods = await Pod.find(query)
      .populate('createdBy', 'username profilePicture')
      .populate('members', 'username profilePicture')
      .sort({ updatedAt: -1 });

    return res.json(pods);
  } catch (err) {
    console.error(err.message);
    return res.status(500).json({ error: 'Server Error' });
  }
};

// Get pods by type
exports.getPodsByType = async (req, res) => {
  try {
    const { type } = req.params;

    if (!['chat', 'study', 'games'].includes(type)) {
      return res.status(400).json({ error: 'Invalid pod type' });
    }

    const pods = await Pod.find({ type })
      .populate('createdBy', 'username profilePicture')
      .populate('members', 'username profilePicture')
      .sort({ updatedAt: -1 });

    return res.json(pods);
  } catch (err) {
    console.error(err.message);
    return res.status(500).json({ error: 'Server Error' });
  }
};

// Get a specific pod
exports.getPodById = async (req, res) => {
  try {
    const { id, type } = req.params;

    if (!id) {
      return res.status(400).json({ error: 'Pod ID is required' });
    }

    // Get the pod with populated data
    const pod = await Pod.findById(id)
      .populate('createdBy', 'username profilePicture')
      .populate('members', 'username profilePicture');

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
  } catch (err) {
    console.error('Error in getPodById:', err.message);
    if (err.kind === 'ObjectId') {
      return res.status(404).json({ error: 'Pod not found' });
    }
    return res.status(500).json({ error: 'Server Error' });
  }
};

// Create a pod
exports.createPod = async (req, res) => {
  try {
    const { name, description, type } = req.body;

    if (!name || !type) {
      return res.status(400).json({ msg: 'Name and type are required' });
    }

    if (!['chat', 'study', 'games'].includes(type)) {
      return res.status(400).json({ msg: 'Invalid pod type' });
    }

    const newPod = new Pod({
      name,
      description,
      type,
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
    } catch (pgErr) {
      console.error('Error creating pod in PostgreSQL:', pgErr.message);
      // We don't fail the request if PostgreSQL creation fails
      // The synchronization script can fix this later
    }

    res.json(pod);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
};

// Join a pod
exports.joinPod = async (req, res) => {
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
      (member) => member.toString() === userId.toString(),
    );
    console.log('Is user already a member?', isMember);

    if (isMember) {
      return res.status(400).json({ msg: 'Already a member of this pod' });
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
  } catch (err) {
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
exports.leavePod = async (req, res) => {
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
      (member) => member.toString() !== req.userId,
    );
    pod.updatedAt = Date.now();

    await pod.save();

    // Populate the user data
    await pod.populate('createdBy', 'username profilePicture');
    await pod.populate('members', 'username profilePicture');

    res.json(pod);
  } catch (err) {
    console.error(err.message);
    if (err.kind === 'ObjectId') {
      return res.status(404).json({ msg: 'Pod not found' });
    }
    res.status(500).send('Server Error');
  }
};

// Remove a member from a pod (only creator can remove)
exports.removeMember = async (req, res) => {
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
      (member) => member.toString() === memberId.toString(),
    );
    if (!isMember) {
      return res.status(400).json({ msg: 'User is not a member of this pod' });
    }

    pod.members = pod.members.filter(
      (member) => member.toString() !== memberId.toString(),
    );
    pod.updatedAt = Date.now();

    await pod.save();

    // Best-effort cleanup in PostgreSQL if available
    if (process.env.PG_HOST && PGPod) {
      try {
        await PGPod.removeMember(podId, memberId.toString());
      } catch (pgErr) {
        console.warn(
          'Failed to remove member from PostgreSQL pod members:',
          pgErr.message,
        );
      }
    }

    await pod.populate('createdBy', 'username profilePicture');
    await pod.populate('members', 'username profilePicture');

    return res.json(pod);
  } catch (err) {
    console.error('Error removing pod member:', err.message);
    if (err.kind === 'ObjectId') {
      return res.status(404).json({ msg: 'Pod not found' });
    }
    return res.status(500).json({ msg: 'Server Error' });
  }
};

// Delete a pod (only creator can delete)
exports.deletePod = async (req, res) => {
  try {
    const pod = await Pod.findById(req.params.id);

    if (!pod) {
      return res.status(404).json({ msg: 'Pod not found' });
    }

    // Check if user is the creator
    if (pod.createdBy.toString() !== req.userId) {
      return res.status(401).json({ msg: 'Not authorized to delete this pod' });
    }

    // Delete all messages in the pod
    await Message.deleteMany({ podId: req.params.id });

    // Delete the pod
    await Pod.deleteOne({ _id: req.params.id });

    res.json({ msg: 'Pod deleted' });
  } catch (err) {
    console.error(err.message);
    if (err.kind === 'ObjectId') {
      return res.status(404).json({ msg: 'Pod not found' });
    }
    res.status(500).send('Server Error');
  }
};
