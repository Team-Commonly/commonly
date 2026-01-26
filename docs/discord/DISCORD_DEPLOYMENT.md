# Discord Command Deployment Guide

This guide covers the automated Discord command registration system that integrates with your deployment process.

## 🚀 **Overview**

The Discord command system now:
- **Uses Guild ID as installation identifier** (more reliable than generic IDs)
- **Automatically registers commands during deployment**
- **Provides fallback mechanisms and retry logic**
- **Includes health checks and monitoring**
- **Handles multiple Discord servers automatically**

## 📋 **Architecture Changes**

### **Guild ID as Installation Identifier**

Instead of using a generic installation ID, the system now uses the Discord **Guild ID** (server ID) as the unique identifier:

```javascript
// Before: Generic installation ID
const commandService = new DiscordCommandService(installationId);

// After: Guild ID as installation identifier
const commandService = new DiscordCommandService(guildId);
```

**Benefits:**
- ✅ More reliable identification
- ✅ Easier debugging and troubleshooting
- ✅ Better integration with Discord's API
- ✅ Clearer relationship between bot and server

### **Deployment Integration**

Commands are now automatically registered during:
1. **Container startup** (via Dockerfile)
2. **npm install** (via postinstall script)
3. **Manual deployment** (via npm scripts)
4. **Health checks** (via API endpoints)

## 🔧 **Deployment Methods**

### **Method 1: Automatic (Recommended)**

Commands are automatically registered when the container starts:

```bash
# Build and start containers
docker-compose build
docker-compose up -d

# Commands are registered automatically during startup
```

**What happens:**
1. Container starts
2. Discord credentials are checked
3. Commands are registered for all active integrations
4. Server starts normally
5. If registration fails, server continues anyway

### **Method 2: Manual Deployment**

```bash
# Deploy commands for all integrations
npm run discord:deploy

# Verify deployment status
npm run discord:verify

# List all integrations
npm run discord:list
```

### **Method 3: API Endpoints**

```bash
# Health check
curl http://localhost:5000/api/discord/health

# Bulk registration
curl -X POST http://localhost:5000/api/discord/register-all
```

## 📊 **Health Monitoring**

### **Health Check Endpoint**

`GET /api/discord/health`

**Response:**
```json
{
  "timestamp": "2023-12-01T15:30:45.123Z",
  "status": "healthy",
  "integrations": [
    {
      "integrationId": "507f1f77bcf86cd799439011",
      "guildId": "1234567890123456789",
      "status": "healthy",
      "commands": ["commonly-summary", "discord-status", "discord-enable", "discord-disable"],
      "serverName": "My Test Server"
    }
  ],
  "summary": {
    "total": 1,
    "registered": 1,
    "failed": 0,
    "missingGuildId": 0
  }
}
```

**Status Values:**
- `healthy` - All commands registered successfully
- `degraded` - Some commands failed to register
- `no_integrations` - No Discord integrations found
- `error` - System error occurred

### **Monitoring Integration**

You can integrate this health check into your monitoring system:

```bash
# Check health every 5 minutes
*/5 * * * * curl -f http://localhost:5000/api/discord/health || echo "Discord health check failed"
```

## 🔄 **Fallback Mechanisms**

### **Retry Logic**

The deployment system includes automatic retry logic:

- **Max retries**: 3 attempts
- **Retry delay**: 5 seconds between attempts
- **Graceful degradation**: Server continues even if registration fails

### **Error Handling**

```javascript
// Example error handling in deployment
try {
  await registerCommands();
} catch (error) {
  console.log('⚠️  Command registration failed, continuing anyway...');
  // Server continues to start
}
```

### **Partial Failures**

If some integrations fail while others succeed:

```bash
📊 Deployment Report
===================
✅ Successfully registered: 2
❌ Failed: 1
📋 Total integrations: 3
🎯 Success rate: 67%

❌ Errors:
   - Guild 1234567890123456789: Bot lacks permissions
```

## 🛠️ **Troubleshooting**

### **Common Issues**

#### **1. Missing Guild ID**

**Error:** `Integration X: Missing guild ID`

**Solution:**
```bash
# Check integration configuration
npm run discord:list

# Update integration with correct guild ID
# Go to your chat pod → Edit Discord integration → Add server ID
```

#### **2. Bot Permissions**

**Error:** `Bot lacks permissions`

**Solution:**
1. Re-invite bot with correct permissions:
   ```
   https://discord.com/api/oauth2/authorize?client_id=YOUR_CLIENT_ID&scope=bot%20applications.commands&permissions=2048
   ```
2. Ensure bot has `applications.commands` scope

#### **3. Invalid Bot Token**

**Error:** `401 Unauthorized`

**Solution:**
1. Check `DISCORD_BOT_TOKEN` environment variable
2. Regenerate bot token in Discord Developer Portal
3. Update environment variable

#### **4. Rate Limiting**

**Error:** `429 Too Many Requests`

**Solution:**
- The system automatically retries with delays
- Wait a few minutes and try again
- Check Discord API status

