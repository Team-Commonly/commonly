// eslint-disable-next-line global-require
const express = require('express');
// eslint-disable-next-line global-require
const crypto = require('crypto');
// eslint-disable-next-line global-require
const auth = require('../middleware/auth');
// eslint-disable-next-line global-require
const Pod = require('../models/Pod');
// eslint-disable-next-line global-require
const Integration = require('../models/Integration');
// eslint-disable-next-line global-require
const InstallableInstallation = require('../models/InstallableInstallation');
// eslint-disable-next-line global-require
const isPodMember = require('../utils/isPodMember');
// eslint-disable-next-line global-require
const { randomSecret } = require('../utils/secret');
// eslint-disable-next-line global-require
const { mintConnectCode } = require('../services/telegramConnectCode');
// eslint-disable-next-line global-require
const connectorSecrets = require('../services/connectorSecrets');
// eslint-disable-next-line global-require
const SlackApi = require('../services/slackApi');
// eslint-disable-next-line global-require
const {
  SlackOAuthConfigurationError,
  SlackOAuthExchangeError,
  buildAuthorizeUrl,
  exchangeCode,
} = require('../services/slackOAuthService');
import { Types } from 'mongoose';
import { writeIntegrationsRateLimit } from '../middleware/integrationRateLimit';
// eslint-disable-next-line global-require
const {
  InstallLockLostError,
  InstallableAlreadyInstalledError,
  InstallableNotFoundError,
  InstallableProjectionError,
  InstallInProgressError,
  install,
  uninstall,
} = require('../services/installable/installableInstallationService');

interface AuthReq {
  user?: { id?: string; _id?: string };
  userId?: string;
  params?: Record<string, string>;
  body?: Record<string, unknown>;
  query?: Record<string, unknown>;
  headers?: Record<string, string | string[] | undefined>;
}

interface Res {
  status: (status: number) => Res;
  json: (body: unknown) => void;
  redirect: (status: number, url: string) => Res;
  cookie?: (name: string, value: string, options: Record<string, unknown>) => Res;
  clearCookie?: (name: string, options?: Record<string, unknown>) => Res;
}

const router: ReturnType<typeof express.Router> = express.Router();

const requesterId = (req: AuthReq): string | undefined => req.userId || req.user?.id || req.user?._id;

const SLACK_NONCE_COOKIE = 'commonly_slack_oauth_nonce';
const SLACK_NONCE_TTL_MS = 5 * 60_000;
const SLACK_BIND_TTL_MS = 10 * 60_000;

// This is a high-entropy, short-lived browser nonce rather than a password.
// The HMAC key makes a database read useless as an offline oracle; the domain
// label prevents this digest from being reused by another JWT-secret caller.
const slackNonceDigest = (nonce: string): string => {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET is required for Slack OAuth state verification');
  return crypto.createHmac('sha256', secret).update(`slack-oauth-nonce:v1|${nonce}`).digest('hex');
};

const cookieValue = (req: AuthReq, name: string): string | undefined => {
  const header = req.headers?.cookie;
  const serialized = Array.isArray(header) ? header.join(';') : header;
  if (!serialized) return undefined;
  const hit = serialized.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  if (!hit) return undefined;
  try {
    return decodeURIComponent(hit.slice(name.length + 1));
  } catch {
    return undefined;
  }
};

const ownedSlackIntegration = async (userId: string): Promise<{ installation: any; integration: any } | null> => {
  const installation = await InstallableInstallation.findOne({
    installableId: 'slack',
    targetType: 'user',
    targetId: userId,
    status: 'active',
  });
  if (!installation) return null;
  const integration = await Integration.findOne({ installationId: String(installation._id), type: 'slack' });
  return integration ? { installation, integration } : null;
};

const slackError = (res: Res, status: number, code: string, error: string): void => {
  res.status(status).json({ code, error });
};

const publicAppUrl = (): string => {
  const configured = String(process.env.PUBLIC_APP_URL || process.env.FRONTEND_URL || 'https://commonly.me')
    .split(',')[0]
    .trim();
  return (configured || 'https://commonly.me').replace(/\/+$/, '');
};

