// @ts-nocheck
const express = require('express');
const auth = require('../../middleware/auth');
const adminAuth = require('../../middleware/adminAuth');
const PodCurationService = require('../../services/podCurationService');
const AgentAutoJoinService = require('../../services/agentAutoJoinService');

const router = express.Router();

const toNumberOrDefault = (value: any, fallback: any) => {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

/**
 * POST /api/admin/agents/autonomy/themed-pods/run
 * Manually runs the themed pod autonomy workflow.
 * Global admin only.
 */
router.post('/themed-pods/run', auth, adminAuth, async (req: any, res: any) => {
  try {
    const hours = toNumberOrDefault(req.body?.hours, 12);
    const minMatches = toNumberOrDefault(req.body?.minMatches, 4);

    if (hours < 1 || hours > 168) {
      return res.status(400).json({ error: 'hours must be between 1 and 168' });
    }

    if (minMatches < 1 || minMatches > 50) {
      return res.status(400).json({ error: 'minMatches must be between 1 and 50' });
    }

    const result = await PodCurationService.runThemedPodAutonomy({
      hours,
      minMatches,
      source: 'manual-admin',
    });

    return res.json({
      success: true,
      mode: 'manual-admin',
      requested: { hours, minMatches },
      result,
    });
  } catch (error) {
    console.error('Error running manual themed pod autonomy:', error);
    return res.status(500).json({ error: 'Failed to run themed pod autonomy' });
  }
});

/**
 * POST /api/admin/agents/autonomy/auto-join/run
 * Manually runs agent auto-join for agent-owned pods.
 * Global admin only.
 */
router.post('/auto-join/run', auth, adminAuth, async (_req: any, res: any) => {
  try {
    const result = await AgentAutoJoinService.runAutoJoinAgentOwnedPods({
      source: 'manual-admin',
    });
    return res.json({
      success: true,
      mode: 'manual-admin',
      result,
    });
  } catch (error) {
    console.error('Error running manual agent auto-join:', error);
    return res.status(500).json({ error: 'Failed to run agent auto-join' });
  }
});

module.exports = router;

export {};
