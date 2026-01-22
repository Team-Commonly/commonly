# Discord Application Setup Guide

## Step 1: Create Discord Application

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Click "New Application"
3. Name: "Commonly"
4. Click "Create"

## Step 2: Create Bot

1. In your application, go to "Bot" in the left sidebar
2. Click "Add Bot"
3. Set bot name: "Commonly"
4. Enable these settings:
   - ✅ Message Content Intent
   - ✅ Server Members Intent
   - ✅ Presence Intent

## Step 3: Get Credentials

1. **Client ID**: 
   - Go to "OAuth2" in the left sidebar
   - Copy the "Client ID"

2. **Bot Token**:
   - Go to "Bot" in the left sidebar
   - Click "Reset Token" and copy the token
   - ⚠️ Keep this token secure! Never commit it to version control

3. **Public Key**:
   - Go to "General Information"
   - Copy the "Public Key"

## Step 4: Set Bot Permissions

1. Go to "OAuth2" → "URL Generator"
2. Select these scopes:
   - ✅ bot
   - ✅ applications.commands

3. Select these bot permissions:
   - ✅ Read Messages/View Channels
   - ✅ Send Messages
   - ✅ Read Message History
   - ✅ Manage Webhooks

4. Copy the generated URL - this is your bot invite link

## Step 5: Set Environment Variables

Add these to your `.env` file:

```env
DISCORD_CLIENT_ID=your_client_id_here
DISCORD_BOT_TOKEN=your_bot_token_here
DISCORD_PUBLIC_KEY=your_public_key_here
```

## Step 6: Update Docker Configuration

Add these environment variables to your `docker-compose.yml`:

```yaml
services:
  backend:
    environment:
      - DISCORD_CLIENT_ID=${DISCORD_CLIENT_ID}
      - DISCORD_BOT_TOKEN=${DISCORD_BOT_TOKEN}
      - DISCORD_PUBLIC_KEY=${DISCORD_PUBLIC_KEY}
```

## Security Notes

- Never share your bot token
- Don't commit `.env` file to version control
- Regularly rotate your bot token if compromised
- Use environment variables in production 