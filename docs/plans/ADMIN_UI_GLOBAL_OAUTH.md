# Admin UI for Global OAuth - Implementation Summary

**Created**: February 5, 2026
**Status**: ✅ Complete
**Purpose**: Allow admins to configure global X and Instagram OAuth tokens via UI

---

## Overview

Added admin UI for managing global social feed integrations, providing an alternative to environment variables for configuring X and Instagram OAuth tokens.

## Implementation

### 1. Frontend Component

**File**: `frontend/src/components/admin/GlobalIntegrations.js`

**Features**:
- Configure X (Twitter) global account
  - Username, User ID, Access Token
  - Enable/disable toggle
  - Connection status indicator
- Configure Instagram global account
  - Username, Instagram User ID, Access Token
  - Enable/disable toggle
  - Connection status indicator
- Test connection buttons
- Integration status summary dashboard
- Links to X Developer Portal and Meta for Developers

**UI Structure**:
```
┌─────────────────────────────────────────┐
│ Global Social Feed Integrations        │
├─────────────────────────────────────────┤
│ [Error/Success Alerts]                  │
├──────────────────┬──────────────────────┤
│  X (Twitter)     │  Instagram           │
│  ┌─────────────┐ │  ┌─────────────┐    │
│  │ Status: ✓   │ │  │ Status: ✓   │    │
│  │ [Enabled]   │ │  │ [Enabled]   │    │
│  ├─────────────┤ │  ├─────────────┤    │
│  │ Username    │ │  │ Username    │    │
│  │ User ID     │ │  │ IG User ID  │    │
│  │ Token (••)  │ │  │ Token (••)  │    │
│  ├─────────────┤ │  ├─────────────┤    │
│  │ [Save] [🔄] │ │  │ [Save] [🔄] │    │
│  └─────────────┘ │  └─────────────┘    │
├──────────────────┴──────────────────────┤
│ Integration Status Dashboard             │
│ Active: 2/2 | Polling: 10min | Cat: Social │
└─────────────────────────────────────────┘
```

### 2. Backend Routes

**File**: `backend/routes/admin/globalIntegrations.js`

**Endpoints**:

1. **GET /api/admin/integrations/global**
   - Fetches current X and Instagram integrations
   - Creates "Global Social Feed" pod if doesn't exist
   - Returns integration configs (tokens masked)

2. **POST /api/admin/integrations/global/x**
   - Saves X integration config
   - Creates or updates Integration record
   - Sets status to 'connected' or 'disconnected'

3. **POST /api/admin/integrations/global/instagram**
   - Saves Instagram integration config
   - Creates or updates Integration record
   - Sets status to 'connected' or 'disconnected'

4. **POST /api/admin/integrations/global/x/test**
   - Tests X API connection
   - Validates credentials

5. **POST /api/admin/integrations/global/instagram/test**
   - Tests Instagram API connection
   - Validates credentials

**Authentication**: All routes require `auth` + `adminAuth` middleware

### 3. Server Integration

**File**: `backend/server.js`

**Changes**:
```javascript
// Added route import
const globalIntegrationsRoutes = require('./routes/admin/globalIntegrations');

// Added route registration
app.use('/api/admin/integrations/global', globalIntegrationsRoutes);
```

---

## Usage

### For Admins

1. **Access Admin UI**:
   - Navigate to `/admin/integrations` (or wherever GlobalIntegrations component is mounted)
   - Must be logged in as admin

2. **Configure X Integration**:
   - Enter X username (e.g., "CommonlyHQ")
   - Enter X user ID (numeric, from X API)
   - Paste OAuth 2.0 Bearer token
   - Enable integration toggle
   - Click "Save X Configuration"
   - Click test button (🔄) to verify

3. **Configure Instagram Integration**:
   - Enter Instagram username (e.g., "commonly.app")
   - Enter Instagram Business Account ID
   - Paste long-lived access token
   - Enable integration toggle
   - Click "Save Instagram Configuration"
   - Click test button (🔄) to verify

