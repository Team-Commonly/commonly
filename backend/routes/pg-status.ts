// eslint-disable-next-line global-require
const express = require('express');
// eslint-disable-next-line global-require
const auth = require('../middleware/auth');
// eslint-disable-next-line global-require
const { checkStatus, syncUser } = require('../controllers/pgStatusController');

const router: ReturnType<typeof express.Router> = express.Router();

router.get('/', checkStatus);
router.post('/sync-user', auth, syncUser);

module.exports = router;

export {};
