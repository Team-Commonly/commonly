const PGPod = require('../models/pg/Pod');
const PGMessage = require('../models/pg/Message');

// Get messages for a specific pod
exports.getMessages = async (req, res) => {
  try {
    const { podId } = req.params;
    const { limit = 50, before } = req.query;

    if (!podId) {
      return res.status(400).json({ msg: 'Pod ID is required' });
    }

    // Check if pod exists
    const pod = await PGPod.findById(podId);
    if (!pod) {
      return res.status(404).json({ msg: 'Pod not found' });
    }

    // Access the user ID safely
    const userId = req.userId || req.user.id;
    if (!userId) {
      return res.status(401).json({ msg: 'User authentication failed' });
    }

    console.log(`Checking message access for pod ${podId} by user ${userId}`);

    // Check if user is a member of the pod
    const isMember = await PGPod.isMember(podId, userId);
    if (!isMember) {
      console.error(`User ${userId} is not a member of pod ${podId}`);

      // Try to add the user as a member if not already a member
      // This helps recover from potential membership synchronization issues
      try {
        console.log(
          `Attempting to resolve membership for user ${userId} in pod ${podId}`,
        );
        await PGPod.addMember(podId, userId);

        // Check membership again
        const verifyMembership = await PGPod.isMember(podId, userId);
        if (verifyMembership) {
          console.log(
            `Successfully resolved membership for user ${userId} in pod ${podId}`,
          );
        } else {
          console.error(
            `Failed to resolve membership for user ${userId} in pod ${podId}`,
          );
          return res
            .status(401)
            .json({ msg: 'Not authorized to view messages in this pod' });
        }
      } catch (membershipError) {
        console.error(`Error resolving membership: ${membershipError.message}`);
        return res
          .status(401)
          .json({ msg: 'Not authorized to view messages in this pod' });
      }
    }

    const messages = await PGMessage.findByPodId(podId, limit, before);

    res.json(messages);
  } catch (err) {
    console.error('Error in PG getMessages:', err.message);
    if (err.kind === 'ObjectId') {
      return res.status(404).json({ msg: 'Pod not found' });
    }
    res.status(500).send('Server Error');
  }
};

// Create a new message
exports.createMessage = async (req, res) => {
  try {
    const { podId } = req.params;
    const { content } = req.body;

    if (!podId) {
      return res.status(400).json({ msg: 'Pod ID is required' });
    }

    // Check if pod exists
    const pod = await PGPod.findById(podId);
    if (!pod) {
      return res.status(404).json({ msg: 'Pod not found' });
    }

    // Access the user ID safely
    const userId = req.userId || req.user.id;
    if (!userId) {
      return res.status(401).json({ msg: 'User authentication failed' });
    }

    // Check if user is a member of the pod
    const isMember = await PGPod.isMember(podId, userId);
    if (!isMember) {
      return res
        .status(401)
        .json({ msg: 'Not authorized to post in this pod' });
    }

    const newMessage = await PGMessage.create(podId, userId, content);

    // Get the message with user details
    const message = await PGMessage.findById(newMessage.id);

    res.json(message);
  } catch (err) {
    console.error('Error in PG createMessage:', err.message);
    if (err.kind === 'ObjectId') {
      return res.status(404).json({ msg: 'Pod not found' });
    }
    res.status(500).send('Server Error');
  }
};

// Update a message
exports.updateMessage = async (req, res) => {
  try {
    const { content } = req.body;

    // Check if message exists
    const message = await PGMessage.findById(req.params.id);

    if (!message) {
      return res.status(404).json({ msg: 'Message not found' });
    }

    // Check if user is the creator of the message
    if (message.user_id !== req.user.id) {
      return res
        .status(401)
        .json({ msg: 'Not authorized to update this message' });
    }

    const updatedMessage = await PGMessage.update(req.params.id, content);

    res.json(updatedMessage);
  } catch (err) {
    console.error(err.message);
    if (err.kind === 'ObjectId') {
      return res.status(404).json({ msg: 'Message not found' });
    }
    res.status(500).send('Server Error');
  }
};

// Delete a message
exports.deleteMessage = async (req, res) => {
  try {
    const { id } = req.params;

    if (!id) {
      return res.status(400).json({ msg: 'Message ID is required' });
    }

    // Get the message
    const message = await PGMessage.findById(id);
    if (!message) {
      return res.status(404).json({ msg: 'Message not found' });
    }

    // Access the user ID safely
    const userId = req.userId || req.user.id;
    if (!userId) {
      return res.status(401).json({ msg: 'User authentication failed' });
    }

    // Check if user is the creator of the message
    if (message.user_id !== userId) {
      // Check if user is the pod creator
      const pod = await PGPod.findById(message.pod_id);
      if (!pod || pod.created_by !== userId) {
        return res
          .status(401)
          .json({ msg: 'Not authorized to delete this message' });
      }
    }

    // Delete the message
    await PGMessage.delete(id);

    res.json({ msg: 'Message deleted' });
  } catch (err) {
    console.error('Error in PG deleteMessage:', err.message);
    if (err.kind === 'ObjectId') {
      return res.status(404).json({ msg: 'Message not found' });
    }
    res.status(500).send('Server Error');
  }
};
