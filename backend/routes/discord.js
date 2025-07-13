const express = require('express');
const axios = require('axios');
const nacl = require('tweetnacl');
const auth = require('../middleware/auth');

const router = express.Router();
const Integration = require('../models/Integration');
const DiscordIntegration = require('../models/DiscordIntegration');
const DiscordService = require('../services/discordService');
// const DiscordController = require('../controllers/discordController');

// Discord public key for signature verification
const { DISCORD_PUBLIC_KEY } = process.env;

// Verify Discord request signature
function verifySignature(req) {
  const signature = req.headers['x-signature-ed25519'];
  const timestamp = req.headers['x-signature-timestamp'];

  // Use raw body for signature verification
  const body = req.body.toString('utf8');

  console.log('Discord signature verification:');
  console.log('- Signature header:', signature);
  console.log('- Timestamp header:', timestamp);
  console.log('- Public key:', DISCORD_PUBLIC_KEY ? 'Present' : 'Missing');
  console.log('- Body length:', body.length);

  if (!signature || !timestamp || !DISCORD_PUBLIC_KEY) {
    console.error('Missing required headers or public key');
    return false;
  }

  try {
    const signatureBytes = Buffer.from(signature, 'hex');
    const publicKeyBytes = Buffer.from(DISCORD_PUBLIC_KEY, 'hex');
    const message = Buffer.from(timestamp + body, 'utf8');

    const isValid = nacl.sign.detached.verify(message, signatureBytes, publicKeyBytes);
    console.log('- Signature verification result:', isValid);
    return isValid;
  } catch (error) {
    console.error('Error verifying signature:', error);
    return false;
  }
}

// Handle Discord installation events
async function handleInstallationEvent(interaction) {
  try {
    const { id: installationId, guild_id: serverId, user } = interaction;

    console.log('Handling Discord installation event:');
    console.log('- Installation ID:', installationId);
    console.log('- Server ID:', serverId);
    console.log('- User ID:', user?.id);

    // Check if this installation is already bound to a pod
    const existingIntegration = await Integration.findOne({ installationId });
    if (existingIntegration) {
      console.log('Installation already bound to pod:', existingIntegration.podId);
      return { success: true, message: 'Installation already exists' };
    }

    // For now, we'll need to get the podId from the installation context
    // This will be enhanced when we implement the frontend installation flow
    console.log('Installation event received - pod binding will be handled by frontend flow');

    return { success: true, message: 'Installation event received' };
  } catch (error) {
    console.error('Error handling installation event:', error);
    return { success: false, error: error.message };
  }
}

// Create Discord integration
// router.post('/integration', auth, DiscordController.createIntegration);

// Get Discord integration details
// router.get('/integration/:id', auth, DiscordController.getIntegration);

// Update Discord integration
// router.put('/integration/:id', auth, DiscordController.updateIntegration);

