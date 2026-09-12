import crypto from 'crypto';
import nacl from 'tweetnacl';

export const SLACK_SIGNATURE_WINDOW_MS = 5 * 60 * 1000;

const safeEqual = (left: string, right: string): boolean => {
  const a = Buffer.from(left || '', 'utf8');
  const b = Buffer.from(right || '', 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

export const verifySlackSignature = (opts: {
  signingSecret?: unknown;
  timestamp?: unknown;
  signature?: unknown;
  rawBody?: unknown;
  now?: number;
}): boolean => {
  const signingSecret = String(opts.signingSecret || '');
  const timestamp = String(opts.timestamp || '');
  const signature = String(opts.signature || '');
  const rawBody = String(opts.rawBody || '');
  const now = opts.now ?? Date.now();
  if (!signingSecret || !/^\d+$/.test(timestamp) || !/^v0=[a-f0-9]{64}$/.test(signature)) return false;
  if (Math.abs(now - Number(timestamp) * 1000) > SLACK_SIGNATURE_WINDOW_MS) return false;
  const expected = `v0=${crypto.createHmac('sha256', signingSecret)
    .update(`v0:${timestamp}:${rawBody}`)
    .digest('hex')}`;
  return safeEqual(expected, signature);
};

export const verifyDiscordSignature = (opts: {
  publicKey?: unknown;
  timestamp?: unknown;
  signature?: unknown;
  rawBody?: unknown;
}): boolean => {
  const publicKey = String(opts.publicKey || '');
  const timestamp = String(opts.timestamp || '');
  const signature = String(opts.signature || '');
  const rawBody = String(opts.rawBody || '');
  if (!/^[a-f0-9]{64}$/.test(publicKey) || !/^\d+$/.test(timestamp) || !/^[a-f0-9]{128}$/.test(signature)) return false;
  try {
    return nacl.sign.detached.verify(
      Buffer.from(`${timestamp}${rawBody}`, 'utf8'),
      Buffer.from(signature, 'hex'),
      Buffer.from(publicKey, 'hex'),
    );
  } catch {
    return false;
  }
};

module.exports = {
  SLACK_SIGNATURE_WINDOW_MS,
  verifySlackSignature,
  verifyDiscordSignature,
};