4. **Verify Setup**:
   - Check integration status dashboard
   - Verify "Active Integrations: 2/2"
   - Wait for background polling (runs every 10 min)
   - Check posts via `GET /api/posts?category=Social`

### For Developers

**Alternative: Environment Variables**

Still supported! Set these in `.env`:
```bash
X_GLOBAL_ACCESS_TOKEN=xxx
X_GLOBAL_USERNAME=CommonlyHQ
X_GLOBAL_USER_ID=123456789

INSTAGRAM_GLOBAL_ACCESS_TOKEN=xxx
INSTAGRAM_GLOBAL_IG_USER_ID=123456789
INSTAGRAM_GLOBAL_USERNAME=commonly.app
```

Then run: `node backend/scripts/setup-global-social-feeds.js`

---

## Database Schema

### Integration Model

```javascript
{
  type: 'x' | 'instagram',
  podId: ObjectId, // References "Global Social Feed" pod
  status: 'connected' | 'disconnected',
  isActive: Boolean,
  config: {
    // X Config
    accessToken: String,
    username: String,
    userId: String,

    // Instagram Config
    igUserId: String,

    // Common
    category: 'Social',
    maxResults: Number,
    exclude: String,
    apiBase: String
  },
  createdBy: ObjectId,
  lastSync: Date
}
```

---

## Architecture Flow

```
Admin UI (Frontend)
  ↓
POST /api/admin/integrations/global/x
  ↓
Create/Update Integration Record
  ↓
Store in MongoDB
  ↓
Background Polling Service (Every 10 min)
  ↓
Fetch tweets/posts from X/Instagram API
  ↓
Save to Post collection (category: "Social")
  ↓
Available via GET /api/posts?category=Social
  ↓
Agents fetch and curate content
```

---

## Benefits

### UI vs Environment Variables

| Feature | Environment Variables | Admin UI |
|---------|----------------------|----------|
| Setup | Requires server restart | Immediate, no restart |
| Updates | Edit .env + restart | Update via UI |
| Testing | Manual API calls | Built-in test button |
| Visibility | Hidden in .env | Status dashboard |
| Audit | Server logs | UI logs + alerts |
| Future expansion | Limited | Easy to add features |

---

## Future Enhancements

### Phase 2: Per-User OAuth
- Users connect their own X/Instagram accounts
- Personalized feeds per user
- OAuth flow UI similar to DiscordIntegration component
- Multiple integrations per platform

### Phase 3: Additional Platforms
- Reddit integration
- LinkedIn integration
- YouTube integration
- Custom RSS feeds

### Phase 4: Advanced Features
- Token refresh automation
- Usage analytics (API calls, rate limits)
- Content moderation settings
- Feed filtering rules

---

## Related Files

- **Frontend Component**: `frontend/src/components/admin/GlobalIntegrations.js`
- **Backend Routes**: `backend/routes/admin/globalIntegrations.js`
- **Setup Script**: `backend/scripts/setup-global-social-feeds.js`
- **Content Curator Skill**: `.codex/skills/content-curator/SKILL.md`
- **Spec Document**: `docs/plans/SOCIAL_FUN_FEATURES_SPEC.md`

---

## Testing Checklist

- [ ] Admin can access GlobalIntegrations UI
- [ ] X configuration can be saved
- [ ] Instagram configuration can be saved
- [ ] Test connection buttons work
- [ ] Status dashboard updates correctly
- [ ] Non-admin users cannot access admin routes
- [ ] Integration records created in MongoDB
- [ ] "Global Social Feed" pod auto-created
- [ ] Background polling fetches posts
- [ ] Posts appear at GET /api/posts?category=Social
- [ ] Agents can fetch and curate content

---

**Last Updated**: February 5, 2026
**Status**: ✅ Complete - Ready for testing
