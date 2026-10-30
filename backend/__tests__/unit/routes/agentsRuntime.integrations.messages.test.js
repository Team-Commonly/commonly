jest.mock('../../../middleware/agentRuntimeAuth', () => (req, res, next) => next());
jest.mock('../../../middleware/auth', () => (req, res, next) => next());
jest.mock('../../../middleware/apiTokenScopes', () => ({
  requireApiTokenScopes: () => (req, res, next) => next(),
}));

jest.mock('../../../models/Integration', () => ({
  find: jest.fn(),
  findOne: jest.fn(),
}));

jest.mock('../../../services/agentEventService', () => ({}));
jest.mock('../../../services/agentIdentityService', () => ({
  buildAgentUsername: jest.fn((agentName, instanceId = 'default') => (
    instanceId === 'default' ? agentName : `${agentName}-${instanceId}`
  )),
}));
jest.mock('../../../services/agentMessageService', () => ({}));
jest.mock('../../../services/agentThreadService', () => ({}));
jest.mock('../../../services/podContextService', () => ({}));
jest.mock('../../../services/socialPolicyService', () => ({}));
jest.mock('../../../integrations', () => ({ get: jest.fn() }));
jest.mock('../../../models/Activity', () => ({}));
jest.mock('../../../models/User', () => ({ findById: jest.fn() }));
jest.mock('../../../models/Post', () => ({ findById: jest.fn() }));
jest.mock('../../../models/Pod', () => ({ find: jest.fn() }));
jest.mock('../../../services/dmService', () => ({ getOrCreateAgentDM: jest.fn() }));
jest.mock('../../../models/AgentRegistry', () => ({ AgentInstallation: { findOne: jest.fn(), find: jest.fn() } }));
// TASK-124: the discord branch's fetch is asserted to receive the env token.
jest.mock('../../../services/discordService', () => ({ fetchMessages: jest.fn() }));
// TASK-539: the groupme branch reads its token through connectorSecrets.
jest.mock('../../../services/groupmeService', () => ({ fetchMessages: jest.fn() }));
jest.mock('../../../services/connectorSecrets', () => {
  class ConnectorSecretNotFoundError extends Error {}
  return { get: jest.fn(), ConnectorSecretNotFoundError };
});

const Integration = require('../../../models/Integration');
const DiscordService = require('../../../services/discordService');
const GroupMeService = require('../../../services/groupmeService');
const connectorSecrets = require('../../../services/connectorSecrets');
const router = require('../../../routes/agentsRuntime');

