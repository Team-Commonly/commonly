# Registering Discord Slash Commands

This guide shows you how to register Discord slash commands for your Commonly integrations.

## 🚀 **Quick Start (Recommended)**

### **Method 1: Using the Registration Script**

1. **Set up environment variables:**
   ```bash
   export MONGODB_URI="your_mongodb_connection_string"
   export DISCORD_CLIENT_ID="your_discord_client_id"
   export DISCORD_BOT_TOKEN="your_discord_bot_token"
   export DISCORD_PUBLIC_KEY="your_discord_public_key"
   ```

2. **Run the registration script:**
   ```bash
   cd backend
   ./register-commands.sh
   ```

3. **Or run the Node.js script directly:**
   ```bash
   node scripts/register-discord-commands.js
   ```

### **Method 2: Using the API Endpoint**

If your server is running:

```bash
# First, get your integration ID
curl -X GET http://localhost:3000/api/discord/binding/YOUR_POD_ID

# Then register commands
curl -X POST http://localhost:3000/api/discord/register-commands/INTEGRATION_ID
```

### **Method 3: Manual Registration**

```bash
# List all integrations
node scripts/register-discord-commands.js list

# Register for specific integration
node scripts/register-discord-commands.js
```

## 📋 **Step-by-Step Process**

### **Step 1: Verify Your Discord Integration**

First, make sure you have an active Discord integration:

```bash
# Check if you have Discord integrations
node scripts/register-discord-commands.js list
```

**Expected Output:**
```
📋 Available Discord Integrations:

1. 507f1f77bcf86cd799439011
   Server: My Test Server
   Channel: #general
   Status: connected
```

### **Step 2: Set Environment Variables**

Make sure these environment variables are set:

```bash
# Required
export MONGODB_URI="mongodb://localhost:27017/commonly"

# Discord Bot Configuration
export DISCORD_CLIENT_ID="1234567890123456789"
export DISCORD_BOT_TOKEN="your_bot_token_here"
export DISCORD_PUBLIC_KEY="your_public_key_here"
```

### **Step 3: Register Commands**

Run the registration script:

```bash
./register-commands.sh
```

**Expected Output:**
```
🤖 Discord Slash Command Registration
=====================================

📦 Connected to MongoDB

📋 Found 1 Discord integration(s):

1. Integration ID: 507f1f77bcf86cd799439011
   Server: My Test Server
   Channel: #general
   Status: connected
   Server ID: 1234567890123456789

✅ Using the only available integration

🔧 Registering commands for integration: 507f1f77bcf86cd799439011
🏠 Server: My Test Server
📡 Registering slash commands with Discord...
✅ Commands registered successfully!
   Available commands:
   - /commonly-summary
   - /discord-status
   - /discord-enable
   - /discord-disable
```

### **Step 4: Test in Discord**

1. Go to your Discord server
2. Type `/` to see available commands
3. Try `/discord-status` to test the integration

## 🔧 **Available Commands**

After registration, these commands will be available in your Discord server:

| Command | Description | Usage |
|---------|-------------|-------|
| `/commonly-summary` | Get the most recent summary from the linked chat pod | Type `/commonly-summary` in any channel |
| `/discord-status` | Show the status of Discord integration | Type `/discord-status` to check health |
| `/discord-enable` | Enable webhook listener for Discord channel | Type `/discord-enable` to start listening |
| `/discord-disable` | Disable webhook listener for Discord channel | Type `/discord-disable` to stop listening |

## ⚠️ **Troubleshooting**

### **Commands Don't Appear in Discord**

**Possible Causes:**
1. **Bot permissions**: Bot needs `applications.commands` scope
2. **Server permissions**: Bot needs to be in the server
3. **Timing**: Discord can take a few minutes to update
4. **Invalid bot token**: Check your bot token

**Solutions:**
```bash
# 1. Check bot permissions in Discord Developer Portal
# Make sure your bot has the 'applications.commands' scope

# 2. Re-invite bot with correct permissions
# Use this URL (replace CLIENT_ID):
https://discord.com/api/oauth2/authorize?client_id=CLIENT_ID&scope=bot%20applications.commands&permissions=2048

# 3. Re-register commands
./register-commands.sh

# 4. Wait 5-10 minutes for Discord to update
```

### **Registration Fails**

**Error: "Failed to register commands"**

**Check these:**
1. **Bot Token**: Is it valid and not expired?
2. **Server ID**: Is it correct in your integration?
3. **Bot Permissions**: Does the bot have proper permissions?
4. **Discord API**: Is Discord's API working?

**Debug Steps:**
```bash
# 1. Test bot token
curl -H "Authorization: Bot YOUR_BOT_TOKEN" https://discord.com/api/v10/users/@me

# 2. Check integration details
node scripts/register-discord-commands.js list

# 3. Verify server ID
# Go to Discord, enable Developer Mode, right-click server name, copy ID
```

### **"Integration not found" Error**

**Solution:**
```bash
# 1. Check if integration exists
node scripts/register-discord-commands.js list

# 2. If no integrations found, create one first:
# - Go to your chat pod
# - Add Discord integration
# - Follow setup instructions

# 3. Then register commands
./register-commands.sh
```

### **"Missing server ID" Error**

**Solution:**
```bash
# 1. Check integration configuration
node scripts/register-discord-commands.js list

# 2. If server ID is missing, update the integration:
# - Go to your chat pod
# - Edit Discord integration
# - Add the correct server ID
# - Save changes

# 3. Re-register commands
./register-commands.sh
```

## 🔄 **Re-registering Commands**

You may need to re-register commands if:

- You add new commands
- You change command descriptions
- Discord's cache is outdated
- Bot permissions change

**To re-register:**
```bash
# Simple re-registration
./register-commands.sh

# Or force re-registration for all integrations
node scripts/register-discord-commands.js
```

## 📊 **Verification**

### **Check if Commands are Registered**

```bash
# List your integrations
node scripts/register-discord-commands.js list

# Test a command in Discord
# Type /discord-status and see if it responds
```

### **Expected Discord Response**

When you type `/discord-status`, you should see:

```
🤖 Discord Integration Status

📊 Status: 🟢 connected
🏠 Server: My Test Server
📺 Channel: #general
🔗 Webhook Listener: ✅ Enabled
⏰ Last Sync: 12/1/2023, 3:30:45 PM
```

## 🚀 **Advanced Usage**

### **Register for Multiple Servers**

If you have multiple Discord integrations:

```bash
# Register for all integrations
node scripts/register-discord-commands.js

# The script will show all integrations and register commands for each one
```

### **Custom Command Registration**

For advanced users, you can modify the commands in `backend/services/discordService.js`:

```javascript
const commands = [
  {
    name: 'commonly-summary',
    description: 'Get the most recent summary from the linked chat pod',
    type: 1, // CHAT_INPUT
  },
  // Add your custom commands here
];
```

## 📚 **References**

- [Discord Application Commands](https://discord.com/developers/docs/interactions/application-commands)
- [Discord Bot Permissions](https://discord.com/developers/docs/topics/permissions)
- [Discord API Rate Limits](https://discord.com/developers/docs/topics/rate-limits)

## ✅ **Success Checklist**

After registration, verify:

- [ ] Commands appear when typing `/` in Discord
- [ ] `/discord-status` returns integration status
- [ ] `/commonly-summary` returns chat pod summary (if available)
- [ ] `/discord-enable` and `/discord-disable` work
- [ ] Error messages are ephemeral (private to user)
- [ ] Commands respond within 3 seconds

If all items are checked, your Discord slash commands are working correctly! 🎉 