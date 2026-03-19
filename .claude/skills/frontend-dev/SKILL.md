---

name: frontend-dev
description: Frontend development context for React.js, Material-UI, Context API, hooks, and component patterns. Use when working on frontend code.
last_updated: 2026-03-19
---

# Frontend Development

**Technologies**: React.js, Material-UI, Context API, React Router, Axios

## Required Knowledge
- React functional components and hooks
- Context API for state management
- Material-UI theming and components
- Responsive design principles
- Form handling (Formik/Yup)

## Relevant Documentation

| Document | Topics Covered |
|----------|----------------|
| [FRONTEND.md](../../../docs/development/FRONTEND.md) | Component structure, routing, state management |
| [ARCHITECTURE.md](../../../docs/architecture/ARCHITECTURE.md) | Frontend-backend communication |
| [POD_SKILLS_INDEX.md](../../../docs/design/POD_SKILLS_INDEX.md) | Pod context + skills design |

## Key Components

```
frontend/src/
├── components/
│   ├── common/        # Shared UI components
│   ├── layout/        # AppBar, Sidebar, Footer
│   ├── auth/          # Login, Register, ProtectedRoute
│   ├── posts/         # PostCard, PostForm, PostList
│   └── pods/          # ChatRoom, MessageList, PodCard
├── contexts/          # AuthContext, PodContext, ThemeContext
├── hooks/             # useAuth, useSocket, usePods
└── services/          # API service functions
```

## Developer Utilities and Context UI

- `/dev/api` is the ad-hoc API testing surface.
- `/dev/pod-context` inspects `GET /api/pods/:id/context` output.
- Skill Mode selection (`llm|heuristic|none`).
- Skill Refresh Hours for LLM regeneration windows.
- Markdown rendering for skill documents and (optionally) summary content.
- Pod memory search + excerpt panel (`/api/pods/:id/context/search` and `/api/pods/:id/context/assets/:assetId`) with type filters and auto-load excerpts.
- Apps Marketplace UI lives in `frontend/src/components/apps/AppsMarketplacePage.js` and consumes `GET /api/marketplace/official` plus `GET /api/integrations/catalog`.
- Agent Hub UI lives in `frontend/src/components/agents/AgentsHub.js` and consumes `/api/registry/*` (installs, model prefs, runtime token issuance).
- Agent Hub also consumes `/api/registry/presets` for categorized preset recommendations and API/tool readiness,
  plus default skill bundle readiness from built-in OpenClaw skills and Dockerfile.commonly capabilities.
- Presets tab supports category chips (including `Social`) to segment curator-focused preset installs.
- Public marketing routes include `/` (landing) and `/use-cases/:useCaseId` for scenario-driven onboarding pages.
- `/verify-email` should render verification status plus a clear path forward (`Go to Login`) after completion.
- Global admin social integrations UI is routed at `/admin/integrations/global`.
- Agent config dialog lists runtime tokens and supports revoke (`DELETE /api/registry/pods/:podId/agents/:name/runtime-tokens/:tokenId`).
- Agent config dialog includes Integration Autonomy scope controls for `integration:read`, `integration:messages:read`, `integration:write`, and `config.autonomy.autoJoinAgentOwnedPods`.
- Runtime provision UI includes a force toggle that sends `force: true` to
  `POST /api/registry/pods/:podId/agents/:name/provision` for shared token rotation.
- Pod member labels are MVP roles: **Admin** for the creator and **Member** for everyone else (viewers are read-only and not rendered yet).
- Pod member online indicators are updated via Socket.io `podPresence` events.
- Agents Hub uses a single filter bar (search, category, install-to pod) with no Trending section; agent cards are 3-up on desktop.
- Daily Digest analytics uses a single view selector to avoid chart crowding.
- Mobile layout uses off-canvas sidebars (dashboard overlay with backdrop; chat members panel overlays full screen) to avoid content shifts.
- Chat members panel defaults to collapsed on pod entry so messages stay visible.
- Mobile breakpoint guard: keep pod chat layout full-width at <=768px (avoid `left: 50%` positioning on chat containers).
- Post feed supports pod-scoped posts and forum-style categories; use `?podId=` and `?category=` query params to filter, and expose pod ↔ feed navigation.
- Social feed integrations (X/Instagram) are configured from the pod sidebar integrations panel and sync external posts into the pod feed.

## Key Patterns

### Context Pattern
```javascript
const AuthContext = createContext();

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  return (
    <AuthContext.Provider value={{ user, setUser }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => useContext(AuthContext);
```

### Custom Hook Pattern
```javascript
const useSocket = (podId) => {
  const [messages, setMessages] = useState([]);

  useEffect(() => {
    socket.emit('join-pod', podId);
    socket.on('message', (msg) => setMessages(prev => [...prev, msg]));
    return () => socket.emit('leave-pod', podId);
  }, [podId]);

  return { messages };
};
```

## MCP Playwright — UI Verification Workflow

Use the `mcp__playwright__*` tools to verify frontend changes **without needing a manual browser** — navigate, snapshot, screenshot, click, and fill forms against the live dev URL.

### Standard verification loop
```
1. mcp__playwright__browser_navigate   → load the page/route
2. mcp__playwright__browser_snapshot   → get accessibility tree (best for asserting text/state)
3. mcp__playwright__browser_take_screenshot → visual confirmation (type: "png")
4. mcp__playwright__browser_click / browser_type  → interact with elements using ref= from snapshot
```

### Auth flow (JWT stored in localStorage)
```js
// Generate a token via kubectl, then inject:
mcp__playwright__browser_evaluate:
  function: () => { localStorage.setItem('token', 'eyJ...'); location.reload(); }
```

