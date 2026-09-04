/* eslint-disable import/extensions, import/no-unresolved */
const { buildAuthorizeUrl } = require('../../../services/slackOAuthService');

const envKeys = [
  'SLACK_CLIENT_ID',
  'SLACK_CLIENT_SECRET',
  'SLACK_OAUTH_REDIRECT_URI',
  'PUBLIC_API_URL',
  'BACKEND_URL',
];
const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));

const restoreEnv = () => {
  envKeys.forEach((key) => {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  });
};

describe('slackOAuthService', () => {
  beforeEach(() => {
    process.env.SLACK_CLIENT_ID = 'slack-client';
    process.env.SLACK_CLIENT_SECRET = 'slack-secret';
    delete process.env.SLACK_OAUTH_REDIRECT_URI;
    delete process.env.PUBLIC_API_URL;
    delete process.env.BACKEND_URL;
  });

  afterAll(restoreEnv);

  it('uses BACKEND_URL for the callback when no public API override is set', () => {
    process.env.BACKEND_URL = 'https://api.self-hosted.test/';

    const authorizeUrl = new URL(buildAuthorizeUrl('connect-code'));

    expect(authorizeUrl.searchParams.get('redirect_uri'))
      .toBe('https://api.self-hosted.test/api/webhooks/slack/oauth/callback');
  });
});
