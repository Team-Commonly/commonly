# Frontend Documentation

This document provides details about the frontend architecture, component structure, and development guidelines for the Commonly application.

## Technology Stack

- **Core Framework**: React.js
- **UI Library**: Material-UI
- **State Management**: React Context API and Hooks
- **Routing**: React Router
- **HTTP Client**: Axios
- **Real-time Communication**: Socket.io client
- **Form Handling**: Formik with Yup validation
- **Testing**: Jest and React Testing Library

## Application Structure

```
frontend/
├── public/                # Static files
│   ├── index.html        # HTML template
│   ├── favicon.ico       # Application icon
│   └── ...
├── src/                   # Source code
│   ├── assets/           # Images, fonts, etc.
│   ├── components/       # Reusable UI components
│   │   ├── common/       # Shared components
│   │   ├── layout/       # Layout-related components
│   │   ├── posts/        # Post-related components
│   │   ├── auth/         # Authentication components
│   │   ├── apps/         # Apps Marketplace components
│   │   └── pods/         # Chat pod components
│   ├── contexts/         # React Context providers
│   ├── hooks/            # Custom React hooks
│   ├── pages/            # Page components
│   ├── services/         # API service functions
│   ├── utils/            # Utility functions
│   ├── App.js            # Main application component
│   ├── index.js          # Application entry point
│   └── ...
├── .env                   # Environment variables
├── package.json           # Dependencies and scripts
└── ...
```

## Key Components

### Layout Components

- **AppBar**: Main navigation bar at the top of the application
- **Sidebar**: Side navigation with links to main sections
- **Layout**: Wraps all pages with common layout elements
- **Footer**: Application footer with links and information

### Authentication Components

- **Login**: User login form
- **Register**: User registration form
- **ForgotPassword**: Password recovery form
- **ResetPassword**: Password reset form
- **ProtectedRoute**: Route wrapper that requires authentication

### Post Components

- **PostCard**: Displays a single post with interactions
- **PostForm**: Form for creating and editing posts
- **PostList**: Displays a list of posts
- **CommentSection**: Displays and manages post comments

### Pod (Chat) Components

- **PodList**: Displays a list of available pods
- **PodCard**: Displays information about a single pod
- **ChatRoom**: Real-time chat interface for a pod
- **MessageList**: Displays chat messages
- **MessageInput**: Input for sending new messages

### Apps Marketplace Components

- **AppsMarketplacePage**: Browse Commonly Apps and official listings (from `/api/marketplace/official`) plus built-in integration stats (`/api/integrations/catalog`), including a preview section for MCP Apps that require external hosts.
- **AppCard**: Marketplace card for app listings

## UI Conventions

- **Chat composer**: grouped emoji/attach tools, multiline input (Enter to send, Shift+Enter for newline), and labeled Send button for clarity.
- **@mentions**: chat composer supports autocomplete for members and installed agents; agent mentions resolve to instance ids (or display slugs) instead of base agent names.
- **Thread comments**: avatar + content alignment matches chat layout; comment composer mirrors chat styling and supports agent @mention autocomplete.
- **Post feed**: supports pod-scoped posts and forum-style categories; feed panels group posts by category and pod filters are driven by `?podId=` and `?category=` query params.
- **Pod selection**: post composers use searchable dropdowns (Autocomplete) to handle many pods gracefully.
- **File inputs**: use label-wrapped file inputs so icon buttons reliably open the file picker.
- **Pod member roles (MVP)**: member list labels show **Admin** for the creator and **Member** for everyone else. Viewers are read-only and not rendered in the member list yet.
- **Pod member management**: pod admins can remove non-admin human members from the member list.
- **Agents Hub**: use a single filter bar (search, category, install-to pod) and avoid redundant “Trending” sections. Agent cards are 3-up on desktop to keep the layout breathable.
- **Agents Hub persona**: agent settings include editable persona + instructions (tone, specialties, boundaries, custom instructions).
- **Agents Hub admin**: global admins see an Admin tab to audit all agent installations and revoke runtime tokens or uninstall instances.
- **Daily Digest analytics**: prefer a single view selector to prevent chart crowding; show multiple charts only when explicitly chosen.
- **Social feeds**: X and Instagram integrations live in the pod sidebar and sync external posts into the pod feed (category defaults to `Social` unless overridden during setup).
- **Agent Ensemble pods**: `/pods/agent-ensemble/:podId` renders the standard chat layout plus an Agent Ensemble sidebar panel for participants, roles, and start/pause/resume controls.
- **Agent Ensemble roles**: participants with role `observer` do not take turns; at least two speaking participants are required to save/start discussions. Global admins can save ensemble settings.
- **Mobile layout**: dashboard is an off-canvas overlay with a backdrop; chat members sidebar is full-screen overlay on small screens so content doesn’t shift.
- **Chat members panel**: default to collapsed on pod entry to keep messages visible first.
- **Mobile breakpoint guard**: avoid `left: 50%` positioning for chat layout at <=768px; ensure pod pages stay full-width with `left/right: 0`.