#### **5. Interactions Endpoint Verification Failed**

**Error:** `interactions_endpoint_url: The specified interactions endpoint url could not be verified.`

**Checklist:**
1. The URL is exact: `https://<host>/api/discord/interactions`.
2. The endpoint is publicly reachable (Discord sends a signed POST).
3. If using Cloudflare Tunnel, the hostname must be in the tunnel **ingress** (DNS-only changes will still return Cloudflare 404s).
4. Cloudflare Access / firewall rules are not blocking Discord.
5. `DISCORD_PUBLIC_KEY` matches the app in the Discord Developer Portal.
6. Backend is running and reachable (no 404s from Cloudflare).

### **Debug Commands**

```bash
# Check environment variables
echo $DISCORD_CLIENT_ID
echo $DISCORD_BOT_TOKEN
echo $DISCORD_PUBLIC_KEY

# Test Discord API connection
curl -H "Authorization: Bot $DISCORD_BOT_TOKEN" https://discord.com/api/v10/users/@me

# Check container logs
docker-compose logs backend

# Verify commands for specific guild
curl "https://discord.com/api/v10/applications/$DISCORD_CLIENT_ID/guilds/GUILD_ID/commands" \
  -H "Authorization: Bot $DISCORD_BOT_TOKEN"
```

## 📈 **Performance Considerations**

### **Registration Timing**

- **First deployment**: ~2-5 seconds per integration
- **Subsequent deployments**: ~1-2 seconds per integration
- **Health checks**: ~500ms per integration

### **Rate Limiting**

- Discord allows 5 command registrations per 5 seconds
- System automatically handles rate limiting
- Retry logic includes exponential backoff

### **Database Impact**

- Minimal database queries during registration
- Commands are cached by Discord
- Health checks use efficient queries

## 🔐 **Security**

### **Environment Variables**

Ensure these are set securely:

```bash
# Required for command registration
DISCORD_CLIENT_ID=your_client_id
DISCORD_BOT_TOKEN=your_bot_token
DISCORD_PUBLIC_KEY=your_public_key

# Database connection
MONGODB_URI=your_mongodb_connection_string
```

### **Bot Permissions**

Minimum required permissions:
- `applications.commands` scope
- `Send Messages` permission
- `Read Messages/View Channels` permission

### **API Security**

- All endpoints require authentication
- Health check endpoint is read-only
- Registration endpoint includes validation

## 🚀 **Production Deployment**

### **Docker Compose**

```yaml
services:
  backend:
    build:
      context: ./backend
    environment:
      - DISCORD_CLIENT_ID=${DISCORD_CLIENT_ID}
      - DISCORD_BOT_TOKEN=${DISCORD_BOT_TOKEN}
      - DISCORD_PUBLIC_KEY=${DISCORD_PUBLIC_KEY}
      - MONGODB_URI=${MONGODB_URI}
    # Commands are registered automatically on startup
```

### **Kubernetes**

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: commonly-backend
spec:
  template:
    spec:
      containers:
      - name: backend
        image: commonly-backend:latest
        env:
        - name: DISCORD_CLIENT_ID
          valueFrom:
            secretKeyRef:
              name: discord-secrets
              key: client-id
        - name: DISCORD_BOT_TOKEN
          valueFrom:
            secretKeyRef:
              name: discord-secrets
              key: bot-token
        # Commands are registered automatically on startup
```

### **Health Check Integration**

```yaml
# Kubernetes health check
livenessProbe:
  httpGet:
    path: /api/discord/health
    port: 5000
  initialDelaySeconds: 30
  periodSeconds: 60

readinessProbe:
  httpGet:
    path: /api/discord/health
    port: 5000
  initialDelaySeconds: 10
  periodSeconds: 30
```

## 📚 **API Reference**

### **Health Check**

```http
GET /api/discord/health
```

**Response:**
```json
{
  "timestamp": "2023-12-01T15:30:45.123Z",
  "status": "healthy|degraded|no_integrations|error",
  "integrations": [...],
  "summary": {...}
}
```

### **Bulk Registration**

```http
POST /api/discord/register-all
```

**Response:**
```json
{
  "success": true,
  "message": "All commands registered successfully",
  "details": {
    "registered": 2,
    "failed": 0,
    "total": 2
  }
}
```

## ✅ **Success Checklist**

After deployment, verify:

- [ ] Commands appear in Discord when typing `/`
- [ ] Health check returns `"status": "healthy"`
- [ ] All integrations show as registered
- [ ] No errors in container logs
- [ ] `/discord-status` command works
- [ ] `/commonly-summary` command works
- [ ] Commands respond within 3 seconds

## 🆘 **Support**

If you encounter issues:

1. **Check logs**: `docker-compose logs backend`
2. **Verify health**: `curl http://localhost:5000/api/discord/health`
3. **Test manually**: `npm run discord:deploy`
4. **Check Discord Developer Portal**: Verify bot permissions
5. **Review this guide**: Check troubleshooting section

The system is designed to be resilient and will continue working even if command registration fails! 🚀 
