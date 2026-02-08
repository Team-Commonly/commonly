const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const auth = require('../../middleware/auth');
const adminAuth = require('../../middleware/adminAuth');
const Integration = require('../../models/Integration');
const OAuthState = require('../../models/OAuthState');
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
const X_OAUTH_AUTHORIZE_URL = process.env.X_OAUTH_AUTHORIZE_URL || 'https://x.com/i/oauth2/authorize';
const X_OAUTH_TOKEN_URL = process.env.X_OAUTH_TOKEN_URL || 'https://api.x.com/2/oauth2/token';
const X_API_BASE = process.env.X_API_BASE_URL || 'https://api.x.com/2';
const clamp = (value, min, max, fallback) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), min), max);
};

const buildFrontendRedirect = (status, detail, redirectPath = '/admin/integrations/global') => {
  const frontend = process.env.FRONTEND_URL || 'http://localhost:3000';
  const safePath = String(redirectPath || '/admin/integrations/global').startsWith('/')
    ? String(redirectPath || '/admin/integrations/global')
    : '/admin/integrations/global';
  const base = `${frontend}${safePath}`;
  const params = new URLSearchParams({ xOAuth: status });
  if (detail) params.set('detail', String(detail));
  return `${base}?${params.toString()}`;
};

const buildXRedirectUri = () => (
  process.env.X_OAUTH_REDIRECT_URI
  || `${process.env.BACKEND_URL || 'http://localhost:5000'}/api/admin/integrations/global/x/oauth/callback`
);

const getXClientConfig = () => ({
  clientId: process.env.X_OAUTH_CLIENT_ID || process.env.X_CLIENT_ID || '',
  clientSecret: process.env.X_OAUTH_CLIENT_SECRET || process.env.X_CLIENT_SECRET || '',
});

const encodeBase64Url = (buffer) => buffer
  .toString('base64')
  .replace(/\+/g, '-')
  .replace(/\//g, '_')
  .replace(/=+$/g, '');

const createPkcePair = () => {
  const verifier = encodeBase64Url(crypto.randomBytes(48));
  const challenge = encodeBase64Url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
};

const buildTokenHeaders = ({ clientId, clientSecret }) => {
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
  if (clientId && clientSecret) {
    headers.Authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;
  }
  return headers;
};

const getDefaultXScopes = () => (
  String(
    process.env.X_OAUTH_SCOPES
    || 'tweet.read users.read offline.access tweet.write',
  )
    .split(/\s+/)
    .map((scope) => scope.trim())
    .filter(Boolean)
);

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

const normalizeBoolean = (value, fallback = false) => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  }
  return fallback;
};

const upsertXIntegration = async ({
  requesterId,
  globalPodId,
  enabled = true,
  accessToken,
  refreshToken,
  tokenType,
  tokenExpiresAt,
  oauthScopes,
  username,
  userId,
  followUsernames,
  followUserIds,
  followFromAuthenticatedUser,
  followingWhitelistUserIds,
  followingMaxUsers,
}) => {
  let xIntegration = await Integration.findOne({
    type: 'x',
    podId: globalPodId,
  });
  const hasFollowUsernames = followUsernames !== undefined;
  const hasFollowUserIds = followUserIds !== undefined;
  const normalizedFollowUsernames = hasFollowUsernames
    ? Array.from(new Set(normalizeList(followUsernames)))
    : null;
  const normalizedFollowUserIds = hasFollowUserIds
    ? Array.from(new Set(normalizeList(followUserIds)))
    : null;
  const hasFollowingWhitelistUserIds = followingWhitelistUserIds !== undefined;
  const normalizedFollowingWhitelistUserIds = hasFollowingWhitelistUserIds
    ? Array.from(new Set(normalizeList(followingWhitelistUserIds)))
    : null;

  const normalizedScopes = Array.isArray(oauthScopes)
    ? oauthScopes.map((entry) => String(entry || '').trim()).filter(Boolean)
    : [];
  const nextConfig = {
    ...(xIntegration?.config || {}),
    accessToken,
    refreshToken: refreshToken || xIntegration?.config?.refreshToken || '',
    tokenType: tokenType || xIntegration?.config?.tokenType || 'bearer',
    tokenExpiresAt: tokenExpiresAt || xIntegration?.config?.tokenExpiresAt || null,
    oauthScopes: normalizedScopes.length ? normalizedScopes : (xIntegration?.config?.oauthScopes || []),
    username,
    userId,
    followUsernames: hasFollowUsernames
      ? normalizedFollowUsernames
      : (xIntegration?.config?.followUsernames || []),
    followUserIds: hasFollowUserIds
      ? normalizedFollowUserIds
      : (xIntegration?.config?.followUserIds || []),
    followFromAuthenticatedUser: normalizeBoolean(
      followFromAuthenticatedUser,
      Boolean(xIntegration?.config?.followFromAuthenticatedUser),
    ),
    followingWhitelistUserIds: hasFollowingWhitelistUserIds
      ? normalizedFollowingWhitelistUserIds
      : (xIntegration?.config?.followingWhitelistUserIds || []),
    followingMaxUsers: clamp(
      followingMaxUsers,
      1,
      100,
      clamp(xIntegration?.config?.followingMaxUsers, 1, 100, 5),
    ),
    category: 'Social',
    maxResults: 5,
    exclude: 'retweets,replies',
    apiBase: X_API_BASE,
    agentAccessEnabled: true,
    globalAgentAccess: true,
  };

  if (xIntegration) {
    xIntegration.config = nextConfig;
    xIntegration.status = enabled ? 'connected' : 'disconnected';
    xIntegration.isActive = enabled;
    await xIntegration.save();
  } else {
    xIntegration = await Integration.create({
      podId: globalPodId,
      type: 'x',
      status: enabled ? 'connected' : 'disconnected',
      isActive: enabled,
      config: nextConfig,
      createdBy: requesterId,
    });
  }

  return xIntegration;
};

