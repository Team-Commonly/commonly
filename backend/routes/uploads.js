const express = require('express');

const router = express.Router();
const multer = require('multer');
const File = require('../models/File');
const auth = require('../middleware/auth');

// Configure multer for memory storage (not disk)
const storage = multer.memoryStorage();

// Create upload middleware with file filtering
const upload = multer({
  storage,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB limit
  },
  fileFilter(req, file, cb) {
    // Accept all common image formats
    if (
      !file.originalname.match(
        /\.(jpg|jpeg|png|gif|webp|svg|JPG|JPEG|PNG|GIF|WEBP|SVG)$/,
      )
    ) {
      return cb(new Error('Only image files are allowed!'), false);
    }
    cb(null, true);
  },
});

// Upload an image
router.post('/', auth, upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ msg: 'No file uploaded' });
    }

    // Generate a unique filename
    const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    const fileName = `${uniqueSuffix}.${req.file.originalname.split('.').pop()}`;

    // Create a new file document
    const newFile = new File({
      fileName,
      originalName: req.file.originalname,
      contentType: req.file.mimetype,
      size: req.file.size,
      data: req.file.buffer,
      uploadedBy: req.userId,
    });

    // Save the file to the database
    await newFile.save();

    // Generate the URL for the file
    const { protocol } = req;
    const host = req.get('host');
    const url = `${protocol}://${host}/api/uploads/${fileName}`;

    res.json({
      url,
      fileName,
      contentType: req.file.mimetype,
      size: req.file.size,
    });
  } catch (err) {
    console.error('Upload error:', err.message);
    res.status(500).send('Server Error');
  }
});

// Get an image by filename
router.get('/:fileName', async (req, res) => {
  try {
    const file = await File.findByFileName(req.params.fileName);

    if (!file) {
      return res.status(404).json({ msg: 'File not found' });
    }

    // Set the appropriate content type
    res.set('Content-Type', file.contentType);

    // Send the file data
    res.send(file.data);
  } catch (err) {
    console.error('Error retrieving file:', err.message);
    res.status(500).send('Server Error');
  }
});

module.exports = router;