const slackCallbackRedirect = (res: Res, state: 'pending' | 'error', code?: string): Res => {
  res.clearCookie?.(SLACK_NONCE_COOKIE, {
    httpOnly: true,
    sameSite: 'lax',
    secure: true,
    path: '/api/webhooks/slack/oauth/callback',
  });
  const query = new URLSearchParams({ slack: state });
  if (code) query.set('code', code);
  // Connectors is a v2 shell route; `/connectors` is not a mounted page on
  // the public app, so send the browser to the actual rendered surface.
  return res.redirect(302, `${publicAppUrl()}/v2/connectors?${query.toString()}`);
};

// Mongoose's Integration toJSON transform is the normal guard. Keep this
// small route-bound backstop too: tests, lean queries, and a future service
// refactor must not accidentally turn an opaque ConnectorSecret ref into API
// data merely by bypassing document serialization.
const publicIntegration = (integration: unknown): unknown => {
  if (!integration || typeof integration !== 'object') return integration;
  const raw = typeof (integration as { toJSON?: () => unknown }).toJSON === 'function'
    ? (integration as { toJSON: () => unknown }).toJSON()
    : JSON.parse(JSON.stringify(integration));
  if (!raw || typeof raw !== 'object') return raw;
  const result = raw as { config?: Record<string, unknown> };
  if (!result.config) return result;
  delete result.config.botTokenRef;
  const pending = result.config.pendingBind;
  if (pending && typeof pending === 'object') delete (pending as Record<string, unknown>).botTokenRef;
  return result;
};

/**
 * POST /api/installables/slack/authorize-url
 *
 * The lifecycle's minted connect code is Slack's OAuth state. A second,
 * short-lived HttpOnly nonce binds the browser which asked for the link; the
 * unauthenticated callback checks both before it ever calls Slack.
 */
router.post('/slack/authorize-url', writeIntegrationsRateLimit, auth, async (req: AuthReq, res: Res) => {
  const userId = requesterId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const owned = await ownedSlackIntegration(userId);
    if (!owned) return slackError(res, 404, 'slack_installation_not_found', 'Slack installation not found.');
    let code = owned.integration.config?.connectCode;
    let expiresAt = owned.integration.config?.connectCodeExpiresAt;
    if (!owned.integration.isActive) {
      return slackError(res, 409, 'slack_authorization_unavailable', 'Slack authorization is no longer available.');
    }
    if (owned.integration.config?.chatId || owned.integration.config?.pendingBind) {
      return slackError(res, 409, 'slack_already_authorized', 'Slack is already awaiting confirmation or connected.');
    }
    // OAuth state expires after ten minutes. Re-mint it here, rather than
    // forcing an otherwise healthy installed connector through Disconnect
    // before the owner can try Slack again. The same no-chat/no-pending CAS
    // prevents a second browser from replacing a state that has already
    // reached Slack's callback.
    if (!code || !expiresAt || new Date(expiresAt) <= new Date()) {
      const minted = mintConnectCode();
      const reminted = await Integration.findOneAndUpdate(
        {
          _id: owned.integration._id,
          type: 'slack',
          isActive: true,
          'config.chatId': { $exists: false },
          'config.pendingBind': { $exists: false },
        },
        {
          $set: {
            'config.connectCode': minted.connectCode,
            'config.connectCodeExpiresAt': minted.connectCodeExpiresAt,
          },
          $unset: {
            'config.oauthStateNonceHash': 1,
            'config.oauthStateNonceExpiresAt': 1,
            'config.oauthStateClaimId': 1,
          },
        },
        { new: true },
      );
      if (!reminted) {
        return slackError(res, 409, 'slack_authorization_unavailable', 'Slack authorization is no longer available.');
      }
      code = reminted.config?.connectCode;
      expiresAt = reminted.config?.connectCodeExpiresAt;
    }
    if (!code || !expiresAt || new Date(expiresAt) <= new Date()) {
      return slackError(res, 409, 'slack_authorization_unavailable', 'Slack authorization is no longer available.');
    }
    // Fail configuration before writing a nonce. Otherwise a deployment with
    // missing OAuth settings consumes a browser attempt it can never service.
    const url = buildAuthorizeUrl(String(code));
    const nonce = randomSecret(32);
    const now = new Date();
    const claimed = await Integration.findOneAndUpdate(
      {
        _id: owned.integration._id,
        type: 'slack',
        isActive: true,
        'config.connectCode': code,
        'config.connectCodeExpiresAt': { $gt: now },
        'config.chatId': { $exists: false },
        'config.pendingBind': { $exists: false },
      },
      {
        $set: {
          'config.oauthStateNonceHash': slackNonceDigest(nonce),
          'config.oauthStateNonceExpiresAt': new Date(now.getTime() + SLACK_NONCE_TTL_MS),
        },
        $unset: { 'config.oauthStateClaimId': 1 },
      },
      { new: true },
    );
    if (!claimed) {
      return slackError(res, 409, 'slack_authorization_unavailable', 'Slack authorization is no longer available.');
    }
    // Keep these options at the sink: CodeQL must be able to prove that the
    // browser-bound nonce is never script-readable or sent over HTTP.
    res.cookie?.(SLACK_NONCE_COOKIE, nonce, {
      httpOnly: true,
      sameSite: 'lax',
      secure: true,
      maxAge: SLACK_NONCE_TTL_MS,
      path: '/api/webhooks/slack/oauth/callback',
    });
    return res.json({ authorizeUrl: url, expiresAt });
  } catch (error) {
    if (error instanceof SlackOAuthConfigurationError) {
      const oauthError = error as { code: string; message: string };
      return slackError(res, 503, oauthError.code, oauthError.message);
    }
    console.error('[slack-oauth] could not create authorize URL:', (error as Error).message);
    return slackError(res, 500, 'slack_authorization_failed', 'Could not begin Slack authorization.');
  }
});