/**
 * Start X OAuth (PKCE)
 * POST /api/admin/integrations/global/x/oauth/start
 */
router.post('/x/oauth/start', auth, adminAuth, async (req, res) => {
  try {
    const requesterId = getUserId(req);
    if (!requesterId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const { clientId } = getXClientConfig();
    if (!clientId) {
      return res.status(400).json({ error: 'X OAuth client id is not configured' });
    }

    const requestedScopes = Array.isArray(req.body?.scopes) && req.body.scopes.length
      ? req.body.scopes
      : getDefaultXScopes();
    const scopes = requestedScopes
      .map((scope) => String(scope || '').trim())
      .filter(Boolean);
    const { verifier, challenge } = createPkcePair();
    const state = encodeBase64Url(crypto.randomBytes(24));
    const redirectPath = req.body?.redirectPath || '/admin/integrations/global';
    const expiresAt = new Date(Date.now() + (10 * 60 * 1000));

    await OAuthState.create({
      provider: 'x',
      state,
      userId: requesterId,
      codeVerifier: verifier,
      redirectPath,
      expiresAt,
    });

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: buildXRedirectUri(),
      scope: scopes.join(' '),
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });

    return res.json({
      success: true,
      authorizeUrl: `${X_OAUTH_AUTHORIZE_URL}?${params.toString()}`,
      state,
      expiresAt,
    });
  } catch (error) {
    console.error('Error starting X OAuth:', error);
    return res.status(500).json({ error: 'Failed to start X OAuth flow' });
  }
});

/**
 * X OAuth callback
 * GET /api/admin/integrations/global/x/oauth/callback
 */