const getRouteHandler = (path, method) => {
  const layer = router.stack.find((entry) => (
    entry.route
    && entry.route.path === path
    && entry.route.methods[method]
  ));
  if (!layer) throw new Error(`Route not found: ${method.toUpperCase()} ${path}`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
};

describe('agentsRuntime integration messages route', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('allows reading global X integration message buffer from any authorized pod install', async () => {
    const handler = getRouteHandler('/pods/:podId/integrations/:integrationId/messages', 'get');

    Integration.findOne.mockReturnValue({
      lean: jest.fn().mockResolvedValue({
        _id: 'global-x-1',
        type: 'x',
        config: {
          agentAccessEnabled: true,
          globalAgentAccess: true,
          messageBuffer: [
            {
              messageId: 'tweet-2',
              content: 'newer post',
              authorName: '@alice',
              authorId: 'u2',
              timestamp: '2026-02-08T01:02:00.000Z',
              metadata: { url: 'https://x.com/alice/status/tweet-2' },
            },
            {
              messageId: 'tweet-1',
              content: 'older post',
              authorName: '@bob',
              authorId: 'u1',
              timestamp: '2026-02-08T01:00:00.000Z',
              metadata: { url: 'https://x.com/bob/status/tweet-1' },
            },
          ],
        },
      }),
    });

    const req = {
      params: { podId: 'pod-1', integrationId: 'global-x-1' },
      query: { limit: '1' },
      agentInstallation: {
        podId: 'pod-1',
        scopes: ['integration:messages:read'],
      },
      agentInstallations: [
        {
          podId: 'pod-1',
          scopes: ['integration:messages:read'],
        },
      ],
    };
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };

    await handler(req, res);

    expect(Integration.findOne).toHaveBeenCalledWith({
      _id: 'global-x-1',
      'config.agentAccessEnabled': true,
      status: 'connected',
      isActive: true,
      $or: [
        { podId: 'pod-1' },
        { 'config.globalAgentAccess': true },
      ],
    });
    expect(res.json).toHaveBeenCalledWith({
      messages: [
        expect.objectContaining({
          id: 'tweet-2',
          content: 'newer post',
          author: '@alice',
        }),
      ],
    });
  });

  // TASK-124: this route resolves the token itself, and it used to 400 when the
  // row carried no copy - so a rotation would have looked like a Discord fault.
  describe('discord: the token comes from the environment', () => {
    const ENV_TOKEN = 'env-token-after-rotation';
    const STORED_TOKEN = 'stored-token-from-before-rotation';
    const savedEnv = process.env.DISCORD_BOT_TOKEN;

    const discordRow = (config = {}) => ({
      lean: jest.fn().mockResolvedValue({
        _id: 'discord-1',
        type: 'discord',
        config: {
          agentAccessEnabled: true,
          globalAgentAccess: true,
          channelId: '123456789012345679',
          ...config,
        },
      }),
    });

    const call = async () => {
      const handler = getRouteHandler('/pods/:podId/integrations/:integrationId/messages', 'get');
      const req = {
        params: { podId: 'pod-1', integrationId: 'discord-1' },
        query: {},
        agentInstallation: { podId: 'pod-1', scopes: ['integration:messages:read'] },
        agentInstallations: [{ podId: 'pod-1', scopes: ['integration:messages:read'] }],
      };
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      };
      await handler(req, res);
      return res;
    };

    afterEach(() => {
      if (savedEnv === undefined) delete process.env.DISCORD_BOT_TOKEN;
      else process.env.DISCORD_BOT_TOKEN = savedEnv;
    });

    it('fetches with the env token even when the row carries a stale copy', async () => {
      process.env.DISCORD_BOT_TOKEN = ENV_TOKEN;
      DiscordService.fetchMessages.mockResolvedValue([]);
      Integration.findOne.mockReturnValue(discordRow({ botToken: STORED_TOKEN }));

      const res = await call();

      expect(DiscordService.fetchMessages).toHaveBeenCalledWith(
        expect.objectContaining({ botToken: ENV_TOKEN, channelId: '123456789012345679' }),
      );
      expect(res.status).not.toHaveBeenCalledWith(400);
    });

    it('does not 400 a row that predates the copy being retired, when the env supplies the token', async () => {
      process.env.DISCORD_BOT_TOKEN = ENV_TOKEN;
      DiscordService.fetchMessages.mockResolvedValue([]);
      Integration.findOne.mockReturnValue(discordRow());

      const res = await call();

      expect(DiscordService.fetchMessages).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalledWith(400);
    });

    it('refuses when neither the environment nor the row has a token', async () => {
      delete process.env.DISCORD_BOT_TOKEN;
      Integration.findOne.mockReturnValue(discordRow());

      const res = await call();

      expect(res.status).toHaveBeenCalledWith(400);
      expect(DiscordService.fetchMessages).not.toHaveBeenCalled();
    });
  });
  // TASK-539: the token lives in connectorSecrets, and the row's own copy is
  // never read, so a stale plaintext token cannot be served.
  describe('groupme: the token comes from the connector secret', () => {
    const groupmeRow = (config = {}) => ({
      lean: jest.fn().mockResolvedValue({
        _id: 'groupme-1',
        type: 'groupme',
        config: {
          agentAccessEnabled: true, globalAgentAccess: true, groupId: 'group-1', ...config,
        },
      }),
    });

    const call = async () => {
      const handler = getRouteHandler('/pods/:podId/integrations/:integrationId/messages', 'get');
      const req = {
        params: { podId: 'pod-1', integrationId: 'groupme-1' },
        query: {},
        agentInstallation: { podId: 'pod-1', scopes: ['integration:messages:read'] },
        agentInstallations: [{ podId: 'pod-1', scopes: ['integration:messages:read'] }],
      };
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      await handler(req, res);
      return res;
    };

    it('fetches with the secret behind the ref, not the row copy', async () => {
      connectorSecrets.get.mockResolvedValue('groupme-secret-token');
      GroupMeService.fetchMessages.mockResolvedValue([]);
      Integration.findOne.mockReturnValue(groupmeRow({ accessTokenRef: 'ref-1', accessToken: 'stale-copy' }));

      const res = await call();

      expect(connectorSecrets.get).toHaveBeenCalledWith('ref-1');
      expect(GroupMeService.fetchMessages).toHaveBeenCalledWith(
        expect.objectContaining({ accessToken: 'groupme-secret-token', groupId: 'group-1' }),
      );
      expect(res.status).not.toHaveBeenCalledWith(400);
    });

    it('refuses a row that carries only a plaintext copy', async () => {
      Integration.findOne.mockReturnValue(groupmeRow({ accessToken: 'plaintext-only' }));

      const res = await call();

      expect(res.status).toHaveBeenCalledWith(400);
      expect(GroupMeService.fetchMessages).not.toHaveBeenCalled();
    });

    it('refuses, rather than 500s, when the secret behind the ref is gone', async () => {
      connectorSecrets.get.mockRejectedValue(new connectorSecrets.ConnectorSecretNotFoundError('gone'));
      Integration.findOne.mockReturnValue(groupmeRow({ accessTokenRef: 'ref-gone' }));

      const res = await call();

      expect(res.status).toHaveBeenCalledWith(400);
      expect(GroupMeService.fetchMessages).not.toHaveBeenCalled();
    });

    it('answers 500, not "missing token", when the key ring or decryption fails', async () => {
      connectorSecrets.get.mockRejectedValue(new Error('key ring unavailable'));
      Integration.findOne.mockReturnValue(groupmeRow({ accessTokenRef: 'ref-1' }));

      const res = await call();

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.status).not.toHaveBeenCalledWith(400);
      expect(GroupMeService.fetchMessages).not.toHaveBeenCalled();
    });
  });
});
