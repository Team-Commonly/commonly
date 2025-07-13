const express = require('express');

const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const auth = require('../middleware/auth');
const {
  getAllPods,
  getPodsByType,
  getPodById,
  createPod,
  joinPod,
  leavePod,
  deletePod,
} = require('../controllers/podController');
const Pod = require('../models/Pod');
const Announcement = require('../models/Announcement');
const ExternalLink = require('../models/ExternalLink');

// Configure storage for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = 'uploads/qrcodes';

    // Create directory if it doesn't exist
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }

    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1E9)}`;
    const ext = path.extname(file.originalname);
    cb(null, `qrcode-${uniqueSuffix}${ext}`);
  },
});

// Configure upload settings
const upload = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB limit
  fileFilter: (req, file, cb) => {
    // Check if file is an image
    if (!file.mimetype.startsWith('image/')) {
      return cb(new Error('Only image files are allowed'));
    }
    cb(null, true);
  },
});

// ===== ROUTE ORDER MATTERS! =====
// More specific routes first, generic routes last

// Get all pods
router.get('/', auth, getAllPods);

// Create a pod
router.post('/', auth, createPod);

// Resource-specific operations
// Announcements
router.post('/announcement', auth, async (req, res) => {
  try {
    const { podId, title, content } = req.body;

    // Validate request
    if (!podId || !title || !content) {
      return res.status(400).json({ message: 'Missing required fields' });
    }

    // Find pod
    const pod = await Pod.findById(podId);
    if (!pod) {
      return res.status(404).json({ message: 'Pod not found' });
    }

    // Check if user is pod owner
    if (pod.createdBy.toString() !== req.user.id) {
      return res.status(403).json({ message: 'Only pod owner can create announcements' });
    }

    // Create announcement
    const announcement = new Announcement({
      podId,
      title,
      content,
      createdBy: req.user.id,
    });

    await announcement.save();

    // Update pod with announcement
    pod.announcements.push(announcement._id);
    await pod.save();

    return res.status(201).json(announcement);
  } catch (error) {
    console.error('Error creating announcement:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Delete an announcement
router.delete('/announcement/:id', auth, async (req, res) => {
  try {
    const announcementId = req.params.id;

    // Find the announcement
    const announcement = await Announcement.findById(announcementId);
    if (!announcement) {
      return res.status(404).json({ message: 'Announcement not found' });
    }

    // Find associated pod
    const pod = await Pod.findById(announcement.podId);
    if (!pod) {
      return res.status(404).json({ message: 'Pod not found' });
    }

    // Check if user is pod owner
    if (pod.createdBy.toString() !== req.user.id) {
      return res.status(403).json({ message: 'Only pod owner can delete announcements' });
    }

    // Remove announcement from pod
    pod.announcements = pod.announcements.filter((id) => id.toString() !== announcementId);
    await pod.save();

    // Delete announcement
    await Announcement.findByIdAndDelete(announcementId);

    return res.status(200).json({ message: 'Announcement deleted successfully' });
  } catch (error) {
    console.error('Error deleting announcement:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// External Links
router.post('/external-link', auth, upload.single('qrCode'), async (req, res) => {
  try {
    const {
      podId, name, type, url,
    } = req.body;

    // Validate request
    if (!podId || !name || !type) {
      return res.status(400).json({ message: 'Missing required fields' });
    }

    // Find pod
    const pod = await Pod.findById(podId);
    if (!pod) {
      return res.status(404).json({ message: 'Pod not found' });
    }

    // Check if user is pod owner
    if (pod.createdBy.toString() !== req.user.id) {
      return res.status(403).json({ message: 'Only pod owner can add external links' });
    }

    // Create external link
    const externalLink = new ExternalLink({
      podId,
      name,
      type,
      createdBy: req.user.id,
    });

    // Set URL or QR code path
    if (type === 'wechat' && req.file) {
      externalLink.qrCodePath = req.file.path;
    } else if (url) {
      externalLink.url = url;
    } else {
      return res.status(400).json({ message: 'URL or QR code is required' });
    }

    await externalLink.save();

    // Update pod with external link
    pod.externalLinks.push(externalLink._id);
    await pod.save();

    return res.status(201).json(externalLink);
  } catch (error) {
    console.error('Error creating external link:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Delete an external link
router.delete('/external-link/:id', auth, async (req, res) => {
  try {
    const linkId = req.params.id;

    // Find the external link
    const externalLink = await ExternalLink.findById(linkId);
    if (!externalLink) {
      return res.status(404).json({ message: 'External link not found' });
    }

    // Find associated pod
    const pod = await Pod.findById(externalLink.podId);
    if (!pod) {
      return res.status(404).json({ message: 'Pod not found' });
    }

    // Check if user is pod owner
    if (pod.createdBy.toString() !== req.user.id) {
      return res.status(403).json({ message: 'Only pod owner can delete external links' });
    }

    // Remove external link from pod
    pod.externalLinks = pod.externalLinks.filter((id) => id.toString() !== linkId);
    await pod.save();

    // Delete QR code file if it exists
    if (externalLink.qrCodePath && fs.existsSync(externalLink.qrCodePath)) {
      fs.unlinkSync(externalLink.qrCodePath);
    }

    // Delete external link
    await ExternalLink.findByIdAndDelete(linkId);

    return res.status(200).json({ message: 'External link deleted successfully' });
  } catch (error) {
    console.error('Error deleting external link:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Get QR code for WeChat link
router.get('/external-link/:linkId/qrcode', auth, async (req, res) => {
  try {
    const { linkId } = req.params;

    // Find link
    const link = await ExternalLink.findById(linkId);
    if (!link || link.type !== 'wechat' || !link.qrCodePath) {
      return res.status(404).json({ message: 'QR code not found' });
    }

    // Check if user is member of pod
    const pod = await Pod.findById(link.podId);
    if (!pod || !pod.members.includes(req.user.id)) {
      return res.status(403).json({ message: 'Access denied' });
    }

    // Return file
    return res.sendFile(path.resolve(link.qrCodePath));
  } catch (error) {
    console.error('Error fetching QR code:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Pod-specific operations
// Join a pod
router.post('/:id/join', auth, joinPod);

// Leave a pod
router.post('/:id/leave', auth, leavePod);

// Get announcements for a pod
router.get('/:podId/announcements', auth, async (req, res) => {
  try {
    const { podId } = req.params;

    // Validate pod exists
    const pod = await Pod.findById(podId);
    if (!pod) {
      return res.status(404).json({ message: 'Pod not found' });
    }

    // Check if user is a member of the pod
    if (!pod.members.some((member) => member.toString() === req.user.id)) {
      return res.status(403).json({ message: 'Not authorized to view pod announcements' });
    }

    // Retrieve announcements for the pod
    const announcements = await Announcement.find({ podId })
      .sort({ createdAt: -1 }) // newest first
      .populate('createdBy', 'username profilePicture');

    return res.status(200).json(announcements);
  } catch (error) {
    console.error('Error retrieving pod announcements:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Get external links for a pod
router.get('/:podId/external-links', auth, async (req, res) => {
  try {
    const { podId } = req.params;

    // Validate pod exists
    const pod = await Pod.findById(podId);
    if (!pod) {
      return res.status(404).json({ message: 'Pod not found' });
    }

    // Find external links
    const externalLinks = await ExternalLink.find({ podId })
      .sort({ createdAt: -1 })
      .populate('createdBy', 'username');

    return res.status(200).json(externalLinks);
  } catch (error) {
    console.error('Error fetching external links:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// Get pods by type or specific pod by ID
router.get('/:param', auth, async (req, res) => {
  const { param } = req.params;

  // Check if param is a MongoDB ObjectId (24 hex characters)
  const isObjectId = /^[0-9a-fA-F]{24}$/.test(param);

  if (isObjectId) {
    // Treat as pod ID - fix the parameter name
    req.params.id = param;
    return getPodById(req, res);
  }
  // Treat as pod type - fix the parameter name
  req.params.type = param;
  return getPodsByType(req, res);
});

// Get a specific pod by type and ID
router.get('/:type/:id', auth, getPodById);

// Delete a pod (only creator can delete)
router.delete('/:id', auth, deletePod);

module.exports = router;
