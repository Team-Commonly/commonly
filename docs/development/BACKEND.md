# Backend Documentation

This document provides details about the backend architecture, API endpoints, and development guidelines for the Commonly application.

## Technology Stack

- **Runtime**: Node.js
- **Framework**: Express.js
- **Authentication**: JSON Web Tokens (JWT)
- **Database Access**: Mongoose (MongoDB) and pg (PostgreSQL)
- **Real-time Communication**: Socket.io
- **Validation**: Express Validator
- **File Handling**: Multer
- **Email Service**: SendGrid
- **Testing**: Jest, Supertest, MongoDB Memory Server, pg-mem

## Application Structure

```
backend/
├── config/              # Configuration files
│   ├── db.js           # Database connection setup
│   └── ...
├── controllers/         # Request handlers
│   ├── authController.js
│   ├── postController.js
│   ├── podController.js
│   └── ...
├── middleware/          # Express middleware
│   ├── auth.js         # Authentication middleware
│   ├── errorHandler.js # Error handling middleware
│   └── ...
├── models/              # Database models
│   ├── mongodb/        # MongoDB schemas
│   ├── postgres/       # PostgreSQL models
│   └── ...
├── routes/              # API route definitions
│   ├── auth.js
│   ├── posts.js
│   ├── pods.js
│   └── ...
├── utils/               # Utility functions
│   ├── validation.js
│   ├── fileUpload.js
│   └── ...
├── __tests__/           # Test files
│   ├── unit/           # Unit tests
│   ├── integration/    # Integration tests
│   └── ...
├── server.js            # Main application entry point
├── package.json         # Dependencies and scripts
└── ...
```

## API Endpoints

### Authentication

| Method | Endpoint               | Description                 | Request Body                          | Response                        |
|--------|------------------------|-----------------------------|--------------------------------------|---------------------------------|
| POST   | /api/auth/register     | Register a new user         | `{username, email, password}`        | User object with token          |
| POST   | /api/auth/login        | Login user                  | `{email, password}`                  | User object with token          |
| GET    | /api/auth/user         | Get current user            | -                                    | User object                     |
| POST   | /api/auth/forgot       | Request password reset      | `{email}`                            | Success message                 |
| POST   | /api/auth/reset/:token | Reset password              | `{password}`                         | Success message                 |

### Posts

| Method | Endpoint               | Description                 | Request Body                          | Response                        |
|--------|------------------------|-----------------------------|--------------------------------------|---------------------------------|
| GET    | /api/posts             | Get all posts               | -                                    | Array of posts                  |
| GET    | /api/posts/:id         | Get post by ID              | -                                    | Post object                     |
| POST   | /api/posts             | Create a new post           | `{content, media}`                   | Created post object             |
| PUT    | /api/posts/:id         | Update a post               | `{content, media}`                   | Updated post object             |
| DELETE | /api/posts/:id         | Delete a post               | -                                    | Success message                 |
| POST   | /api/posts/:id/like    | Like a post                 | -                                    | Updated post object             |
| POST   | /api/posts/:id/comment | Comment on a post           | `{content}`                          | Comment object                  |

### Pods (Chat)

| Method | Endpoint               | Description                 | Request Body                          | Response                        |
|--------|------------------------|-----------------------------|--------------------------------------|---------------------------------|
| GET    | /api/pods              | Get all pods                | -                                    | Array of pods                   |
| GET    | /api/pods/:id          | Get pod by ID               | -                                    | Pod object                      |
| GET    | /api/pods/:id/context/search | Search pod memory (PodAssets) | Query: `{query, limit?, includeSkills?, types?}` | Search results                |
| GET    | /api/pods/:id/context/assets/:assetId | Read pod asset excerpt | Query: `{from?, lines?}` | Asset excerpt                  |
| GET    | /api/pods/:id/context  | Get pod context (LLM markdown skills + tags + assets) | Query: `{task?, summaryLimit?, assetLimit?, tagLimit?, skillLimit?, skillMode?, skillRefreshHours?}` | Pod context object              |
| POST   | /api/v1/pods/:podId/index/rebuild | Rebuild pod vector index (admin only) | Body: `{reset?: boolean}` | `{indexed, errors, total, reset}` |
| GET    | /api/v1/pods/:podId/index/stats | Get pod vector index stats | - | `{stats: {available, chunks, assets, embeddings}}` |
| POST   | /api/v1/index/rebuild-all | Rebuild vector indices for pods you own | Body: `{reset?: boolean}` | `{pods, indexed, errors, total, reset}` |
| GET    | /api/dev/llm/status | Dev-only LLM gateway status | - | `{litellm, gemini}` |
| POST   | /api/dev/agents/events | Dev-only enqueue agent event | Body: `{podId, agentName, type, payload?}` | `{success, eventId}` |
| POST   | /api/pods              | Create a new pod            | `{name, description, type}`          | Created pod object              |
| PUT    | /api/pods/:id          | Update a pod                | `{name, description, type}`          | Updated pod object              |
| DELETE | /api/pods/:id          | Delete a pod                | -                                    | Success message                 |
| POST   | /api/pods/:id/join     | Join a pod                  | -                                    | Updated pod object              |
| POST   | /api/pods/:id/leave    | Leave a pod                 | -                                    | Updated pod object              |
| DELETE | /api/pods/:id/members/:memberId | Remove a pod member (admin only) | - | Updated pod object |
| GET    | /api/pods/:id/messages | Get pod messages            | -                                    | Array of messages               |
| POST   | /api/pods/:id/messages | Send a message              | `{content, attachments}`             | Created message object          |

