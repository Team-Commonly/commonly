const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { 
    getAllPods, 
    getPodsByType, 
    getPodById, 
    createPod, 
    joinPod, 
    leavePod, 
    deletePod 
} = require('../controllers/podController');
const Pod = require('../models/Pod');
const Announcement = require('../models/Announcement');
const ExternalLink = require('../models/ExternalLink');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

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
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const ext = path.extname(file.originalname);
        cb(null, 'qrcode-' + uniqueSuffix + ext);
    }
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
    }
});

// Get all pods or filter by type
router.get('/', auth, getAllPods);

// Get pods by type
router.get('/:type', auth, getPodsByType);

// Get a specific pod
router.get('/:type/:id', auth, getPodById);

// Create a pod
router.post('/', auth, createPod);

// Join a pod
router.post('/:id/join', auth, joinPod);

// Leave a pod
router.post('/:id/leave', auth, leavePod);

// Delete a pod (only creator can delete)
router.delete('/:id', auth, deletePod);

// Create announcement for a pod
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
            createdBy: req.user.id
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

// Create external link for a pod
router.post('/external-link', auth, upload.single('qrCode'), async (req, res) => {
    try {
        const { podId, name, type, url } = req.body;
        
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
            createdBy: req.user.id
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

// Get announcements for a pod
router.get('/:podId/announcements', auth, async (req, res) => {
    try {
        const { podId } = req.params;
        
        // Find announcements
        const announcements = await Announcement.find({ podId })
            .sort({ createdAt: -1 })
            .populate('createdBy', 'username');
        
        return res.status(200).json(announcements);
    } catch (error) {
        console.error('Error fetching announcements:', error);
        return res.status(500).json({ message: 'Server error' });
    }
});

// Get external links for a pod
router.get('/:podId/external-links', auth, async (req, res) => {
    try {
        const { podId } = req.params;
        
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

module.exports = router; 