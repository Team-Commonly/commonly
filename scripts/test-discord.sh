#!/bin/bash

# Discord Integration Quick Test Script
# This script helps you quickly test the Discord integration

echo "🤖 Discord Integration Test Script"
echo "=================================="
echo ""

# Check if backend is running
echo "🔍 Checking if backend is running..."
if curl -s http://localhost:5000/api/pg/status > /dev/null 2>&1; then
    echo "✅ Backend is running on port 5000"
else
    echo "❌ Backend is not running. Please start it first:"
    echo "   cd backend && npm start"
    exit 1
fi

# Check if frontend is running
echo "🔍 Checking if frontend is running..."
if curl -s http://localhost:3000 > /dev/null 2>&1; then
    echo "✅ Frontend is running on port 3000"
else
    echo "⚠️  Frontend is not running. You can start it with:"
    echo "   cd frontend && npm start"
fi

echo ""
echo "📋 Next Steps:"
echo "1. Follow the setup guide: docs/TEST_DISCORD_BOT.md"
echo "2. Create a Discord bot and get your credentials"
echo "3. Update your .env file with Discord credentials"
echo "4. Run the test script: node backend/test-discord-integration.js"
echo "5. Test the integration in the frontend"
echo ""
echo "🔗 Useful URLs:"
echo "   Frontend: http://localhost:3000"
echo "   Backend API: http://localhost:5000"
echo "   Discord Developer Portal: https://discord.com/developers/applications"
echo ""
echo "📚 Documentation:"
echo "   Setup Guide: docs/TEST_DISCORD_BOT.md"
echo "   Integration Design: docs/design/DISCORD_INTEGRATION.md"
echo ""

# Check if .env file exists and has Discord variables
if [ -f ".env" ]; then
    echo "🔍 Checking .env file for Discord configuration..."
    
    if grep -q "DISCORD_BOT_TOKEN" .env; then
        echo "✅ DISCORD_BOT_TOKEN found in .env"
    else
        echo "⚠️  DISCORD_BOT_TOKEN not found in .env"
    fi
    
    if grep -q "DISCORD_WEBHOOK_URL" .env; then
        echo "✅ DISCORD_WEBHOOK_URL found in .env"
    else
        echo "⚠️  DISCORD_WEBHOOK_URL not found in .env"
    fi
    
    if grep -q "DISCORD_TEST_SERVER_ID" .env; then
        echo "✅ DISCORD_TEST_SERVER_ID found in .env"
    else
        echo "⚠️  DISCORD_TEST_SERVER_ID not found in .env"
    fi
else
    echo "⚠️  .env file not found. Create one with your Discord credentials."
fi

echo ""
echo "🎯 Ready to test! Follow the setup guide to get started." 