import type { Request, Response } from 'express';

// eslint-disable-next-line global-require
const DiscordService = require('../services/discordService');
// eslint-disable-next-line global-require
const DiscordIntegration = require('../models/DiscordIntegration');
// eslint-disable-next-line global-require
const Integration = require('../models/Integration');

interface AuthRequest extends Request {
  user?: { id: string };
}

interface CreateIntegrationBody {
  podId?: string;
  serverId?: string;
  serverName?: string;
  channelId?: string;
  channelName?: string;
  webhookUrl?: string;
  botToken?: string;
}

interface UpdateIntegrationBody {
  serverName?: string;
  channelName?: string;
  webhookUrl?: string;
  botToken?: string;
}

exports.createIntegration = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const {
      podId, serverId, serverName, channelId, channelName, webhookUrl, botToken,
    } = req.body as CreateIntegrationBody;

    const discordIntegration = await DiscordIntegration.create({
      serverId,
      serverName,
      channelId,
      channelName,
      webhookUrl,
      botToken,
    });

    const integration = await Integration.create({
      podId,
      type: 'discord',
      config: {},
      createdBy: req.user?.id,
      platformIntegration: discordIntegration._id,
      status: 'pending',
    });

    res.json({ integration, discordIntegration });
  } catch (err) {
    const e = err as { message?: string };
    console.error('Error creating Discord integration:', e.message);
    res.status(500).send('Server Error');
  }
};

exports.getIntegration = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const id = req.params.id || req.params.integrationId;
    const integration = await Integration.findById(id).populate('platformIntegration');
    if (!integration) {
      res.status(404).json({ msg: 'Integration not found' });
      return;
    }
    res.json(integration);
  } catch (err) {
    const e = err as { message?: string; kind?: string };
    console.error(e.message);
    if (e.kind === 'ObjectId') {
      res.status(404).json({ msg: 'Integration not found' });
      return;
    }
    res.status(500).send('Server Error');
  }
};

exports.updateIntegration = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const id = req.params.id || req.params.integrationId;
    const { serverName, channelName, webhookUrl, botToken } = req.body as UpdateIntegrationBody;

    const integration = await Integration.findById(id).populate('platformIntegration') as {
      platformIntegration?: { _id: unknown };
    } | null;
    if (!integration) {
      res.status(404).json({ msg: 'Integration not found' });
      return;
    }

    const update: Record<string, unknown> = {};
    if (serverName !== undefined) update.serverName = serverName;
    if (channelName !== undefined) update.channelName = channelName;
    if (webhookUrl !== undefined) update.webhookUrl = webhookUrl;
    if (botToken !== undefined) update.botToken = botToken;

    const discordIntegration = await DiscordIntegration.findByIdAndUpdate(
      integration.platformIntegration?._id,
      update,
      { new: true },
    );

    res.json({ integration, discordIntegration });
  } catch (err) {
    const e = err as { message?: string };
    console.error(e.message);
    res.status(500).send('Server Error');
  }
};

exports.getChannels = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const id = req.params.id || req.params.integrationId;
    const service = new DiscordService(id);
    await service.initialize();
    const channels = await service.getChannels();
    res.json(channels);
  } catch (err) {
    const e = err as { message?: string };
    console.error('Error fetching Discord channels:', e.message);
    res.status(500).send('Server Error');
  }
};

exports.generateInviteLink = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { clientId, permissions = '8', guildId } = req.body as {
      clientId?: string;
      permissions?: string;
      guildId?: string;
    };
    if (!clientId) {
      res.status(400).json({ msg: 'clientId is required' });
      return;
    }
    let url = `https://discord.com/api/oauth2/authorize?client_id=${clientId}&permissions=${permissions}&scope=bot%20applications.commands`;
    if (guildId) url += `&guild_id=${guildId}`;
    res.json({ url });
  } catch (err) {
    const e = err as { message?: string };
    console.error(e.message);
    res.status(500).send('Server Error');
  }
};

exports.testWebhook = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { webhookUrl } = req.body as { webhookUrl?: string };
    if (!webhookUrl) {
      res.status(400).json({ msg: 'webhookUrl is required' });
      return;
    }
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '✅ Webhook test from Commonly' }),
    });
    res.json({ success: response.ok, status: response.status });
  } catch (err) {
    const e = err as { message?: string };
    console.error('Webhook test failed:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
};

exports.getStats = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const id = req.params.id || req.params.integrationId;
    const service = new DiscordService(id);
    await service.initialize();
    const stats = await service.getStats();
    res.json(stats);
  } catch (err) {
    const e = err as { message?: string };
    console.error('Error getting Discord stats:', e.message);
    res.status(500).send('Server Error');
  }
};
