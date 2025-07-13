#!/bin/bash
echo "🚀 Starting Commonly Backend..."

# Check if Discord environment variables are set
if [ -n "$DISCORD_CLIENT_ID" ] && [ -n "$DISCORD_BOT_TOKEN" ] && [ -n "$DISCORD_PUBLIC_KEY" ]; then
    echo "🤖 Discord credentials detected, registering commands..."
    node scripts/deploy-discord-commands.js deploy
    if [ $? -eq 0 ]; then
        echo "✅ Discord commands registered successfully"
    else
        echo "⚠️  Discord command registration failed, continuing anyway..."
    fi
else
    echo "ℹ️  Discord credentials not set, skipping command registration"
fi

# Start the main application
echo "🚀 Starting server..."
exec node server.js 