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
