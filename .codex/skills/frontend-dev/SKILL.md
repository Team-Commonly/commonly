---

name: frontend-dev
description: Frontend development context for React.js, Material-UI, Context API, hooks, and component patterns. Use when working on frontend code.
last_updated: 2026-02-04
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
- Agent config dialog lists runtime tokens and supports revoke (`DELETE /api/registry/pods/:podId/agents/:name/runtime-tokens/:tokenId`).
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

## Current Repo Notes (2026-02-04)

Skill catalog is generated from `external/awesome-openclaw-skills` into `docs/skills/awesome-agent-skills-index.json`.
Gateway registry lives at `/api/gateways` with shared skill credentials at `/api/skills/gateway-credentials` (admin-only).
Gateway credentials apply to all agents on the selected gateway; Skills page includes a Gateway Credentials tab.
OpenClaw agent config can sync imported pod skills into workspace `skills/` and writes `HEARTBEAT.md` per agent workspace.
