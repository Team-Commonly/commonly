const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const User = require('../models/User');
const OAuthLoginState = require('../models/OAuthLoginState');
const {
  isInviteOnlyRegistrationEnabled,
  redeemInvitationCode,
  createDefaultWorkspacePod,
} = require('./authController');

// Social login (GitHub + Google) for HUMAN accounts. Deliberately framework-
// free: two provider entries, an authorization-code flow, and a one-time
// exchange code handed to the frontend. The X/Twitter OAuth code under
// backend/integrations is a separate concern (agent integrations) and is
// intentionally untouched.
//
// Flow (frontend on a different origin than the API, so no cookies):
//   GET  /api/auth/oauth/providers            → which providers are configured
//   GET  /api/auth/oauth/:provider/start      → 302 to provider (state row minted)
//   GET  /api/auth/oauth/:provider/callback   → link-or-create user, then 302 to
//        ${FRONTEND_URL}/v2/oauth/complete?code=<one-time>&next=<path>
//   POST /api/auth/oauth/exchange { code }    → { token, user } (same shape as login)
//
// The JWT never appears in a URL — only the short-lived one-time code does.

const STATE_TTL_MS = 10 * 60 * 1000; // full provider round-trip budget
const EXCHANGE_TTL_MS = 2 * 60 * 1000; // frontend picks this up immediately

interface ProviderProfile {
  providerId: string;
  email: string;
  emailVerified: boolean;
  usernameHint: string;
}

const PROVIDERS: Record<string, {
  label: string;
  clientId: () => string | undefined;
  clientSecret: () => string | undefined;
  authorizeUrl: string;
  scope: string;
  fetchProfile: (code: string, redirectUri: string) => Promise<ProviderProfile>;
}> = {
  github: {
    label: 'GitHub',
    clientId: () => process.env.GITHUB_OAUTH_CLIENT_ID,
    clientSecret: () => process.env.GITHUB_OAUTH_CLIENT_SECRET,
    authorizeUrl: 'https://github.com/login/oauth/authorize',
    scope: 'read:user user:email',
    async fetchProfile(code: string, redirectUri: string): Promise<ProviderProfile> {
      const tokenRes = await axios.post(
        'https://github.com/login/oauth/access_token',
        {
          client_id: process.env.GITHUB_OAUTH_CLIENT_ID,
          client_secret: process.env.GITHUB_OAUTH_CLIENT_SECRET,
          code,
          redirect_uri: redirectUri,
        },
        { headers: { Accept: 'application/json' }, timeout: 15000 },
      );
      const accessToken = tokenRes.data?.access_token;
      if (!accessToken) throw new Error(`GitHub token exchange failed: ${tokenRes.data?.error || 'no access_token'}`);

      // GitHub rejects requests without a User-Agent.
      const ghHeaders = {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'commonly-oauth/0.1',
      };
      const [userRes, emailsRes] = await Promise.all([
        axios.get('https://api.github.com/user', { headers: ghHeaders, timeout: 15000 }),
        axios.get('https://api.github.com/user/emails', { headers: ghHeaders, timeout: 15000 }),
      ]);
      const emails = Array.isArray(emailsRes.data) ? emailsRes.data : [];
      const best = emails.find((e: any) => e.primary && e.verified)
        || emails.find((e: any) => e.verified);
      return {
        providerId: String(userRes.data?.id || ''),
        email: String(best?.email || '').toLowerCase(),
        emailVerified: Boolean(best),
        usernameHint: String(userRes.data?.login || ''),
      };
    },
  },
  google: {
    label: 'Google',
    clientId: () => process.env.GOOGLE_OAUTH_CLIENT_ID,
    clientSecret: () => process.env.GOOGLE_OAUTH_CLIENT_SECRET,
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    scope: 'openid email profile',
    async fetchProfile(code: string, redirectUri: string): Promise<ProviderProfile> {
      const tokenRes = await axios.post(
        'https://oauth2.googleapis.com/token',
        new URLSearchParams({
          client_id: process.env.GOOGLE_OAUTH_CLIENT_ID || '',
          client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET || '',
          code,
          grant_type: 'authorization_code',
          redirect_uri: redirectUri,
        }).toString(),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 15000 },
      );
      const accessToken = tokenRes.data?.access_token;
      if (!accessToken) throw new Error('Google token exchange failed: no access_token');

      const infoRes = await axios.get('https://openidconnect.googleapis.com/v1/userinfo', {
        headers: { Authorization: `Bearer ${accessToken}` },
        timeout: 15000,
      });
      const email = String(infoRes.data?.email || '').toLowerCase();
      return {
        providerId: String(infoRes.data?.sub || ''),
        email,
        emailVerified: infoRes.data?.email_verified === true || infoRes.data?.email_verified === 'true',
        usernameHint: String(infoRes.data?.name || email.split('@')[0] || ''),
      };
    },
  },
};

