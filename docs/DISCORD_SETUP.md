# Discord Integration Setup Guide

This guide will walk you through setting up Discord integration with Commonly.

## Prerequisites

- A Discord account
- Administrator permissions on a Discord server (for bot setup)
- Access to Discord Developer Portal

## Step 1: Create a Discord Bot Application

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications)
2. Click "New Application"
3. Give your application a name (e.g., "Commonly Bot")
4. Click "Create"

## Step 2: Configure Your Bot

1. In your application, go to the "Bot" section in the left sidebar
2. Click "Add Bot"
3. Under "Privileged Gateway Intents", enable:
   - Message Content Intent
   - Server Members Intent
   - Presence Intent
4. Save your changes

## Step 3: Get Your Bot Token

1. In the Bot section, click "Reset Token" to reveal your bot token
2. Copy the token (you'll need this for the integration)
3. **Important**: Keep this token secret and never share it publicly

## Step 4: Get Your Bot's Client ID

1. Go to the "General Information" section
2. Copy the "Application ID" (this is your Client ID)

## Step 5: Invite the Bot to Your Server

1. Go to the "OAuth2" → "URL Generator" section
2. Under "Scopes", select:
   - `bot`
   - `applications.commands`
3. Under "Bot Permissions", select:
   - Read Messages/View Channels
   - Send Messages
   - Read Message History
   - Manage Webhooks
4. Copy the generated URL and open it in your browser
5. Select your server and authorize the bot

## Step 6: Get Server and Channel IDs

### Enable Developer Mode
1. In Discord, go to User Settings → Advanced
2. Enable "Developer Mode"

### Get Server ID
1. Right-click on your server name
2. Click "Copy Server ID"

### Get Channel ID
1. Right-click on the channel you want to integrate
2. Click "Copy Channel ID"

## Step 7: Create a Webhook

1. Go to the channel you want to integrate
2. Right-click on the channel → "Edit Channel"
3. Go to "Integrations" → "Webhooks"
4. Click "New Webhook"
5. Give it a name (e.g., "Commonly Integration")
6. Copy the webhook URL

## Step 8: Set Up Integration in Commonly

1. In your Commonly pod, go to the Discord Integration section
2. Click "Add Discord Integration"
3. Fill in the form with:
   - **Server ID**: The server ID you copied in Step 6
   - **Server Name**: A display name for your server
   - **Channel ID**: The channel ID you copied in Step 6
   - **Channel Name**: A display name for your channel
   - **Webhook URL**: The webhook URL you created in Step 7
   - **Bot Token**: The bot token from Step 3
4. Click "Create Integration"

## Step 9: Test the Integration

1. After creating the integration, it should automatically test the connection
2. If successful, you'll see a green "connected" status
3. Send a message in your Discord channel to test the webhook
4. Check that the message appears in your Commonly chat

## Troubleshooting

### Bot Token Issues
- Make sure you copied the full bot token
- If the token is invalid, reset it in the Discord Developer Portal
- Ensure the bot has the correct permissions

### Webhook Issues
- Verify the webhook URL is correct
- Make sure the webhook is in the correct channel
- Check that the bot has "Manage Webhooks" permission

### Permission Issues
- Ensure the bot has been added to your server
- Check that the bot has the required permissions
- Verify the bot can see the channel you're trying to integrate

### Connection Issues
- Check your internet connection
- Verify the Discord API is accessible
- Ensure your server allows external webhooks

## Security Notes

- **Never share your bot token publicly**
- **Keep webhook URLs private**
- **Regularly rotate your bot token**
- **Monitor bot permissions and remove unnecessary ones**

## Advanced Configuration

### Custom Bot Permissions
You can customize bot permissions by modifying the invite URL:
- Add `&permissions=PERMISSION_NUMBER` to the invite URL
- Common permission numbers:
  - 2048: Read Messages, Send Messages
  - 8192: Read Message History
  - 16384: Manage Webhooks

### Multiple Channel Integration
You can create multiple integrations for different channels:
1. Create separate webhooks for each channel
2. Set up individual integrations in Commonly
3. Each integration will handle its own channel independently

### Webhook Security
For additional security:
1. Use webhook-specific tokens
2. Regularly rotate webhook URLs
3. Monitor webhook usage in Discord server settings

## Support

If you encounter issues:
1. Check the troubleshooting section above
2. Verify all IDs and tokens are correct
3. Test the webhook manually in Discord
4. Contact support with specific error messages

## API Reference

### Integration Endpoints
- `POST /api/discord/integration` - Create Discord integration
- `GET /api/discord/integration/:id` - Get integration details
- `PUT /api/discord/integration/:id` - Update integration
- `DELETE /api/integrations/:id` - Delete integration

### Webhook Endpoints
- `POST /api/webhooks/discord` - Discord webhook receiver
- `POST /api/discord/test-webhook` - Test webhook connection

### Utility Endpoints
- `GET /api/discord/channels/:integrationId` - Get available channels
- `POST /api/discord/invite` - Generate bot invite link
- `GET /api/discord/stats/:id` - Get integration statistics 