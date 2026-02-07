const express = require('express');
const auth = require('../../middleware/auth');
const adminAuth = require('../../middleware/adminAuth');
const Integration = require('../../models/Integration');
const Pod = require('../../models/Pod');
const registry = require('../../integrations');
const SocialPolicyService = require('../../services/socialPolicyService');
let PGPod = null;
if (process.env.PG_HOST) {
  // eslint-disable-next-line global-require
  PGPod = require('../../models/pg/Pod');
}

const router = express.Router();
const getUserId = (req) => req.userId || req.user?.id || req.user?.userId || null;

const ensureGlobalPodPostgresSync = async ({ pod, userId }) => {
  if (!PGPod || !pod?._id || !userId) return;
  const podId = String(pod._id);
  try {
    const existing = await PGPod.findById(podId);
    if (!existing) {
      await PGPod.create(
        pod.name || 'Global Social Feed',
        pod.description || "Commonly's curated social media feeds",
        pod.type || 'chat',
        userId,
        podId,
      );
      return;
    }
    await PGPod.addMember(podId, userId);
  } catch (error) {
    console.warn('[global-integrations] PostgreSQL pod sync failed:', error.message);
  }
};

const ensureGlobalSocialFeedPod = async (userId) => {
  let globalPod = await Pod.findOne({ name: 'Global Social Feed' });

  if (!globalPod) {
    globalPod = await Pod.create({
      name: 'Global Social Feed',
      description: 'Commonly\'s curated social media feeds',
      type: 'chat',
      members: [userId],
      createdBy: userId,
      tags: ['social', 'global', 'feeds'],
    });
  }

  await ensureGlobalPodPostgresSync({ pod: globalPod, userId });
  return globalPod;
};

/**
 * Get global integrations (X and Instagram)
 * GET /api/admin/integrations/global
 */
router.get('/', auth, adminAuth, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    // Find or create global pod
    const globalPod = await ensureGlobalSocialFeedPod(userId);

    // Fetch X and Instagram integrations
    const xIntegration = await Integration.findOne({
      type: 'x',
      podId: globalPod._id
    });

    const instagramIntegration = await Integration.findOne({
      type: 'instagram',
      podId: globalPod._id
    });

    res.json({
      x: xIntegration || null,
      instagram: instagramIntegration || null,
      socialPolicy: await SocialPolicyService.getPolicy(),
      globalPodId: globalPod._id
    });
  } catch (error) {
    console.error('Error fetching global integrations:', error);
    res.status(500).json({ error: 'Failed to fetch global integrations' });
  }
});

/**
 * Save global social publish policy
 * POST /api/admin/integrations/global/policy
 */
router.post('/policy', auth, adminAuth, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const policy = await SocialPolicyService.setPolicy(req.body || {}, userId);
    return res.json({ success: true, policy });
  } catch (error) {
    console.error('Error saving global social policy:', error);
    return res.status(500).json({ error: 'Failed to save social policy' });
  }
});

/**
 * Save X global integration
 * POST /api/admin/integrations/global/x
 */
