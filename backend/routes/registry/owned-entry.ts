// Owner controls for a registry entry (TASK-419): rename its displayName, or retire it.
// Retiring sets status 'unpublished', which the catalog and installs already exclude.
// Installations, Users and identity rows are never touched (identity continuity).
const express = require('express');
const auth = require('../../middleware/auth');
const { AgentRegistry } = require('../../models/AgentRegistry');
const User = require('../../models/User');
const AuditLog = require('../../models/AuditLog');
const { getUserId } = require('./helpers');
// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const { rateLimit } = require('express-rate-limit');
// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const { cloudflareIpRateLimitKeyGenerator } = require('../../middleware/ipRateLimit');

const router = express.Router();

const DISPLAY_NAME_MAX = 80;

// The limiter runs before auth: auth does a Mongo lookup, so a limiter behind it protects nothing.
const ownedEntryRateLimit = rateLimit({
  windowMs: 60_000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'test',
  keyGenerator: (req: any) => cloudflareIpRateLimitKeyGenerator(req),
});

router.patch('/agents/:name/owned-entry', ownedEntryRateLimit, auth, async (req: any, res: any) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ error: 'unauthorized' });

    const entry = await AgentRegistry.findOne({ agentName: String(req.params.name).toLowerCase() });
    if (!entry) return res.status(404).json({ error: 'entry_not_found' });

    const actor = await User.findById(userId).select('role').lean();
    const isOwner = entry.publisher?.userId && String(entry.publisher.userId) === String(userId);
    if (!isOwner && actor?.role !== 'admin') {
      return res.status(403).json({ error: 'not_entry_owner', message: 'Only the entry owner or a global admin may change this entry.' });
    }

    const { displayName, retired } = (req.body || {}) as { displayName?: unknown; retired?: unknown };
    const previousName = entry.displayName;
    const previousStatus = entry.status;
    if (displayName !== undefined) {
      const trimmed = typeof displayName === 'string' ? displayName.trim() : '';
      if (!trimmed || trimmed.length > DISPLAY_NAME_MAX) {
        return res.status(400).json({ error: 'invalid_display_name' });
      }
      entry.displayName = trimmed;
    }
    if (retired !== undefined) {
      if (typeof retired !== 'boolean') return res.status(400).json({ error: 'invalid_retired' });
      if (retired) entry.status = 'unpublished';
      else if (entry.status === 'unpublished') entry.status = 'active';
    }

    await entry.save();

    const nameChanged = previousName !== entry.displayName;
    const statusChanged = previousStatus !== entry.status;
    if (nameChanged || statusChanged) {
      // Retire/restore names the action; a rename-only write is 'renamed'.
      const action = !statusChanged
        ? 'registry.entry.renamed'
        : entry.status === 'unpublished' ? 'registry.entry.retired' : 'registry.entry.restored';
      try {
        await AuditLog.create({
          action,
          target: entry.agentName,
          detail: `role=${isOwner ? 'owner' : 'admin'} previousName=${previousName || ''} name=${entry.displayName || ''} previousStatus=${previousStatus} status=${entry.status}`,
          userId,
          ip: req.ip,
          userAgent: req.headers?.['user-agent'],
        });
      } catch (auditErr: any) {
        console.warn('[registry] owned-entry audit log write failed (non-fatal):', auditErr?.message);
      }
    }

    return res.json({
      agentName: entry.agentName,
      displayName: entry.displayName,
      status: entry.status,
    });
  } catch (err: any) {
    console.error('[registry] owned-entry update error:', err?.message);
    return res.status(500).json({ error: 'Server Error' });
  }
});

module.exports = router;
