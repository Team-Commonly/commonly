// Owner controls for a registry entry (TASK-419): rename its displayName, or retire it.
// Retiring sets status 'unpublished', which the catalog and installs already exclude.
// Installations, Users and identity rows are never touched (identity continuity).
const express = require('express');
const auth = require('../../middleware/auth');
const { AgentRegistry } = require('../../models/AgentRegistry');
const User = require('../../models/User');
const { getUserId } = require('./helpers');

const router = express.Router();

const DISPLAY_NAME_MAX = 80;

router.patch('/agents/:name/owned-entry', auth, async (req: any, res: any) => {
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