const isProviderConfigured = (name: string) => {
  const p = PROVIDERS[name];
  return Boolean(p && p.clientId() && p.clientSecret());
};

const frontendUrl = () => String(process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/$/, '');

const callbackUrl = (provider: string, req: any) => {
  const base = String(
    process.env.OAUTH_CALLBACK_BASE_URL || `${req.protocol}://${req.get('host')}`,
  ).replace(/\/$/, '');
  return `${base}/api/auth/oauth/${provider}/callback`;
};

// Only ever redirect back into the app — never to an absolute URL an
// attacker put in ?next= (open-redirect guard).
const safeNextPath = (value: any) => {
  const next = String(value || '');
  return next.startsWith('/') && !next.startsWith('//') ? next : '/v2';
};

const loginErrorRedirect = (res: any, code: string) =>
  res.redirect(`${frontendUrl()}/v2/login?oauthError=${encodeURIComponent(code)}`);

// Derive a unique username from the provider handle. Existing usernames have
// no charset constraint server-side, but keep these URL/mention-friendly.
const generateUsername = async (hint: string, email: string) => {
  const base = (hint || email.split('@')[0] || 'user')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 30) || 'user';
  if (!await User.exists({ username: base })) return base;
  for (let i = 0; i < 5; i += 1) {
    const candidate = `${base}-${crypto.randomBytes(2).toString('hex')}`;
    // eslint-disable-next-line no-await-in-loop
    if (!await User.exists({ username: candidate })) return candidate;
  }
  return `${base}-${crypto.randomBytes(6).toString('hex')}`;
};

const issueSession = (user: any) => {
  const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: '7d' });
  return {
    token,
    verified: user.verified,
    user: {
      id: user.id,
      username: user.username,
      email: user.email,
      profilePicture: user.profilePicture,
      role: user.role,
    },
  };
};

// GET /api/auth/oauth/providers
exports.getOAuthProviders = (_req: any, res: any) => {
  const providers = Object.entries(PROVIDERS)
    .filter(([name]) => isProviderConfigured(name))
    .map(([name, p]) => ({ id: name, label: p.label }));
  return res.json({ providers });
};

// GET /api/auth/oauth/:provider/start?next=/v2&invite=CODE
exports.startOAuth = async (req: any, res: any) => {
  try {
    const provider = String(req.params.provider || '').toLowerCase();
    if (!isProviderConfigured(provider)) {
      return res.status(404).json({ error: 'Unknown or unconfigured OAuth provider.' });
    }

    const state = crypto.randomBytes(24).toString('hex');
    await OAuthLoginState.create({
      provider,
      state,
      invitationCode: String(req.query.invite || '').trim(),
      next: safeNextPath(req.query.next),
      expiresAt: new Date(Date.now() + STATE_TTL_MS),
    });

    const p = PROVIDERS[provider];
    const params = new URLSearchParams({
      client_id: p.clientId() || '',
      redirect_uri: callbackUrl(provider, req),
      scope: p.scope,
      state,
    });
    if (provider === 'google') params.set('response_type', 'code');
    return res.redirect(`${p.authorizeUrl}?${params.toString()}`);
  } catch (err: any) {
    console.error('OAuth start failed:', err.message);
    return res.status(500).json({ error: 'Failed to start OAuth flow' });
  }
};

