import rateLimit from 'express-rate-limit';
// eslint-disable-next-line global-require
const express = require('express');
// eslint-disable-next-line global-require
const User = require('../models/User');
// eslint-disable-next-line global-require
const { cloudflareIpRateLimitKeyGenerator } = require('../middleware/ipRateLimit');

const router: ReturnType<typeof express.Router> = express.Router();

const unsubscribeRateLimit = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: cloudflareIpRateLimitKeyGenerator,
  handler: (_req: unknown, res: any) => res.status(429).json({
    message: 'rate limit exceeded: 30 email preference updates per hour',
    code: 'rate_limited',
  }),
});

const confirmationPage = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Digest emails disabled</title></head><body style="margin:0;background:#f8f8fb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#111827;"><main style="max-width:560px;margin:64px auto;padding:0 20px;"><section style="background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;padding:24px;"><h1 style="margin:0 0 12px;font-size:24px;letter-spacing:-0.03em;">Daily digests are off</h1><p style="margin:0;color:#4b5563;line-height:1.55;">You will no longer receive Commonly daily digest emails.</p></section></main></body></html>`;

router.get('/unsubscribe/:token', unsubscribeRateLimit, async (req: any, res: any) => {
  try {
    const rawToken = req.params?.token;
    if (typeof rawToken !== 'string') return res.status(404).send('Unsubscribe link not found');
    const safeToken = String(rawToken).replace(/[^a-f0-9]/g, '');
    if (safeToken.length !== 48 || safeToken !== rawToken || !/^[a-f0-9]{48}$/.test(safeToken)) {
      return res.status(404).send('Unsubscribe link not found');
    }

    const user = await User.findOneAndUpdate(
      { digestUnsubscribeToken: safeToken },
      { $set: { 'emailPreferences.dailyDigest': false } },
      { new: true },
    );
    if (!user) return res.status(404).send('Unsubscribe link not found');

    return res.status(200).type('html').send(confirmationPage);
  } catch (error) {
    console.error('Email unsubscribe failed:', (error as Error)?.message || error);
    return res.status(500).send('Unable to update email preferences');
  }
});

export default router;
// CJS compat: let require() return the default export directly
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports["default"]; Object.assign(module.exports, exports);

