const crypto = require('crypto');

const hash = (val) => crypto.createHash('sha256').update(val).digest('hex');
const randomSecret = (bytes = 24) => crypto.randomBytes(bytes).toString('hex');
const safeEqual = (a, b) => {
  const aBuf = Buffer.from(a || '', 'utf8');
  const bBuf = Buffer.from(b || '', 'utf8');
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
};

module.exports = { hash, randomSecret, safeEqual };