// GET /api/auth/oauth/:provider/callback?code=...&state=...
exports.oauthCallback = async (req: any, res: any) => {
  const provider = String(req.params.provider || '').toLowerCase();
  try {
    if (!isProviderConfigured(provider)) return loginErrorRedirect(res, 'provider_error');
    if (req.query.error) return loginErrorRedirect(res, 'provider_denied');

    // One-time state: atomically claim it so a replayed callback URL can't
    // mint a second session.
    const stateRow = await OAuthLoginState.findOneAndUpdate(
      {
        provider,
        state: String(req.query.state || ''),
        usedAt: null,
        expiresAt: { $gt: new Date() },
      },
      { $set: { usedAt: new Date() } },
      { new: true },
    );
    if (!stateRow) return loginErrorRedirect(res, 'state_invalid');

    const profile = await PROVIDERS[provider].fetchProfile(
      String(req.query.code || ''),
      callbackUrl(provider, req),
    );
    if (!profile.providerId) return loginErrorRedirect(res, 'provider_error');
    // Linking by email is only safe when the provider vouches for it.
    if (!profile.email || !profile.emailVerified) return loginErrorRedirect(res, 'email_unverified');

    let user = await User.findOne({
      'authProviders.provider': provider,
      'authProviders.providerId': profile.providerId,
    });

    if (!user) {
      user = await User.findOne({ email: profile.email });
      if (user && user.isBot) return loginErrorRedirect(res, 'bot_account');
      if (user) {
        // Existing password account with the same verified email → link.
        user.authProviders.push({
          provider,
          providerId: profile.providerId,
          email: profile.email,
          linkedAt: new Date(),
        });
        // The provider verified this email even if our SMTP loop never did.
        user.verified = true;
        await user.save();
      }
    }

    if (!user) {
      // Brand-new signup. An invitation code carried through /start grants
      // the hosted-agent entitlement; when the instance is invite-only it
      // additionally gates the signup itself (same semantics as password
      // registration — a provided-but-invalid code always fails loudly).
      const code = String(stateRow.invitationCode || '').trim();
      let invitationRedeemed = false;
      if (code) {
        invitationRedeemed = await redeemInvitationCode(code);
        if (!invitationRedeemed) return loginErrorRedirect(res, 'invitation_invalid');
      }
      if (isInviteOnlyRegistrationEnabled() && !invitationRedeemed) {
        return loginErrorRedirect(res, 'invitation_required');
      }

      user = new User({
        username: await generateUsername(profile.usernameHint, profile.email),
        email: profile.email,
        verified: true, // provider-asserted
        entitlements: { cloudAgents: invitationRedeemed },
        authProviders: [{
          provider,
          providerId: profile.providerId,
          email: profile.email,
          linkedAt: new Date(),
        }],
      });
      await user.save();
      await createDefaultWorkspacePod(user._id);
    }

    const exchangeCode = crypto.randomBytes(24).toString('hex');
    stateRow.userId = user._id;
    stateRow.exchangeCode = exchangeCode;
    stateRow.exchangeExpiresAt = new Date(Date.now() + EXCHANGE_TTL_MS);
    await stateRow.save();

    const dest = new URLSearchParams({ code: exchangeCode, next: stateRow.next || '/v2' });
    return res.redirect(`${frontendUrl()}/v2/oauth/complete?${dest.toString()}`);
  } catch (err: any) {
    // provider is user-controlled (req.params) — keep it out of the format
    // string (CodeQL js/tainted-format-string).
    console.error('OAuth callback failed for provider:', provider, err?.response?.data || err.message);
    return loginErrorRedirect(res, 'provider_error');
  }
};

// POST /api/auth/oauth/exchange { code }
exports.exchangeOAuthCode = async (req: any, res: any) => {
  try {
    const code = String(req.body?.code || '');
    if (!code) return res.status(400).json({ error: 'Missing exchange code.' });

    // Atomic claim — the code is single-use.
    const stateRow = await OAuthLoginState.findOneAndUpdate(
      {
        exchangeCode: code,
        exchangedAt: null,
        exchangeExpiresAt: { $gt: new Date() },
      },
      { $set: { exchangedAt: new Date() } },
      { new: true },
    );
    if (!stateRow || !stateRow.userId) {
      return res.status(400).json({ error: 'Invalid or expired exchange code.', code: 'EXCHANGE_INVALID' });
    }

    const user = await User.findById(stateRow.userId);
    if (!user) return res.status(400).json({ error: 'User not found.' });

    return res.json(issueSession(user));
  } catch (err: any) {
    console.error('OAuth exchange failed:', err.message);
    return res.status(500).json({ error: 'Server error' });
  }
};

export {};