/**
 * GET /api/webhooks/slack/oauth/callback
 *
 * This deliberately lives in the installables router so it shares the owner
 * and lifecycle helpers, but server mounts it separately below the Slack raw
 * webhook path. It never trusts the Slack identity as Commonly identity:
 * callback only creates a pending bind for the authenticated owner to confirm.
 */
const slackOAuthCallback = async (req: AuthReq, res: Res) => {
  const state = typeof req.query?.state === 'string' ? req.query.state : '';
  const code = typeof req.query?.code === 'string' ? req.query.code : '';
  const nonce = cookieValue(req, SLACK_NONCE_COOKIE);
  if (!state || !code || !nonce) {
    return slackCallbackRedirect(res, 'error', 'invalid_state');
  }
  const now = new Date();
  const claimId = randomSecret(16);
  let integration: any;
  try {
    // Claim before exchange. This consumes the one-use browser state across
    // replicas while still allowing a transient exchange failure to unclaim
    // below. No forged or replayed state can spend Slack exchange capacity.
    integration = await Integration.findOneAndUpdate(
      {
        type: 'slack',
        isActive: true,
        'config.connectCode': state,
        'config.connectCodeExpiresAt': { $gt: now },
        'config.oauthStateNonceHash': slackNonceDigest(nonce),
        'config.oauthStateNonceExpiresAt': { $gt: now },
        'config.oauthStateClaimId': { $exists: false },
        'config.chatId': { $exists: false },
        'config.pendingBind': { $exists: false },
      },
      { $set: { 'config.oauthStateClaimId': claimId } },
      { new: true },
    );
    if (!integration) {
      return slackCallbackRedirect(res, 'error', 'invalid_state');
    }
    const { accessToken, ...binding } = await exchangeCode(code);
    const dm = await new SlackApi(accessToken).openConversation(binding.slackUserId);
    if (!dm.ok || !dm.channel?.id) throw new SlackOAuthExchangeError();
    const botTokenRef = await connectorSecrets.put(String(integration._id), 'slack', accessToken);
    const committed = await Integration.findOneAndUpdate(
      {
        _id: integration._id,
        type: 'slack',
        isActive: true,
        'config.connectCode': state,
        'config.oauthStateClaimId': claimId,
        'config.chatId': { $exists: false },
      },
      {
        $set: {
          'config.pendingBind': {
            ...binding,
            chatId: dm.channel.id,
            botTokenRef,
            expiresAt: new Date(Date.now() + SLACK_BIND_TTL_MS),
          },
        },
        $unset: {
          'config.connectCode': 1,
          'config.connectCodeExpiresAt': 1,
          'config.oauthStateNonceHash': 1,
          'config.oauthStateNonceExpiresAt': 1,
          'config.oauthStateClaimId': 1,
        },
      },
      { new: true },
    );
    if (!committed) {
      await connectorSecrets.revoke(botTokenRef);
      return slackCallbackRedirect(res, 'error', 'state_consumed');
    }
    return slackCallbackRedirect(res, 'pending');
  } catch (error) {
    if (integration?._id) {
      await Integration.updateOne(
        { _id: integration._id, 'config.oauthStateClaimId': claimId },
        { $unset: { 'config.oauthStateClaimId': 1 } },
      );
    }
    if (error instanceof SlackOAuthConfigurationError || error instanceof SlackOAuthExchangeError) {
      const oauthError = error as { code: string; message: string };
      return slackCallbackRedirect(res, 'error', oauthError.code);
    }
    console.error('[slack-oauth] callback failed:', (error as Error).message);
    return slackCallbackRedirect(res, 'error', 'callback_failed');
  }
};

