---
name: frontend-dev
description: Frontend development context for React.js, Material-UI, Context API, hooks, and component patterns. Use when working on frontend code.
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
- Integration catalog UI lives in `frontend/src/components/IntegrationsCatalog.js` and consumes `GET /api/integrations/catalog`.

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