router.post('/x', auth, adminAuth, async (req, res) => {
  try {
    const requesterId = getUserId(req);
    if (!requesterId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const {
      enabled,
      accessToken,
      username,
      userId,
      followUsernames,
      followUserIds,
    } = req.body;

    // Validate required fields
    if (!username || !userId || !accessToken) {
      return res.status(400).json({ error: 'Username, userId, and accessToken are required' });
    }

    const normalizeList = (value) => {
      if (Array.isArray(value)) {
        return value.map((item) => String(item || '').trim().replace(/^@/, '')).filter(Boolean);
      }
      if (typeof value === 'string') {
        return value
          .split(',')
          .map((item) => item.trim().replace(/^@/, ''))
          .filter(Boolean);
      }
      return [];
    };

    const normalizedFollowUsernames = Array.from(new Set(normalizeList(followUsernames)));
    const normalizedFollowUserIds = Array.from(new Set(normalizeList(followUserIds)));

    // Find or create global pod
    const globalPod = await ensureGlobalSocialFeedPod(requesterId);

    // Find or create X integration
    let xIntegration = await Integration.findOne({
      type: 'x',
      podId: globalPod._id
    });

    if (xIntegration) {
      // Update existing
      xIntegration.config = {
        ...xIntegration.config,
        accessToken,
        username,
        userId,
        followUsernames: normalizedFollowUsernames,
        followUserIds: normalizedFollowUserIds,
        category: 'Social',
        maxResults: 50,
        exclude: 'retweets,replies',
        apiBase: process.env.X_API_BASE_URL || 'https://api.x.com/2',
        agentAccessEnabled: true,
        globalAgentAccess: true,
      };
      xIntegration.status = enabled ? 'connected' : 'disconnected';
      xIntegration.isActive = enabled;
      await xIntegration.save();
    } else {
      // Create new
      xIntegration = await Integration.create({
        podId: globalPod._id,
        type: 'x',
        status: enabled ? 'connected' : 'disconnected',
        isActive: enabled,
        config: {
          accessToken,
          username,
          userId,
          followUsernames: normalizedFollowUsernames,
          followUserIds: normalizedFollowUserIds,
          category: 'Social',
          maxResults: 50,
          exclude: 'retweets,replies',
          apiBase: process.env.X_API_BASE_URL || 'https://api.x.com/2',
          agentAccessEnabled: true,
          globalAgentAccess: true,
        },
        createdBy: requesterId
      });
    }

    res.json({
      success: true,
      integration: xIntegration
    });
  } catch (error) {
    console.error('Error saving X integration:', error);
    res.status(500).json({ error: 'Failed to save X integration' });
  }
});

/**
 * Save Instagram global integration
 * POST /api/admin/integrations/global/instagram
 */
router.post('/instagram', auth, adminAuth, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const { enabled, accessToken, username, igUserId } = req.body;

    // Validate required fields
    if (!username || !igUserId || !accessToken) {
      return res.status(400).json({ error: 'Username, igUserId, and accessToken are required' });
    }

    // Find or create global pod
    const globalPod = await ensureGlobalSocialFeedPod(userId);

    // Find or create Instagram integration
    let instagramIntegration = await Integration.findOne({
      type: 'instagram',
      podId: globalPod._id
    });

    if (instagramIntegration) {
      // Update existing
      instagramIntegration.config = {
        ...instagramIntegration.config,
        accessToken,
        username,
        igUserId,
        category: 'Social',
        apiBase: process.env.INSTAGRAM_GRAPH_API_BASE || 'https://graph.facebook.com/v19.0',
        agentAccessEnabled: true,
        globalAgentAccess: true,
      };
      instagramIntegration.status = enabled ? 'connected' : 'disconnected';
      instagramIntegration.isActive = enabled;
      await instagramIntegration.save();
    } else {
      // Create new
      instagramIntegration = await Integration.create({
        podId: globalPod._id,
        type: 'instagram',
        status: enabled ? 'connected' : 'disconnected',
        isActive: enabled,
        config: {
          accessToken,
          username,
          igUserId,
          category: 'Social',
          apiBase: process.env.INSTAGRAM_GRAPH_API_BASE || 'https://graph.facebook.com/v19.0',
          agentAccessEnabled: true,
          globalAgentAccess: true,
        },
        createdBy: userId
      });
    }

    res.json({
      success: true,
      integration: instagramIntegration
    });
  } catch (error) {
    console.error('Error saving Instagram integration:', error);
    res.status(500).json({ error: 'Failed to save Instagram integration' });
  }
});

/**
 * Test X connection
 * POST /api/admin/integrations/global/x/test
 */
router.post('/x/test', auth, adminAuth, async (req, res) => {
  try {
    const globalPod = await Pod.findOne({ name: 'Global Social Feed' });
    if (!globalPod) {
      return res.status(404).json({ error: 'Global pod not found' });
    }

    const xIntegration = await Integration.findOne({
      type: 'x',
      podId: globalPod._id
    });

    if (!xIntegration) {
      return res.status(404).json({ error: 'X integration not found' });
    }

    const provider = registry.get(xIntegration.type, xIntegration);
    await provider.validateConfig();

    res.json({ success: true, message: 'X connection successful' });
  } catch (error) {
    console.error('X connection test failed:', error);
    res.status(500).json({ error: error.message || 'Connection test failed' });
  }
});

/**
 * Test Instagram connection
 * POST /api/admin/integrations/global/instagram/test
 */
router.post('/instagram/test', auth, adminAuth, async (req, res) => {
  try {
    const globalPod = await Pod.findOne({ name: 'Global Social Feed' });
    if (!globalPod) {
      return res.status(404).json({ error: 'Global pod not found' });
    }

    const instagramIntegration = await Integration.findOne({
      type: 'instagram',
      podId: globalPod._id
    });

    if (!instagramIntegration) {
      return res.status(404).json({ error: 'Instagram integration not found' });
    }

    const provider = registry.get(instagramIntegration.type, instagramIntegration);
    await provider.validateConfig();

    res.json({ success: true, message: 'Instagram connection successful' });
  } catch (error) {
    console.error('Instagram connection test failed:', error);
    res.status(500).json({ error: error.message || 'Connection test failed' });
  }
});

module.exports = router;
