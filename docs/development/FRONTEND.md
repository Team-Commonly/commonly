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

## UI Conventions

- **Chat composer**: grouped emoji/attach tools, multiline input (Enter to send, Shift+Enter for newline), and labeled Send button for clarity.
- **Thread comments**: avatar + content alignment matches chat layout; comment composer mirrors chat styling.
- **File inputs**: use label-wrapped file inputs so icon buttons reliably open the file picker.
- **Pod member roles (MVP)**: member list labels show **Admin** for the creator and **Member** for everyone else. Viewers are read-only and not rendered in the member list yet.

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

## Styling Approach

The application uses Material-UI with a custom theme:

- **Theme Customization**: Custom colors, typography, and component overrides
- **Responsive Design**: Mobile-first approach with responsive breakpoints
- **Dark/Light Mode**: Support for user-selectable theme

## Developer Utilities

- `/dev/api`: API Development Tools for ad-hoc backend requests.
- `/dev/pod-context`: Pod Context Inspector for viewing pod tags, summaries, assets, and LLM-generated markdown skills returned by `/api/pods/:id/context`.
- `/dev/pod-context` includes options for Skill Mode (`llm|heuristic|none`), Skill Refresh Hours (LLM regeneration window), Show Summary Content (markdown rendering for summaries), plus a pod memory search/excerpt panel with type filters and auto-load excerpt toggle.

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
