import type { Request } from 'express';
import { ipKeyGenerator } from 'express-rate-limit';

const firstHeaderValue = (value: string | string[] | undefined): string | undefined => {
  if (Array.isArray(value)) return value[0];
  return value;
};

export const cloudflareIpRateLimitKeyGenerator = (req: Request): string => {
  const cfConnectingIp = firstHeaderValue(req.headers?.['cf-connecting-ip']);
  if (typeof cfConnectingIp === 'string' && cfConnectingIp.trim().length > 0) {
    return ipKeyGenerator(cfConnectingIp.trim());
  }
  return req.ip ? ipKeyGenerator(req.ip) : 'anon';
};

// CJS compat for the require()-style imports used elsewhere in backend/.
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = { cloudflareIpRateLimitKeyGenerator };