// Get channels for a guild
router.get('/channels/:guildId', auth, async (req, res) => {
  try {
    const { guildId } = req.params;

    const response = await axios.get(`https://discord.com/api/guilds/${guildId}/channels`, {
      headers: {
        Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}`,
      },
    });

    // Filter for text channels only
    const textChannels = response.data
      .filter((channel) => channel.type === 0) // GUILD_TEXT
      .map((channel) => ({
        id: channel.id,
        name: channel.name,
        topic: channel.topic,
      }));

    res.json(textChannels);
  } catch (error) {
    console.error('Error fetching Discord channels:', error.response?.data || error.message);
    res.status(500).json({ message: 'Failed to fetch channels' });
  }
});

// Generate bot invite link
// router.post('/invite', auth, DiscordController.generateInviteLink);

// Test webhook connection
// router.post('/test-webhook', auth, DiscordController.testWebhook);

// Get Discord integration statistics
// router.get('/stats/:id', auth, DiscordController.getStats);

// Discord Interactions endpoint
router.post('/interactions', async (req, res) => {
  console.log('Received Discord interaction (raw body):', req.body.toString('utf8'));

  // Verify Discord signature (required for security)
  if (!verifySignature(req)) {
    console.error('Invalid Discord signature');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  // Parse the JSON body after verification
  let interaction;
  try {
    interaction = JSON.parse(req.body.toString('utf8'));
  } catch (error) {
    console.error('Error parsing Discord interaction body:', error);
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  const {
    type, data, id: interactionId, token: interactionToken, guild_id: guildId,
  } = interaction;

  // Handle ping (required for Discord to verify the endpoint)
  if (type === 1) {
    console.log('Responding to Discord ping with PONG.');
    const pongBody = JSON.stringify({ type: 1 });
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(pongBody),
    });
    res.end(pongBody);
    return;
  }

  // Handle installation events
  if (type === 2 && data?.type === 'INSTALLATION_CREATE') {
    console.log('Handling Discord installation event');
    const result = await handleInstallationEvent(interaction);

    if (result.success) {
      return res.json({
        type: 4,
        data: { content: 'Discord bot installed successfully!' },
      });
    }
    return res.status(500).json({
      type: 4,
      data: { content: 'Failed to process installation' },
    });
  }

  // Handle application commands (slash commands)
  if (type === 2 && data?.type === 1) { // APPLICATION_COMMAND with CHAT_INPUT
    console.log('Processing slash command:', data.name, 'in guild:', guildId);

    try {
      // Find the integration for this guild
      const integration = await Integration.findOne({
        'config.serverId': guildId,
        type: 'discord',
        isActive: true,
      });

      if (!integration) {
        return res.json({
          type: 4,
          data: {
            content: '❌ Discord integration not found for this server. Please install the bot first.',
            flags: 64, // EPHEMERAL
          },
        });
      }

      // Create Discord service instance and handle the command
      const discordService = new DiscordService(integration._id);
      await discordService.initialize();

      const result = await discordService.handleInteraction(interaction);

      if (result) {
        // Store interaction token for potential followup messages
        result.interactionToken = interactionToken;
        result.interactionId = interactionId;

        return res.json(result);
      }
      return res.json({
        type: 4,
        data: {
          content: '❌ Command not recognized.',
          flags: 64, // EPHEMERAL
        },
      });
    } catch (error) {
      console.error('Error handling slash command:', error);
      return res.json({
        type: 4,
        data: {
          content: '❌ An error occurred while processing the command.',
          flags: 64, // EPHEMERAL
        },
      });
    }
  }

  // Handle other interaction types
  console.log('Unknown interaction type:', type);
  return res.json({
    type: 4,
    data: {
      content: 'This interaction type is not supported.',
      flags: 64, // EPHEMERAL
    },
  });
});

// Generate installation link for a chat pod
router.get('/install-link/:podId', async (req, res) => {
  try {
    const { podId } = req.params;
    const { clientId = process.env.DISCORD_CLIENT_ID } = req.query;

    if (!clientId) {
      return res.status(400).json({ error: 'Discord client ID is required' });
    }

    // Create installation link with pod context
    const baseUrl = 'https://discord.com/api/oauth2/authorize';
    const scopes = ['bot', 'applications.commands'];
    const permissions = '536873984'; // Send Messages (2048) + Manage Webhooks (536870912) = 536873984
    const state = `pod_${podId}`; // Encode pod ID in state parameter

    const installUrl = `${baseUrl}?client_id=${clientId}&scope=${scopes.join('%20')}`
      + `&permissions=${permissions}&state=${state}`;

    res.json({
      installUrl,
      podId,
      status: 'ready',
    });
  } catch (error) {
    console.error('Error generating installation link:', error);
    res.status(500).json({ error: 'Failed to generate installation link' });
  }
});

// Get Discord binding for a specific chat pod
router.get('/binding/:podId', async (req, res) => {
  try {
    const { podId } = req.params;

    const integration = await Integration.findOne({
      podId,
      type: 'discord',
      isActive: true,
    });

    if (!integration) {
      return res.status(404).json({ error: 'No Discord integration found for this pod' });
    }

    const discordIntegration = await DiscordIntegration.findOne({
      integrationId: integration._id,
    });

    res.json({
      integration,
      discordIntegration,
    });
  } catch (error) {
    console.error('Error getting Discord binding:', error);
    res.status(500).json({ error: 'Failed to get Discord binding' });
  }
});

// Remove Discord integration
router.delete('/uninstall/:installationId', async (req, res) => {
  try {
    const { installationId } = req.params;

    const integration = await Integration.findOne({ installationId });
    if (!integration) {
      return res.status(404).json({ error: 'Integration not found' });
    }

    // Delete Discord-specific integration
    await DiscordIntegration.findOneAndDelete({
      integrationId: integration._id,
    });

    // Delete base integration
    await Integration.findByIdAndDelete(integration._id);

    res.json({ message: 'Discord integration removed successfully' });
  } catch (error) {
    console.error('Error removing Discord integration:', error);
    res.status(500).json({ error: 'Failed to remove Discord integration' });
  }
});

// Register slash commands for a Discord integration
router.post('/register-commands/:integrationId', async (req, res) => {
  try {
    const { integrationId } = req.params;

    const integration = await Integration.findById(integrationId);
    if (!integration) {
      return res.status(404).json({ error: 'Integration not found' });
    }

    if (integration.type !== 'discord') {
      return res.status(400).json({ error: 'Integration is not a Discord integration' });
    }

    const guildId = integration.config.serverId;
    if (!guildId) {
      return res.status(400).json({ error: 'Server ID not found in integration config' });
    }

    // Create Discord service and register commands
    const discordService = new DiscordService(integrationId);
    await discordService.initialize();

    const success = await discordService.registerSlashCommands(guildId);

    if (success) {
      res.json({
        message: 'Slash commands registered successfully',
        commands: [
          '/commonly-summary',
          '/discord-status',
          '/discord-enable',
          '/discord-disable',
        ],
      });
    } else {
      res.status(500).json({ error: 'Failed to register slash commands' });
    }
  } catch (error) {
    console.error('Error registering slash commands:', error);
    res.status(500).json({ error: 'Failed to register slash commands' });
  }
});

/**
 * Health check endpoint for Discord command registration
 * GET /api/discord/health
 */
router.get('/health', async (req, res) => {
  try {
    const { DISCORD_CLIENT_ID, DISCORD_BOT_TOKEN } = process.env;

    if (!DISCORD_CLIENT_ID || !DISCORD_BOT_TOKEN) {
      return res.json({
        timestamp: new Date().toISOString(),
        status: 'no_credentials',
        message: 'Discord credentials not configured',
        summary: {
          total: 0,
          registered: 0,
          failed: 0,
        },
      });
    }

    // Check global command registration
    const url = `https://discord.com/api/v10/applications/${DISCORD_CLIENT_ID}/commands`;

    const response = await axios.get(url, {
      headers: {
        Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
      },
    });

    if (response.status === 200) {
      const registeredCommands = response.data;
      const expectedCommands = ['commonly-summary', 'discord-status', 'discord-enable', 'discord-disable'];
      const foundCommands = registeredCommands.map((cmd) => cmd.name);

      const missingCommands = expectedCommands.filter((cmd) => !foundCommands.includes(cmd));

      const healthReport = {
        timestamp: new Date().toISOString(),
        status: missingCommands.length === 0 ? 'healthy' : 'degraded',
        globalCommands: {
          registered: foundCommands,
          missing: missingCommands,
          total: expectedCommands.length,
        },
        summary: {
          total: expectedCommands.length,
          registered: foundCommands.length,
          failed: missingCommands.length,
        },
      };

      res.json(healthReport);
    } else {
      throw new Error(`Discord API returned status ${response.status}`);
    }
  } catch (error) {
    console.error('Error in Discord health check:', error);
    res.status(500).json({
      timestamp: new Date().toISOString(),
      status: 'error',
      error: error.message,
    });
  }
});

/**
 * Bulk command registration endpoint
 * POST /api/discord/register-all
 */
router.post('/register-all', async (req, res) => {
  try {
    // eslint-disable-next-line global-require
    const DiscordServiceClass = require('../services/discordService');

    const result = await DiscordServiceClass.registerCommandsForAllIntegrations();

    res.json({
      success: result.success,
      message: result.success ? 'All commands registered successfully' : 'Some commands failed to register',
      details: result,
    });
  } catch (error) {
    console.error('Error in bulk command registration:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Discord OAuth callback endpoint
router.get('/callback', async (req, res) => {
  try {
    const {
      code, state, guild_id: guildId,
    } = req.query;

    if (!code) {
      return res.redirect(`${process.env.FRONTEND_URL}/discord/error?error=No authorization code received`);
    }

    // Extract pod ID from state
    const podId = state?.replace('pod_', '');
    if (!podId) {
      return res.redirect(`${process.env.FRONTEND_URL}/discord/error?error=Invalid state parameter`);
    }

    // Exchange code for access token
    await axios.post('https://discord.com/api/oauth2/token', {
      client_id: process.env.DISCORD_CLIENT_ID,
      client_secret: process.env.DISCORD_CLIENT_SECRET,
      grant_type: 'authorization_code',
      code,
      redirect_uri: `${process.env.BACKEND_URL || 'http://localhost:5000'}/api/discord/callback`,
    }, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    });

    // Token response received successfully

    // Get guild information
    let serverName = 'Unknown Server';
    if (guildId) {
      try {
        const guildResponse = await axios.get(`https://discord.com/api/guilds/${guildId}`, {
          headers: {
            Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}`,
          },
        });
        serverName = guildResponse.data.name;
      } catch (error) {
        console.log('Could not fetch guild info:', error.response?.data);
      }
    }

    // Redirect to success page with guild info
    const successUrl = new URL(`${process.env.FRONTEND_URL}/discord/success`);
    successUrl.searchParams.append('pod_id', podId);
    successUrl.searchParams.append('guild_id', guildId);
    successUrl.searchParams.append('server_name', serverName);

    res.redirect(successUrl.toString());
  } catch (error) {
    console.error('Discord OAuth callback error:', error.response?.data || error.message);
    const errorUrl = new URL(`${process.env.FRONTEND_URL}/discord/error`);
    errorUrl.searchParams.append('error', 'OAuth authorization failed');
    res.redirect(errorUrl.toString());
  }
});

module.exports = router;
