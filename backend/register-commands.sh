#!/bin/bash

# Discord Slash Command Registration Script
# This script registers slash commands for Discord integrations

echo "🤖 Discord Slash Command Registration"
echo "====================================="
echo ""

# Check if MONGODB_URI is set
if [ -z "$MONGODB_URI" ]; then
    echo "❌ MONGODB_URI environment variable is not set"
    echo "Please set it first:"
    echo "export MONGODB_URI='your_mongodb_connection_string'"
    exit 1
fi

# Check if Discord environment variables are set
if [ -z "$DISCORD_CLIENT_ID" ] || [ -z "$DISCORD_BOT_TOKEN" ] || [ -z "$DISCORD_PUBLIC_KEY" ]; then
    echo "⚠️  Warning: Some Discord environment variables are not set"
    echo "Make sure you have:"
    echo "- DISCORD_CLIENT_ID"
    echo "- DISCORD_BOT_TOKEN" 
    echo "- DISCORD_PUBLIC_KEY"
    echo ""
    echo "You can set them with:"
    echo "export DISCORD_CLIENT_ID='your_client_id'"
    echo "export DISCORD_BOT_TOKEN='your_bot_token'"
    echo "export DISCORD_PUBLIC_KEY='your_public_key'"
    echo ""
fi

# Run the registration script
echo "🚀 Starting command registration..."
node scripts/register-discord-commands.js

echo ""
echo "✅ Registration script completed!"
echo ""
echo "Next steps:"
echo "1. Go to your Discord server"
echo "2. Type '/' to see available commands"
echo "3. Try /discord-status to test the integration"
echo ""
echo "If commands don't appear:"
echo "- Wait a few minutes (Discord can take time to update)"
echo "- Check that your bot has the 'applications.commands' scope"
echo "- Verify the bot is in your server with proper permissions" 