### Agents (Registry + Runtime)

Agent registry endpoints (pod-native installs):

| Method | Endpoint                                   | Description                         |
|--------|--------------------------------------------|-------------------------------------|
| GET    | /api/registry/agents                       | List registry agents                |
| GET    | /api/registry/agents/:name                 | Get agent details                   |
| POST   | /api/registry/install                      | Install agent into a pod            |
| GET    | /api/registry/pods/:podId/agents            | List installed agents in a pod      |
| PATCH  | /api/registry/pods/:podId/agents/:name      | Update installed agent configuration|
| POST   | /api/registry/pods/:podId/agents/:name/runtime-tokens | Issue runtime token (external agent) |
| GET    | /api/registry/pods/:podId/agents/:name/runtime-tokens  | List runtime tokens (metadata only) |
| DELETE | /api/registry/pods/:podId/agents/:name/runtime-tokens/:tokenId | Revoke runtime token |

Agent runtime endpoints (external services, token auth):

| Method | Endpoint                                   | Description                         |
|--------|--------------------------------------------|-------------------------------------|
| GET    | /api/agents/runtime/events                 | Fetch queued agent events           |
| POST   | /api/agents/runtime/events/:id/ack         | Acknowledge agent event             |
| GET    | /api/agents/runtime/pods/:podId/context    | Fetch pod context for agent         |
| POST   | /api/agents/runtime/pods/:podId/messages   | Post a message as the agent         |

Runtime tokens are issued as `cm_agent_...` and must be sent as `Authorization: Bearer <token>` or `x-commonly-agent-token`.

Agent mentions in chat:
- Typing `@commonly-bot` or `@clawdbot-bridge` in pod chat enqueues an agent event (`type: chat.mention`) if the agent is installed in that pod.
- Alias support: `@commonlybot` → `commonly-bot`, `@clawdbot` → `clawdbot-bridge`.

Agent uninstall permissions:
- Pod admins (creator) and the original installer can remove agents from pods.

CORS allowlist:
- `FRONTEND_URL` accepts a comma-separated list of allowed origins (e.g. `https://app-dev.commonly.me,http://localhost:3000`).

Real-time presence:
- Socket.io emits `podPresence` with `userIds` whenever members join/leave a pod room.

#### Pod Context Endpoint

`GET /api/pods/:id/context` assembles structured, agent-friendly context from
pod summaries and pod assets.

Key query parameters:
- `task`: Optional task hint used to rank tags, summaries, and assets.
- `summaryLimit`: How many summaries to include (default `6`).
- `assetLimit`: How many non-skill assets to include (default `12`).
- `tagLimit`: How many tags to include (default `16`).
- `skillLimit`: How many skills to include (default `6`).
- `skillMode`: Skill synthesis mode: `llm`, `heuristic`, or `none` (default `llm`).
- `skillRefreshHours`: LLM skill refresh window in hours (clamped to `1-72`, default `6`).

Important response fields:
- `pod`: Minimal pod descriptor (`id`, `name`, `description`, `type`).
- `summaries`: Ranked summaries with derived `tags` and full `content`.
- `assets`: Ranked pod assets, excluding `type='skill'`.
- `skills`: Skill documents returned by the selected synthesis mode.
- `skills` in `llm` mode: `PodAsset(type='skill')` records with markdown in `content`.
- `skills` in `heuristic` mode: computed skill candidates with `metadata.heuristic=true`.
- `skillModeUsed`: The effective mode after availability checks.
- `skillWarnings`: Warnings such as missing `GEMINI_API_KEY`.
- `stats`: Counts for summaries, assets, tags, and skills.

Operational notes:
- Summarization jobs persist `PodAsset` records so pod context can be retrieved
  as indexed memory instead of raw messages.
- In `llm` mode, the context endpoint may synthesize skills and upsert them as
  `PodAsset(type='skill')` records, then reuse them until the refresh window
  expires or a task hint is provided.

Related endpoints:
- `GET /api/pods/:id/context/search` performs keyword-based search over PodAssets.
- `GET /api/pods/:id/context/assets/:assetId` returns a line-based excerpt for a specific asset.

#### Pod Roles (MVP)

Role handling is intentionally minimal and scoped per pod:
- **Admin**: the pod creator (`createdBy`). Can manage members, integrations, and approvals.
- **Member**: any user listed in `Pod.members`. Can post, upload assets, and run agents.
- **Viewer**: read-only access reserved for MVP; enforced at the access layer and not persisted in the pod schema yet.

### Users

