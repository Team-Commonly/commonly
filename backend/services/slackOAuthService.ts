import axios from 'axios';

export class SlackOAuthConfigurationError extends Error {
  code = 'slack_oauth_not_configured';

  constructor(message = 'Slack OAuth is not configured.') {
    super(message);
    this.name = 'SlackOAuthConfigurationError';
  }
}

export class SlackOAuthExchangeError extends Error {
  code = 'slack_oauth_exchange_failed';

  constructor(message = 'Slack authorization could not be completed.') {
    super(message);
    this.name = 'SlackOAuthExchangeError';
  }
}

export interface SlackOAuthGrant {
  accessToken: string;
  teamId: string;
  teamName?: string;
  slackUserId: string;
  slackUserName?: string;
}

const oauthConfig = (): { clientId: string; clientSecret: string; redirectUri: string } => {
  const { SLACK_CLIENT_ID: clientId, SLACK_CLIENT_SECRET: clientSecret } = process.env;
  const apiBase = String(
    process.env.PUBLIC_API_URL || process.env.BACKEND_URL || 'https://api.commonly.me',
  ).replace(/\/$/, '');
  const redirectUri = process.env.SLACK_OAUTH_REDIRECT_URI
    || `${apiBase}/api/webhooks/slack/oauth/callback`;
  if (!clientId || !clientSecret) {
    throw new SlackOAuthConfigurationError('SLACK_CLIENT_ID and SLACK_CLIENT_SECRET must be configured.');
  }
  return { clientId, clientSecret, redirectUri };
};

export const buildAuthorizeUrl = (state: string): string => {
  const { clientId, redirectUri } = oauthConfig();
  const query = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    state,
    // App Home DM plus the registered /commonly command. The operator-side
    // manifest carries the matching scopes; keeping this list explicit makes
    // a future scope change visible at the authorization boundary.
    scope: 'im:history,im:write,chat:write,users:read,commands',
  });
  return `https://slack.com/oauth/v2/authorize?${query.toString()}`;
};

export const exchangeCode = async (code: string): Promise<SlackOAuthGrant> => {
  const { clientId, clientSecret, redirectUri } = oauthConfig();
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: redirectUri,
  });
  let response: Record<string, unknown>;
  try {
    const result = await axios.post('https://slack.com/api/oauth.v2.access', body.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    response = result.data as Record<string, unknown>;
  } catch {
    throw new SlackOAuthExchangeError();
  }

  const team = response.team as { id?: unknown; name?: unknown } | undefined;
  const authedUser = response.authed_user as { id?: unknown; name?: unknown } | undefined;
  if (
    response.ok !== true
    || typeof response.access_token !== 'string'
    || !team?.id
    || !authedUser?.id
  ) {
    throw new SlackOAuthExchangeError();
  }
  return {
    accessToken: response.access_token,
    teamId: String(team.id),
    ...(team.name ? { teamName: String(team.name) } : {}),
    slackUserId: String(authedUser.id),
    ...(authedUser.name ? { slackUserName: String(authedUser.name) } : {}),
  };
};

module.exports = {
  SlackOAuthConfigurationError,
  SlackOAuthExchangeError,
  buildAuthorizeUrl,
  exchangeCode,
};
