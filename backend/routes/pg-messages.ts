// eslint-disable-next-line global-require
const express = require('express');
// eslint-disable-next-line global-require
const auth = require('../middleware/auth');
// eslint-disable-next-line global-require
const {
  getMessages,
  createMessage,
  updateMessage,
  deleteMessage,
} = require('../controllers/pgMessageController');

const router: ReturnType<typeof express.Router> = express.Router();

router.get('/:podId', auth, getMessages);
router.post('/:podId', auth, createMessage);
router.put('/:id', auth, updateMessage);
router.delete('/:id', auth, deleteMessage);

module.exports = router;
