# Test Discord Bot Setup Guide

This guide will help you create a test Discord bot to verify the Discord integration functionality.

## Step 1: Create Discord Application

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Click "New Application"
3. Name it "Commonly Test Bot"
4. Click "Create"

## Step 2: Configure Bot Settings

1. In the left sidebar, click "Bot"
2. Click "Add Bot"
3. Under "Privileged Gateway Intents", enable:
   - ✅ Message Content Intent
   - ✅ Server Members Intent
   - ✅ Presence Intent
4. Click "Save Changes"

## Step 3: Get Bot Token

1. In the Bot section, click "Reset Token"
2. Copy the token (you'll need this)
3. **Keep this token secret!**

## Step 4: Get Application ID

1. Go to "General Information" in the left sidebar
2. Copy the "Application ID"

## Step 5: Create Test Server

1. Open Discord
2. Create a new server called "Commonly Test Server"
3. Create a test channel called "test-channel"

## Step 6: Enable Developer Mode

1. In Discord, go to User Settings → Advanced
2. Enable "Developer Mode"

## Step 7: Get Server and Channel IDs

1. Right-click on your server name → "Copy Server ID"
2. Right-click on the test channel → "Copy Channel ID"

## Step 8: Invite Bot to Server

1. Go back to Discord Developer Portal
2. Go to "OAuth2" → "URL Generator"
3. Under "Scopes", select:
   - ✅ `bot`
   - ✅ `applications.commands`
4. Under "Bot Permissions", select:
   - ✅ Read Messages/View Channels
   - ✅ Send Messages
   - ✅ Read Message History
   - ✅ Manage Webhooks
5. Copy the generated URL
6. Open the URL in your browser
7. Select your test server and authorize

## Step 9: Create Webhook

1. In your Discord test channel, right-click → "Edit Channel"
2. Go to "Integrations" → "Webhooks"
3. Click "New Webhook"
4. Name it "Commonly Test Webhook"
5. Copy the webhook URL

## Step 10: Test the Integration

### Backend Test

1. Start your backend server:
```bash
cd backend
npm start
```

2. Test the webhook endpoint:
```bash
curl -X POST http://localhost:5000/api/discord/test-webhook \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -d '{
    "webhookUrl": "YOUR_WEBHOOK_URL"
  }'
```

3. Test creating an integration:
```bash
curl -X POST http://localhost:5000/api/discord/integration \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -d '{
    "podId": "YOUR_POD_ID",
    "serverId": "YOUR_SERVER_ID",
    "serverName": "Commonly Test Server",
    "channelId": "YOUR_CHANNEL_ID",
    "channelName": "test-channel",
    "webhookUrl": "YOUR_WEBHOOK_URL",
    "botToken": "YOUR_BOT_TOKEN"
  }'
```

### Frontend Test

1. Start your frontend:
```bash
cd frontend
npm start
```

2. Navigate to a chat pod
3. Look for the "Discord Integration" section in the sidebar
4. Click "Add Discord Integration"
5. Fill in the form with your test data
6. Test the connection

## Step 11: Verify Webhook Functionality

1. Send a message in your Discord test channel
2. Check if the message appears in your Commonly chat
3. Send a message in Commonly and check if it appears in Discord

## Test Data Template

Here's a template for your test data:

```json
{
  "serverId": "1234567890123456789",
  "serverName": "Commonly Test Server",
  "channelId": "1234567890123456790",
  "channelName": "test-channel",
  "webhookUrl": "https://discord.com/api/webhooks/1234567890123456789/abcdefghijklmnopqrstuvwxyz",
  "botToken": "MTIzNDU2Nzg5MDEyMzQ1Njc4.GhIjKl.MnOpQrStUvWxYzAbCdEfGhIjKlMnOpQrStUvWx"
}
```

## Troubleshooting

### Bot Token Issues
- Make sure you copied the full token
- If token is invalid, reset it in the Developer Portal
- Check that the bot has the correct permissions

### Webhook Issues
- Verify the webhook URL is correct
- Make sure the webhook is in the right channel
- Check that the bot has "Manage Webhooks" permission

### Permission Issues
- Ensure the bot is added to your server
- Check bot permissions in server settings
- Verify the bot can see the channel

### Connection Issues
- Check your internet connection
- Verify the Discord API is accessible
- Check server logs for errors

## Security Notes

- **Never commit bot tokens to version control**
- **Use environment variables for sensitive data**
- **Regularly rotate your bot token**
- **Monitor bot permissions**

## Environment Variables

Add these to your `.env` file:

```env
# Discord Bot Configuration
DISCORD_BOT_TOKEN=your_bot_token_here
DISCORD_CLIENT_ID=your_client_id_here
DISCORD_WEBHOOK_URL=your_webhook_url_here

# Test Server IDs
DISCORD_TEST_SERVER_ID=your_test_server_id
DISCORD_TEST_CHANNEL_ID=your_test_channel_id
```

## Next Steps

After successful testing:

1. Create a production Discord bot
2. Set up proper environment variables
3. Configure webhook security
4. Add rate limiting
5. Implement error handling
6. Add monitoring and logging 