// The public Slack redirect must sit under the webhook origin, while its
// owner-facing lifecycle siblings remain under /api/installables. Export a
// narrow mounted router rather than duplicating callback logic or adding a
// broad unauthenticated path to this router.
const slackOAuthCallbackRouter: ReturnType<typeof express.Router> = express.Router();
slackOAuthCallbackRouter.get('/callback', writeIntegrationsRateLimit, slackOAuthCallback);

router.post('/slack/confirm', writeIntegrationsRateLimit, auth, async (req: AuthReq, res: Res) => {
  const userId = requesterId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const owned = await ownedSlackIntegration(userId);
  if (!owned) return slackError(res, 404, 'slack_installation_not_found', 'Slack installation not found.');
  const pending = owned.integration.config?.pendingBind;
  if (!pending) return slackError(res, 409, 'slack_bind_missing', 'There is no Slack authorization to confirm.');
  if (new Date(pending.expiresAt) <= new Date()) {
    const cleared = await Integration.findOneAndUpdate(
      { _id: owned.integration._id, 'config.pendingBind.botTokenRef': pending.botTokenRef },
      {
        $set: { status: 'pending', errorMessage: null },
        $unset: { 'config.pendingBind': 1 },
      },
      { new: true },
    );
    if (cleared) await connectorSecrets.revoke(pending.botTokenRef);
    return slackError(res, 409, 'slack_bind_expired', 'Slack authorization expired. Start again.');
  }
  const pod = await Pod.findById(owned.integration.podId);
  if (!pod || !isPodMember(pod, userId)) {
    return slackError(res, 403, 'slack_pod_access_denied', 'You no longer have access to this pod.');
  }
  const confirmed = await Integration.findOneAndUpdate(
    {
      _id: owned.integration._id,
      type: 'slack',
      isActive: true,
      'config.pendingBind.botTokenRef': pending.botTokenRef,
      'config.pendingBind.expiresAt': { $gt: new Date() },
      'config.chatId': { $exists: false },
    },
    {
      $set: {
        status: 'connected',
        'config.teamId': pending.teamId,
        'config.teamName': pending.teamName,
        'config.slackUserId': pending.slackUserId,
        'config.slackUserName': pending.slackUserName,
        'config.chatId': pending.chatId,
        'config.chatType': 'im',
        'config.botTokenRef': pending.botTokenRef,
      },
      $unset: { 'config.pendingBind': 1 },
    },
    { new: true },
  );
  if (!confirmed) return slackError(res, 409, 'slack_bind_missing', 'Slack authorization is no longer available.');
  // Confirmation is the point at which this DM becomes a real attention
  // surface. Send the one explicit round-trip marker the stranger smoke uses;
  // an API hiccup must not undo the already durable owner confirmation.
  try {
    const token = await connectorSecrets.get(pending.botTokenRef);
    const livePod = await Pod.findById(confirmed.podId).select('name').lean();
    await new SlackApi(token).postMessage(
      pending.chatId,
      `[${String(livePod?.name || 'Commonly')}] connected`,
    );
  } catch (error) {
    console.warn('[slack-oauth] connected marker could not be sent:', (error as Error).message);
  }
  return res.json({ status: 'connected', integration: publicIntegration(confirmed) });
});