### Useful patterns
```js
// Resize to mobile viewport before snapshot
mcp__playwright__browser_resize: { width: 390, height: 844 }

// Wait for async content before snapshotting
mcp__playwright__browser_wait_for: { text: "Dev Team" }

// Navigate to a specific pod chat room
mcp__playwright__browser_navigate: { url: "https://app-dev.commonly.me/pods/chat/<podId>" }
```

### When to use Playwright MCP
- After every GKE frontend deploy to confirm the change is live
- Before/after responsive layout fixes (resize to 390px mobile, then 1280px desktop)
- Checking tab visibility, button placement, and text rendering
- Confirming modal/dialog flows without manual testing
- Debugging "I can't see X on the UI" reports — navigate directly and snapshot

---

## Responsive ChatRoom Header Pattern (2026-03-19)

`ChatRoom.js` AppBar must be `position="sticky"` (not `fixed`) so it flows below the outer Layout search bar rather than overlapping it at `top: 0`.

```jsx
<AppBar position="sticky" color="default" elevation={1} className="chat-room-header">
  <Toolbar sx={{ minHeight: { xs: 52, sm: 64 }, px: { xs: 1, sm: 2 } }}>
    <IconButton sx={{ mr: { xs: 0.5, sm: 1.5 }, flexShrink: 0 }}>...</IconButton>
    <Box sx={{ flexGrow: 1, overflow: 'hidden', mr: 1 }}>
      <Typography noWrap className="chat-room-title">{room?.name}</Typography>
      <Typography className="chat-room-subtitle">{members} members</Typography>
    </Box>
    {/* Hide secondary actions on mobile */}
    {!isMobile && <Button>Posts</Button>}
    {/* Tabs always visible */}
    <Tabs sx={{ flexShrink: 0 }}>
      <Tab sx={{ minHeight: { xs: 36, sm: 40 }, px: { xs: 1.5, sm: 2 }, fontSize: { xs: '0.8rem', sm: '0.85rem' } }} />
    </Tabs>
  </Toolbar>
</AppBar>
```

**CSS design tokens** — match `Pod.css` pattern, do NOT apply gradient to all `.MuiTypography-root`:
```css
.chat-room-title  { color: #e2e8f0; font-weight: 700; font-size: 1rem; }
.chat-room-subtitle { color: #9fb2cb; font-size: 0.78rem; display: block; }
```

---

## Pod Type System — Adding New Types (2026-03-19)

Pod types require updates in **two places**:

### 1. `PodRedirect.js` — category selector (landing at `/pods`)
Add a Button with `onClick={() => handleNavigate('<type>')}`:
```jsx
import GroupsIcon from '@mui/icons-material/Groups';
<Button startIcon={<GroupsIcon />} onClick={() => handleNavigate('team')}
  sx={{ backgroundColor: '#7c3aed', '&:hover': { backgroundColor: '#6d28d9' } }}>
  Team Pods
</Button>
```

### 2. `Pod.js` — tab list inside the category view
```js
// In getPodType() switch:
case 4: return 'team';
// In URL→tab useEffect switch:
case 'team': setTabValue(4); break;
// In JSX Tabs:
<Tab label="Teams" className="pod-tab" />
```

---

## Current Repo Notes (2026-02-08)

Skill catalog is generated from `external/awesome-openclaw-skills` into `docs/skills/awesome-agent-skills-index.json`.
Gateway registry lives at `/api/gateways` with shared skill credentials at `/api/skills/gateway-credentials` (admin-only).
Gateway credentials apply to all agents on the selected gateway; Skills page includes a Gateway Credentials tab.
OpenClaw agent config can sync imported pod skills into workspace `skills/` and writes `HEARTBEAT.md` per agent workspace.
Activity page (`/activity`) is social-first with `Updates` + `Actions` tabs, live pod message updates,
and unread controls (`Mark read`, `Mark all read`).
Dedicated user profiles are available at `/profile/:id` and support follow/unfollow.
Thread pages support follow/unfollow so followed-thread updates appear in Activity quick view.
Pod browse (`/pods/:type`) is pre-entry-first: include `All/Joined/Discover` filters, preview-before-join, and mobile-safe control density.
Pod browse cards should include a compact member avatar overview (max 4 + overflow) with role-aware styling for Admin/Agent/Member.
Pod overview member strips should resolve agent avatars from installed-agent profiles per pod (`/api/registry/pods/:podId/agents`) so agent icons match Agent Hub cards.
Joined pod cards should show explicit unread indicators (red dot/unread chip) based on the local per-pod read cursor vs latest message timestamp.
Pod summary lightbulb should only toggle display mode (description vs cached summary); regeneration belongs to the refresh button, and per-pod view mode should persist across navigation.
ChatRoom agent identity/avatar mapping is now case-insensitive, so display-name agent messages still resolve installed icon URLs.
Chat/member identity labels should be clickable: users -> `/profile/:id`, agents -> Agents Hub installed deep link with `podId`, `agent`, `instanceId`, `view=overview`.
Agents Hub card avatar precedence should stay aligned across tabs: `iconUrl` first, then profile icon/avatar URL fields.
Agents Hub deep links should default to read-only overview for non-managers; only installer/pod-admin/global-admin can configure runtime settings.
Agent Hub cards should not render star ratings for now; keep card footer space focused on primary actions (install/configure/remove) for better desktop layout.
Activity feed unread state should be visually explicit (accent border + unread marker chip), not just dim/highlight.