router.get('/x/oauth/callback', async (req, res) => {
  try {
    const {
      state,
      code,
      error: oauthError,
      error_description: errorDescription,
    } = req.query || {};

    if (!state) {
      return res.redirect(buildFrontendRedirect('error', 'missing_oauth_state'));
    }

    const oauthState = await OAuthState.findOneAndUpdate(
      {
        provider: 'x',
        state: String(state),
        usedAt: null,
        expiresAt: { $gt: new Date() },
      },
      {
        $set: { usedAt: new Date() },
      },
      { new: true },
    );

    if (!oauthState) {
      return res.redirect(buildFrontendRedirect('error', 'oauth_state_expired_or_used'));
    }

    if (oauthError) {
      return res.redirect(buildFrontendRedirect(
        'error',
        errorDescription || oauthError,
        oauthState.redirectPath,
      ));
    }
    if (!code) {
      return res.redirect(buildFrontendRedirect('error', 'missing_oauth_code', oauthState.redirectPath));
    }

    const { clientId, clientSecret } = getXClientConfig();
    if (!clientId) {
      return res.redirect(buildFrontendRedirect('error', 'missing_x_client_id', oauthState.redirectPath));
    }

    const tokenBody = new URLSearchParams({
      grant_type: 'authorization_code',
      code: String(code),
      redirect_uri: buildXRedirectUri(),
      code_verifier: oauthState.codeVerifier,
      client_id: clientId,
    });
    const tokenResponse = await axios.post(
      X_OAUTH_TOKEN_URL,
      tokenBody.toString(),
      { headers: buildTokenHeaders({ clientId, clientSecret }) },
    );

    const accessToken = tokenResponse?.data?.access_token;
    const refreshToken = tokenResponse?.data?.refresh_token || '';
    const tokenType = tokenResponse?.data?.token_type || 'bearer';
    const expiresIn = Number(tokenResponse?.data?.expires_in || 0);
    const tokenExpiresAt = Number.isFinite(expiresIn) && expiresIn > 0
      ? new Date(Date.now() + (expiresIn * 1000))
      : null;
    const oauthScopes = String(tokenResponse?.data?.scope || '')
      .split(/\s+/)
      .map((entry) => entry.trim())
      .filter(Boolean);

    if (!accessToken) {
      return res.redirect(buildFrontendRedirect('error', 'missing_x_access_token', oauthState.redirectPath));
    }

    const meResponse = await axios.get(`${X_API_BASE}/users/me`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      params: { 'user.fields': 'id,username,name' },
    });
    const me = meResponse?.data?.data || {};
    if (!me?.id || !me?.username) {
      return res.redirect(buildFrontendRedirect('error', 'x_user_profile_lookup_failed', oauthState.redirectPath));
    }

    const globalPod = await ensureGlobalSocialFeedPod(oauthState.userId);
    await upsertXIntegration({
      requesterId: oauthState.userId,
      globalPodId: globalPod._id,
      enabled: true,
      accessToken,
      refreshToken,
      tokenType,
      tokenExpiresAt,
      oauthScopes,
      username: me.username,
      userId: me.id,
    });

    return res.redirect(buildFrontendRedirect('success', `connected_${me.username}`, oauthState.redirectPath));
  } catch (error) {
    const detail = error?.response?.data?.error_description
      || error?.response?.data?.error
      || error?.response?.data?.detail
      || error?.response?.data?.title
      || error?.message
      || 'oauth_callback_failed';
    console.error('Error handling X OAuth callback:', error?.response?.data || error);
    return res.redirect(buildFrontendRedirect('error', detail));
  }
});

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
      podId: globalPod._id,
    });

    const instagramIntegration = await Integration.findOne({
      type: 'instagram',
      podId: globalPod._id,
    });

    res.json({
      x: xIntegration || null,
      instagram: instagramIntegration || null,
      socialPolicy: await SocialPolicyService.getPolicy(),
      globalPodId: globalPod._id,
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
      followFromAuthenticatedUser,
      followingWhitelistUserIds,
      followingMaxUsers,
    } = req.body;

    // Validate required fields
    if (!username || !userId || !accessToken) {
      return res.status(400).json({ error: 'Username, userId, and accessToken are required' });
    }

    // Find or create global pod
    const globalPod = await ensureGlobalSocialFeedPod(requesterId);
    const xIntegration = await upsertXIntegration({
      requesterId,
      globalPodId: globalPod._id,
      enabled,
      accessToken,
      username,
      userId,
      followUsernames,
      followUserIds,
      followFromAuthenticatedUser,
      followingWhitelistUserIds,
      followingMaxUsers,
    });

    res.json({
      success: true,
      integration: xIntegration,
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
    const {
      enabled, accessToken, username, igUserId,
    } = req.body;

    // Validate required fields
    if (!username || !igUserId || !accessToken) {
      return res.status(400).json({ error: 'Username, igUserId, and accessToken are required' });
    }

    // Find or create global pod
    const globalPod = await ensureGlobalSocialFeedPod(userId);

    // Find or create Instagram integration
    let instagramIntegration = await Integration.findOne({
      type: 'instagram',
      podId: globalPod._id,
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
        createdBy: userId,
      });
    }

    res.json({
      success: true,
      integration: instagramIntegration,
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
      podId: globalPod._id,
    });

    if (!xIntegration) {
      return res.status(404).json({ error: 'X integration not found' });
    }

    const provider = registry.get(xIntegration.type, xIntegration);
    await provider.validateConfig();
    const health = await provider.health();
    if (!health?.ok) {
      return res.status(400).json({
        error: health?.error || 'X connection failed',
        status: health?.status || null,
      });
    }

    res.json({ success: true, message: 'X connection successful' });
  } catch (error) {
    console.error('X connection test failed:', error);
    res.status(500).json({ error: error.message || 'Connection test failed' });
  }
});

/**
 * List following accounts for authenticated global X OAuth integration
 * GET /api/admin/integrations/global/x/following?limit=100
 */
router.get('/x/following', auth, adminAuth, async (req, res) => {
  try {
    const globalPod = await Pod.findOne({ name: 'Global Social Feed' });
    if (!globalPod) {
      return res.status(404).json({ error: 'Global pod not found' });
    }

    const xIntegration = await Integration.findOne({
      type: 'x',
      podId: globalPod._id,
      status: 'connected',
      isActive: true,
    });

    if (!xIntegration) {
      return res.status(404).json({ error: 'X integration not found' });
    }

    const accessToken = xIntegration?.config?.accessToken;
    const userId = xIntegration?.config?.userId;
    if (!accessToken || !userId) {
      return res.status(400).json({ error: 'X integration missing OAuth user context' });
    }

    const limit = clamp(req.query?.limit, 1, 200, 100);
    const response = await axios.get(`${X_API_BASE}/users/${encodeURIComponent(String(userId))}/following`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      params: {
        max_results: limit,
        'user.fields': 'id,username,name',
      },
    });
    const users = Array.isArray(response?.data?.data) ? response.data.data : [];

    return res.json({
      success: true,
      count: users.length,
      users: users.map((user) => ({
        id: String(user?.id || ''),
        username: String(user?.username || ''),
        name: String(user?.name || ''),
      })).filter((user) => user.id),
    });
  } catch (error) {
    console.error('Failed to fetch X following list:', error?.response?.data || error);
    const status = error?.response?.status;
    const detail = error?.response?.data?.detail
      || error?.response?.data?.title
      || error?.response?.data?.error
      || error?.message
      || 'Failed to fetch following list from X';
    return res.status(status && status >= 400 ? status : 500).json({ error: detail });
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
      podId: globalPod._id,
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
