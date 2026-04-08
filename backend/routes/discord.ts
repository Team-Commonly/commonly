// eslint-disable-next-line global-require
const express = require('express');
// eslint-disable-next-line global-require
const axios = require('axios');
// eslint-disable-next-line global-require
const nacl = require('tweetnacl');
// eslint-disable-next-line global-require
const auth = require('../middleware/auth');
// eslint-disable-next-line global-require
const adminAuth = require('../middleware/adminAuth');
// eslint-disable-next-line global-require
const Integration = require('../models/Integration');
// eslint-disable-next-line global-require
const DiscordIntegration = require('../models/DiscordIntegration');
// eslint-disable-next-line global-require
const Pod = require('../models/Pod');
// eslint-disable-next-line global-require
const User = require('../models/User');
// eslint-disable-next-line global-require
const DiscordService = require('../services/discordService');
// eslint-disable-next-line global-require
const { runDiscordCommandForIntegrations } = require('../services/discordMultiCommandService');

interface AuthReq {
  user?: { id: string; role?: string };
  params?: Record<string, string>;
  query?: Record<string, string>;
  body?: Record<string, unknown>;
  headers?: Record<string, string | undefined>;
  header?: (name: string) => string | undefined;
}
interface Res {
  status: (n: number) => Res;
  json: (d: unknown) => void;
  redirect: (url: string) => void;
  writeHead: (status: number, headers: Record<string, unknown>) => void;
  end: (data?: string) => void;
}

const router: ReturnType<typeof express.Router> = express.Router();

const { DISCORD_PUBLIC_KEY } = process.env;

function verifySignature(req: { headers: Record<string, string | undefined>; body: Buffer }): boolean {
  const signature = req.headers['x-signature-ed25519'];
  const timestamp = req.headers['x-signature-timestamp'];
  const body = req.body.toString('utf8');
  if (!signature || !timestamp || !DISCORD_PUBLIC_KEY) return false;
  try {
    const signatureBytes = Buffer.from(signature, 'hex');
    const publicKeyBytes = Buffer.from(DISCORD_PUBLIC_KEY, 'hex');
    const message = Buffer.from(timestamp + body, 'utf8');
    return nacl.sign.detached.verify(message, signatureBytes, publicKeyBytes);
  } catch (error) {
    console.error('Error verifying signature:', error);
    return false;
  }
}

async function canManagePod(podId: string, userId: string): Promise<boolean> {
  const [user, pod] = await Promise.all([User.findById(userId), Pod.findById(podId)]) as [{ role?: string } | null, { createdBy?: { toString: () => string } } | null];
  if (!user || !pod) return false;
  if ((user as { role?: string }).role === 'admin') return true;
  return pod.createdBy?.toString() === userId;
}

async function canManageIntegration(integration: { createdBy?: { toString: () => string }; podId?: unknown } | null, userId: string): Promise<boolean> {
  const user = await User.findById(userId) as { role?: string } | null;
  if (!user || !integration) return false;
  if (user.role === 'admin') return true;
  if (integration.createdBy?.toString() === userId) return true;
  const pod = await Pod.findById(integration.podId) as { createdBy?: { toString: () => string } } | null;
  return pod?.createdBy?.toString() === userId;
}

async function handleInstallationEvent(interaction: { id?: string; guild_id?: string; user?: { id?: string } }): Promise<{ success: boolean; message?: string; error?: string }> {
  try {
    const { id: installationId, guild_id: serverId, user } = interaction;
    console.log('Handling Discord installation event:', installationId, serverId, user?.id);
    const existingIntegration = await Integration.findOne({ installationId });
    if (existingIntegration) return { success: true, message: 'Installation already exists' };
    console.log('Installation event received - pod binding will be handled by frontend flow');
    return { success: true, message: 'Installation event received' };
  } catch (error) {
    console.error('Error handling installation event:', error);
    return { success: false, error: (error as Error).message };
  }
}

