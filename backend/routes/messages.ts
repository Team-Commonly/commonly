// eslint-disable-next-line global-require
const express = require('express');
// eslint-disable-next-line global-require
const auth = require('../middleware/auth');
// eslint-disable-next-line global-require
const {
  getMessages,
  createMessage,
  deleteMessage,
} = require('../controllers/messageController');

const router: ReturnType<typeof express.Router> = express.Router();

router.get('/:podId', auth, getMessages);
router.post('/:podId', auth, createMessage);
router.delete('/:id', auth, deleteMessage);

module.exports = router;

export {};