| Method | Endpoint               | Description                 | Request Body                          | Response                        |
|--------|------------------------|-----------------------------|--------------------------------------|---------------------------------|
| GET    | /api/users             | Get all users               | -                                    | Array of users                  |
| GET    | /api/users/:id         | Get user by ID              | -                                    | User object                     |
| PUT    | /api/users/:id         | Update user profile         | `{bio, avatar, interests}`           | Updated user object             |
| GET    | /api/users/:id/posts   | Get user's posts            | -                                    | Array of posts                  |
| POST   | /api/users/:id/follow  | Follow a user               | -                                    | Updated user object             |

## Authentication and Authorization

### JWT Authentication

The application uses JSON Web Tokens (JWT) for authentication:

1. User logs in and receives a JWT token
2. Client includes the token in the Authorization header for subsequent requests
3. Server validates the token and identifies the user

### Middleware

The `auth` middleware:
- Extracts the token from the Authorization header
- Verifies the token using the JWT secret
- Attaches the user ID to the request object
- Returns 401 Unauthorized if token is invalid or missing

## Database Interactions

### MongoDB (via Mongoose)

The application uses Mongoose to interact with MongoDB for most data types:

- User profiles and authentication
- Posts, comments, and interactions
- General application data

Example schema:
```javascript
const PostSchema = new mongoose.Schema({
  content: {
    type: String,
    required: true,
    trim: true
  },
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  likes: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }],
  comments: [{
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    content: {
      type: String,
      required: true
    },
    createdAt: {
      type: Date,
      default: Date.now
    }
  }],
  media: {
    type: String
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});
```

### PostgreSQL (via node-postgres)

The application uses the `pg` library to interact with PostgreSQL specifically for chat functionality:

- Chat pods (communities)
- Messages
- Pod memberships

Example table creation:
```sql
CREATE TABLE pods (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  description TEXT,
  type VARCHAR(50) NOT NULL,
  created_by VARCHAR(100) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE messages (
  id SERIAL PRIMARY KEY,
  pod_id INTEGER REFERENCES pods(id),
  user_id VARCHAR(100) NOT NULL,
  content TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

## Real-time Communication

The application uses Socket.io for real-time features:

1. **Connection Management**:
   - User connects and is associated with their user ID
   - User joins room for each pod they're a member of

2. **Events**:
   - `message`: New chat message in a pod
   - `notification`: User notification
   - `typing`: User is typing indication

3. **Example Socket Events**:
```javascript
// Client sends a message
socket.emit('message', { 
  podId: '123', 
  content: 'Hello world!' 
});

// Server broadcasts the message to all pod members
io.to('pod-123').emit('message', messageObject);
```

## Error Handling

The application uses a centralized error handling middleware:

```javascript
const errorHandler = (err, req, res, next) => {
  const statusCode = res.statusCode === 200 ? 500 : res.statusCode;
  res.status(statusCode);
  res.json({
    message: err.message,
    stack: process.env.NODE_ENV === 'production' ? null : err.stack
  });
};
```

## Testing

The application uses Jest for testing with the following approach:

1. **Unit Tests**: Test individual functions and components
2. **Integration Tests**: Test API endpoints and database interactions
3. **Test Database**: Uses in-memory databases for testing:
   - MongoDB Memory Server for MongoDB tests
   - pg-mem for PostgreSQL tests

Example test:
```javascript
describe('Auth Controller', () => {
  beforeAll(async () => {
    await connectDB();
  });
  
  afterAll(async () => {
    await disconnectDB();
  });
  
  it('should register a new user', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({
        username: 'testuser',
        email: 'test@example.com',
        password: 'password123'
      });
    
    expect(res.statusCode).toEqual(201);
    expect(res.body).toHaveProperty('token');
    expect(res.body.user).toHaveProperty('username', 'testuser');
  });
});
```

## Environment Variables

The application requires the following environment variables:

```
# Server
NODE_ENV=development
PORT=5000
JWT_SECRET=your_jwt_secret

# MongoDB
MONGO_URI=mongodb://mongo:27017/commonly

# PostgreSQL
PG_USER=postgres
PG_PASSWORD=postgres
PG_HOST=postgres
PG_PORT=5432
PG_DATABASE=commonly
PG_SSL_CA_PATH=/app/ca.pem

# Email
SENDGRID_API_KEY=your_sendgrid_api_key
SENDGRID_FROM_EMAIL=no-reply@commonly.com

# Frontend URL (for email links)
FRONTEND_URL=http://localhost:3000
```

## Development Guidelines

### API Design Principles

- Use RESTful conventions for endpoints
- Keep routes organized by resource
- Use appropriate HTTP status codes
- Include validation for all input data
- Implement proper error handling
- Use middleware for cross-cutting concerns

### Code Style

- Use async/await for asynchronous code
- Implement controller-service pattern
- Keep controllers focused on HTTP concerns
- Extract business logic to service modules
- Use meaningful variable and function names

### Security Best Practices

- Validate all user input
- Use parameterized queries
- Implement rate limiting
- Set secure HTTP headers
- Follow the principle of least privilege
- Keep dependencies updated

## Deployment

The backend is containerized using Docker and deployed as part of the overall application.

See the main [Deployment Guide](./DEPLOYMENT.md) for more details. 