router.post('/slack/reject', writeIntegrationsRateLimit, auth, async (req: AuthReq, res: Res) => {
  const userId = requesterId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const owned = await ownedSlackIntegration(userId);
  if (!owned) return slackError(res, 404, 'slack_installation_not_found', 'Slack installation not found.');
  const pending = owned.integration.config?.pendingBind;
  if (!pending) return slackError(res, 409, 'slack_bind_missing', 'There is no Slack authorization to reject.');
  const rejected = await Integration.findOneAndUpdate(
    { _id: owned.integration._id, 'config.pendingBind.botTokenRef': pending.botTokenRef },
    { $unset: { 'config.pendingBind': 1 } },
    { new: true },
  );
  if (!rejected) return slackError(res, 409, 'slack_bind_missing', 'Slack authorization is no longer available.');
  await connectorSecrets.revoke(pending.botTokenRef);
  return res.json({ status: 'rejected' });
});

const sendInstallError = (error: Error, res: Res): void => {
  if (error instanceof InstallableNotFoundError) {
    res.status(404).json({ code: 'installable_not_found', error: error.message });
    return;
  }
  if (error instanceof InstallLockLostError) {
    res.status(409).json({ code: 'install_lock_lost', error: error.message });
    return;
  }
  if (error instanceof InstallInProgressError) {
    const { boundPodId } = error as Error & { boundPodId?: string };
    res.status(409).json({
      code: 'install_in_progress',
      error: error.message,
      ...(boundPodId ? { boundPodId } : {}),
    });
    return;
  }
  if (error instanceof InstallableAlreadyInstalledError) {
    const { boundPodId } = error as Error & { boundPodId: string };
    res.status(409).json({
      code: 'already_installed',
      error: error.message,
      boundPodId,
    });
    return;
  }
  if (error instanceof InstallableProjectionError) {
    res.status(422).json({ code: 'install_projection_failed', error: error.message });
    return;
  }
  if (/must be a valid ObjectId/.test(error.message)) {
    res.status(400).json({ error: error.message });
    return;
  }
  console.error('[installable] install failed:', error.message);
  res.status(500).json({ error: 'Could not install connector' });
};

/**
 * POST /api/installables/:installableId/install
 *
 * Phase 1 is intentionally narrow: the only client choice is the pod that
 * becomes this user-scoped connector's first gate. Target identity is always
 * taken from auth, never from a body field.
 */
router.post('/:installableId/install', writeIntegrationsRateLimit, auth, async (req: AuthReq, res: Res) => {
  const body = req.body || {};
  if (Array.isArray(body) || typeof body !== 'object') {
    return res.status(400).json({ error: 'Body must be an object with podId' });
  }
  if (Object.keys(body).some((key) => key !== 'podId')) {
    return res.status(400).json({ error: 'Only podId is accepted when installing a connector' });
  }
  const podId = body.podId;
  if (typeof podId !== 'string' || !podId) {
    return res.status(400).json({ error: 'podId is required' });
  }
  if (!Types.ObjectId.isValid(podId)) {
    return res.status(400).json({ error: 'podId must be a valid ObjectId' });
  }
  const userId = requesterId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const pod = await Pod.findById(podId);
    if (!pod || !isPodMember(pod, userId)) {
      return res.status(403).json({ error: 'Access denied' });
    }
    const result = await install({
      installableId: String(req.params?.installableId || ''),
      installedBy: String(userId),
      podId,
    });
    return res.status(result.httpStatus).json({
      status: result.state,
      installation: result.installation,
      integration: publicIntegration(result.integration),
      ...(result.boundPodId ? { boundPodId: result.boundPodId } : {}),
    });
  } catch (error) {
    return sendInstallError(error as Error, res);
  }
});

/**
 * DELETE /api/installables/:installableId/install
 *
 * There is no installation id in the path or body. The user's target row is
 * the only row this endpoint can ever deactivate, even if they share its pod.
 */
router.delete('/:installableId/install', writeIntegrationsRateLimit, auth, async (req: AuthReq, res: Res) => {
  const userId = requesterId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const installation = await uninstall({
      installableId: String(req.params?.installableId || ''),
      installedBy: String(userId),
    });
    if (installation.status === 'uninstalling') {
      return res.status(202).json({ status: 'uninstalling', installation });
    }
    return res.json({ status: 'uninstalled', installation });
  } catch (error) {
    return sendInstallError(error as Error, res);
  }
});

module.exports = router;
module.exports.slackOAuthCallbackRouter = slackOAuthCallbackRouter;