router.get('/channels/:guildId', auth, async (req: AuthReq, res: Res) => {
  try {
    const { guildId } = req.params || {};
    const response = await axios.get(`https://discord.com/api/guilds/${guildId}/channels`, { headers: { Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}` } });
    const textChannels = (response.data as Array<{ type: number; id: string; name: string; topic?: string }>)
      .filter((channel) => channel.type === 0)
      .map((channel) => ({ id: channel.id, name: channel.name, topic: channel.topic }));
    res.json(textChannels);
  } catch (error) {
    const e = error as { response?: { data?: unknown }; message?: string };
    console.error('Error fetching Discord channels:', e.response?.data || e.message);
    res.status(500).json({ message: 'Failed to fetch channels' });
  }
});

router.post('/interactions', async (req: AuthReq & { body: Buffer }, res: Res) => {
  if (!verifySignature(req as { headers: Record<string, string | undefined>; body: Buffer })) {
    return res.status(401).json({ error: 'Invalid signature' });
  }
  let interaction: Record<string, unknown>;
  try {
    interaction = JSON.parse((req.body as unknown as Buffer).toString('utf8'));
  } catch (error) {
    return res.status(400).json({ error: 'Invalid JSON' });
  }
  const { type, data, id: interactionId, token: interactionToken, guild_id: guildId } = interaction as { type: number; data?: { type?: number; name?: string }; id?: string; token?: string; guild_id?: string };

  if (type === 1) {
    const pongBody = JSON.stringify({ type: 1 });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(pongBody) });
    res.end(pongBody);
    return;
  }

  if (type === 2 && (data as { type?: string })?.type === 'INSTALLATION_CREATE') {
    const result = await handleInstallationEvent(interaction as { id?: string; guild_id?: string; user?: { id?: string } });
    if (result.success) return res.json({ type: 4, data: { content: 'Discord bot installed successfully!' } });
    return res.status(500).json({ type: 4, data: { content: 'Failed to process installation' } });
  }

  if (type === 2 && data?.type === 1) {
    const channelId = (interaction as { channel_id?: string }).channel_id;
    try {
      let integrations: Array<{ _id: unknown; podId?: { name?: string }; config?: { channelName?: string } }> = [];
      if (channelId) {
        integrations = await Integration.find({ 'config.serverId': guildId, 'config.channelId': channelId, type: 'discord', isActive: true }).populate('podId', 'name type');
      }
      if (!integrations.length && !channelId) {
        const fallback = await Integration.findOne({ 'config.serverId': guildId, type: 'discord', isActive: true }).populate('podId', 'name type');
        if (fallback) integrations = [fallback];
      }
      if (!integrations.length) return res.json({ type: 4, data: { content: '❌ Discord integration not found for this channel.', flags: 64 } });

      if (integrations.length === 1) {
        const discordService = new DiscordService(integrations[0]._id);
        await discordService.initialize();
        const result = await discordService.handleInteraction(interaction);
        if (result) {
          result.interactionToken = interactionToken;
          result.interactionId = interactionId;
          return res.json(result);
        }
        return res.json({ type: 4, data: { content: '❌ Command not recognized.', flags: 64 } });
      }

      const commandResults = await runDiscordCommandForIntegrations({ commandName: data.name, integrations, guildId, channelId }) as Array<{ integration: typeof integrations[0]; result: { content: string; success: boolean } }>;
      const header = `🔗 ${integrations.length} pods linked to this Discord channel`;
      const blocks = commandResults.map(({ integration, result }) => {
        const podName = (integration.podId as { name?: string })?.name || integration.config?.channelName || `Pod ${integration.podId || integration._id}`;
        return `**${podName}**\n${result.content}`;
      });
      const response: Record<string, unknown> = { type: 4, data: { content: [header, ...blocks].join('\n\n'), flags: commandResults.every(({ result }) => result.success) ? 0 : 64 } };
      response.interactionToken = interactionToken;
      response.interactionId = interactionId;
      return res.json(response);
    } catch (error) {
      console.error('Error handling slash command:', error);
      return res.json({ type: 4, data: { content: '❌ An error occurred while processing the command.', flags: 64 } });
    }
  }

  return res.json({ type: 4, data: { content: 'This interaction type is not supported.', flags: 64 } });
});

router.get('/install-link/:podId', auth, async (req: AuthReq, res: Res) => {
  try {
    const { podId } = req.params || {};
    const clientId = req.query?.clientId || process.env.DISCORD_CLIENT_ID;
    const canManage = await canManagePod(podId || '', req.user?.id || '');
    if (!canManage) return res.status(403).json({ error: 'Access denied' });
    if (!clientId) return res.status(400).json({ error: 'Discord client ID is required' });
    const baseUrl = 'https://discord.com/api/oauth2/authorize';
    const installUrl = `${baseUrl}?client_id=${clientId}&scope=bot%20applications.commands&permissions=536873984&state=pod_${podId}`;
    res.json({ installUrl, podId, status: 'ready' });
  } catch (error) {
    console.error('Error generating installation link:', error);
    res.status(500).json({ error: 'Failed to generate installation link' });
  }
});

router.get('/binding/:podId', auth, async (req: AuthReq, res: Res) => {
  try {
    const { podId } = req.params || {};
    const canManage = await canManagePod(podId || '', req.user?.id || '');
    if (!canManage) return res.status(403).json({ error: 'Access denied' });
    const integration = await Integration.findOne({ podId, type: 'discord', isActive: true });
    if (!integration) return res.status(404).json({ error: 'No Discord integration found for this pod' });
    const discordIntegration = await DiscordIntegration.findOne({ integrationId: integration._id });
    res.json({ integration, discordIntegration });
  } catch (error) {
    console.error('Error getting Discord binding:', error);
    res.status(500).json({ error: 'Failed to get Discord binding' });
  }
});

router.delete('/uninstall/:installationId', auth, async (req: AuthReq, res: Res) => {
  try {
    const { installationId } = req.params || {};
    const integration = await Integration.findOne({ installationId }) as { _id: unknown; createdBy?: { toString: () => string }; podId?: unknown } | null;
    if (!integration) return res.status(404).json({ error: 'Integration not found' });
    const canManage = await canManageIntegration(integration, req.user?.id || '');
    if (!canManage) return res.status(403).json({ error: 'Access denied' });
    await DiscordIntegration.findOneAndDelete({ integrationId: integration._id });
    await Integration.findByIdAndDelete(integration._id);
    res.json({ message: 'Discord integration removed successfully' });
  } catch (error) {
    console.error('Error removing Discord integration:', error);
    res.status(500).json({ error: 'Failed to remove Discord integration' });
  }
});

router.post('/register-commands/:integrationId', auth, async (req: AuthReq, res: Res) => {
  try {
    const { integrationId } = req.params || {};
    const integration = await Integration.findById(integrationId) as { type?: string; config?: { serverId?: string }; createdBy?: { toString: () => string }; podId?: unknown } | null;
    if (!integration) return res.status(404).json({ error: 'Integration not found' });
    if (integration.type !== 'discord') return res.status(400).json({ error: 'Integration is not a Discord integration' });
    const canManage = await canManageIntegration(integration, req.user?.id || '');
    if (!canManage) return res.status(403).json({ error: 'Access denied' });
    const guildId = integration.config?.serverId;
    if (!guildId) return res.status(400).json({ error: 'Server ID not found in integration config' });
    const discordService = new DiscordService(integrationId);
    await discordService.initialize();
    const success = await discordService.registerSlashCommands(guildId);
    if (success) res.json({ message: 'Slash commands registered successfully', commands: ['/commonly-summary', '/discord-status', '/discord-enable', '/discord-disable'] });
    else res.status(500).json({ error: 'Failed to register slash commands' });
  } catch (error) {
    console.error('Error registering slash commands:', error);
    res.status(500).json({ error: 'Failed to register slash commands' });
  }
});

router.get('/health', async (_req: AuthReq, res: Res) => {
  try {
    const { DISCORD_CLIENT_ID: clientId, DISCORD_BOT_TOKEN: botToken } = process.env;
    if (!clientId || !botToken) return res.json({ timestamp: new Date().toISOString(), status: 'no_credentials', message: 'Discord credentials not configured', summary: { total: 0, registered: 0, failed: 0 } });
    const url = `https://discord.com/api/v10/applications/${clientId}/commands`;
    const response = await axios.get(url, { headers: { Authorization: `Bot ${botToken}` } });
    if (response.status === 200) {
      const registeredCommands = (response.data as Array<{ name: string }>).map((cmd) => cmd.name);
      const expectedCommands = ['commonly-summary', 'discord-status', 'discord-enable', 'discord-disable'];
      const missingCommands = expectedCommands.filter((cmd) => !registeredCommands.includes(cmd));
      return res.json({ timestamp: new Date().toISOString(), status: missingCommands.length === 0 ? 'healthy' : 'degraded', globalCommands: { registered: registeredCommands, missing: missingCommands, total: expectedCommands.length }, summary: { total: expectedCommands.length, registered: registeredCommands.length, failed: missingCommands.length } });
    }
    throw new Error(`Discord API returned status ${response.status}`);
  } catch (error) {
    console.error('Error in Discord health check:', error);
    res.status(500).json({ timestamp: new Date().toISOString(), status: 'error', error: (error as Error).message });
  }
});

router.post('/register-all', auth, adminAuth, async (_req: AuthReq, res: Res) => {
  try {
    // eslint-disable-next-line global-require
    const DiscordServiceClass = require('../services/discordService');
    const result = await DiscordServiceClass.registerCommandsForAllIntegrations() as { success: boolean };
    res.json({ success: result.success, message: result.success ? 'All commands registered successfully' : 'Some commands failed to register', details: result });
  } catch (error) {
    console.error('Error in bulk command registration:', error);
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

router.get('/callback', async (req: AuthReq, res: Res) => {
  try {
    const { code, state, guild_id: guildId } = req.query || {};
    if (!code) return res.redirect(`${process.env.FRONTEND_URL}/discord/error?error=No authorization code received`);
    const podId = state?.replace('pod_', '');
    if (!podId) return res.redirect(`${process.env.FRONTEND_URL}/discord/error?error=Invalid state parameter`);
    await axios.post('https://discord.com/api/oauth2/token', { client_id: process.env.DISCORD_CLIENT_ID, client_secret: process.env.DISCORD_CLIENT_SECRET, grant_type: 'authorization_code', code, redirect_uri: `${process.env.BACKEND_URL || 'http://localhost:5000'}/api/discord/callback` }, { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    let serverName = 'Unknown Server';
    if (guildId) {
      try {
        const guildResponse = await axios.get(`https://discord.com/api/guilds/${guildId}`, { headers: { Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}` } });
        serverName = (guildResponse.data as { name?: string }).name || serverName;
      } catch (error) {
        console.log('Could not fetch guild info:', (error as { response?: { data?: unknown } }).response?.data);
      }
    }
    const successUrl = new URL(`${process.env.FRONTEND_URL}/discord/success`);
    successUrl.searchParams.append('pod_id', podId);
    successUrl.searchParams.append('guild_id', guildId || '');
    successUrl.searchParams.append('server_name', serverName);
    res.redirect(successUrl.toString());
  } catch (error) {
    const e = error as { response?: { data?: unknown }; message?: string };
    console.error('Discord OAuth callback error:', e.response?.data || e.message);
    const errorUrl = new URL(`${process.env.FRONTEND_URL}/discord/error`);
    errorUrl.searchParams.append('error', 'OAuth authorization failed');
    res.redirect(errorUrl.toString());
  }
});

module.exports = router;

export {};
