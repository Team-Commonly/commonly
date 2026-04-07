import crypto from 'crypto';

const hash = (val: string): string =>
  crypto.createHash('sha256').update(val).digest('hex');

const randomSecret = (bytes = 24): string =>
  crypto.randomBytes(bytes).toString('hex');

const safeEqual = (a: string, b: string): boolean => {
  const aBuf = Buffer.from(a || '', 'utf8');
  const bBuf = Buffer.from(b || '', 'utf8');
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
};

module.exports = { hash, randomSecret, safeEqual };