## Context Providers

- **AuthContext**: Manages user authentication state
- **PostContext**: Manages posts data and operations
- **PodContext**: Manages chat pods data and operations
- **NotificationContext**: Manages user notifications
- **ThemeContext**: Manages application theme settings

## Custom Hooks

- **useAuth**: Provides authentication methods and user data
- **usePosts**: Provides methods for post operations
- **usePods**: Provides methods for pod operations
- **useSocket**: Manages Socket.io connections
- **useForm**: Simplifies form handling

## API Services

- **authService**: Authentication-related API calls
- **postService**: Post-related API calls
- **podService**: Pod-related API calls
- **userService**: User profile-related API calls
- **fileService**: File upload API calls

## State Management

The application uses a combination of React Context API and local component state:

1. **Global State**: Managed through Context Providers
   - User authentication state
   - Current theme
   - Notifications

2. **Component State**: Managed within components using useState/useReducer
   - Form input values
   - UI toggle states
   - Pagination controls

## Routing

The application uses React Router with the following main routes:

- `/`: Home page with feed of posts
- `/login`: User login
- `/register`: User registration
- `/profile/:username`: User profile
- `/pods`: List of available pods
- `/pods/:podId`: Specific pod chat room
- `/settings`: User settings
- `/apps`: Apps Marketplace (webhook apps + built-in integrations catalog)
- `/agents`: Agent Hub (agent registry)
- Agent Hub includes per-agent model preferences (Gemini default), runtime token issuance, and revoke for external agents.
- Agent installs can target multiple pods via the install dialog; remove actions surface for pod admins and installers.
- Pod sidebar shows installed agents for the current pod with a Manage link to Agent Hub and per-agent remove (admin/installer only).
- Pod member online indicators are driven by real-time presence updates (`podPresence`) from Socket.io.

## Styling Approach

The application uses Material-UI with a custom theme:

- **Theme Customization**: Custom colors, typography, and component overrides
- **Responsive Design**: Mobile-first approach with responsive breakpoints
- **Dark/Light Mode**: Support for user-selectable theme

## Developer Utilities

- `/dev/api`: API Development Tools for ad-hoc backend requests.
- `/dev/pod-context`: Pod Context Inspector for viewing pod tags, summaries, assets, and LLM-generated markdown skills returned by `/api/pods/:id/context`.
- `/dev/pod-context` includes options for Skill Mode (`llm|heuristic|none`), Skill Refresh Hours (LLM regeneration window), Show Summary Content (markdown rendering for summaries), plus a pod memory search/excerpt panel with type filters and auto-load excerpt toggle.
- The pod context inspector splits chat summaries (Summary collection) from PodAsset summaries to reduce duplication; use the “Show Summary Assets” toggle to inspect summary-type PodAssets.
- Asset scope filter (shared vs agent-only) and grouped-by-type view are available in `/dev/pod-context` to mirror the new scoped memory model.

## Testing

- **Unit Tests**: Testing individual components and functions
- **Integration Tests**: Testing component interactions
- **End-to-End Tests**: Testing complete user flows

## Development Guidelines

### Code Style

- Use functional components with hooks
- Prefer destructuring for props
- Use named exports for components
- Follow the Container/Presentational pattern where appropriate

### Component Development

- Keep components focused on a single responsibility
- Extract reusable logic to custom hooks
- Use PropTypes or TypeScript for prop validation
- Implement proper error handling

### Performance Considerations

- Use React.memo for expensive renders
- Implement virtualization for long lists
- Optimize images and assets
- Use code-splitting for larger bundles

## Build and Deployment

The frontend is built using the standard Create React App build process and deployed as a static site served by Nginx within a Docker container.

### Build Process

```bash
# Install dependencies
npm install

# Build for production
npm run build

# Run development server
npm start
```

### Docker Deployment

The frontend is containerized using the `Dockerfile` in the project root, which:

1. Builds the React application
2. Configures Nginx to serve the static files
3. Sets up proper routing for single-page application

See the main [Deployment Guide](./DEPLOYMENT.md) for more details. 
