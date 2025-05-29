const express = require('express');
const fs = require('fs');
const path = require('path');

const router = express.Router();

// Serve backend API documentation as plain text
router.get('/backend', (req, res) => {
  const docPath = path.join(__dirname, '..', 'docs', 'BACKEND.md');
  fs.readFile(docPath, 'utf8', (err, data) => {
    if (err) {
      console.error('Error reading backend docs:', err);
      return res.status(500).json({ message: 'Unable to load documentation' });
    }

    res.type('text/plain').send(data);
  });
});

module.exports = router;
