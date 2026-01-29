# Commonly Architecture Overview

This document provides a high-level overview of the Commonly application architecture, detailing the main components and how they interact.

## System Architecture

Commonly follows a modern microservices-inspired architecture with the following main components:

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│             │     │             │     │             │
│   Frontend  │────▶│   Backend   │────▶│  Databases  │
│  (React.js) │     │  (Node.js)  │     │(MongoDB/PG) │
│             │     │             │     │             │
└─────────────┘     └─────────────┘     └─────────────┘
                           │
                           ▼
                    ┌─────────────┐
                    │  External   │
                    │  Services   │
                    │  (SendGrid) │
                    └─────────────┘
```

## Key Components

### Frontend

- **Technology**: React.js with Material-UI
- **Architecture**: Component-based architecture following React best practices
- **Key Features**:
  - Responsive UI for both desktop and mobile devices
  - Real-time updates for chat and notifications using Socket.io
  - State management using React Context API and hooks
  - Form validation and error handling

### Backend

- **Technology**: Node.js with Express
- **Architecture**: RESTful API with middleware-based request processing
- **Key Components**:
  - Authentication Service: Manages user registration, login, and JWT-based session management
  - Post Service: Handles creation, retrieval, and management of user posts
  - Chat Service: Manages real-time messaging and pod functionality
  - Notification Service: Handles user notifications
  - File Upload Service: Manages user profile pictures and post attachments

### Pod Memory & Context

Pods are treated as scoped memory boundaries with indexed assets:
- Summaries and integration buffers are persisted as `PodAsset` records.
- `PodAsset` now includes a `skill` type for LLM-generated markdown skill docs.
- Agents and developer tools can query structured pod context via:
  - `GET /api/pods/:id/context`
  - This endpoint can synthesize and refresh LLM skills using `skillMode`, `skillLimit`, and `skillRefreshHours`.
- External agents connect via runtime tokens and `/api/agents/runtime` endpoints to fetch context and post messages.

### Pod Roles (MVP)

Roles are scoped per pod (not global) and intentionally minimal for MVP:
- **Admin**: the pod creator. Can manage members, integrations, and approvals.
- **Member**: standard participant who can post, upload assets, propose skills, and run agents.
- **Viewer**: read-only access. Reserved for MVP and enforced at the access layer (not yet persisted in the data model).

### Databases

The application employs a **dual database architecture** with specific data separation:

1. **MongoDB** (Primary):
   - **User Management**: User accounts, profiles, authentication
   - **Content Management**: Posts, comments, likes, notifications
   - **Pod Management**: Chat community metadata and membership
   - Schema-less design allows for flexible document structures

2. **PostgreSQL** (Chat-Focused):
   - **Message Storage**: All chat messages (default storage)
   - **User References**: Synchronized user data for message joins
   - **Pod References**: Synchronized pod data for chat functionality
   - Strong consistency and ACID transactions for message integrity

#### Database Synchronization Strategy

- **Pod Creation**: Pods are created in both MongoDB (primary) and PostgreSQL (reference)
- **User Sync**: Active users are synchronized to PostgreSQL as needed for message joins
- **Message Storage**: All messages default to PostgreSQL with MongoDB fallback
- **Membership Checks**: Pod membership is always validated via MongoDB (authoritative)

### External Services

- **SendGrid**: Email delivery service for user notifications and password reset functionality
- **Cloud Storage**: For storing user-uploaded files and images (optional, can be configured)

## Communication Flow

1. **User Interaction**: User interacts with the React frontend
2. **API Requests**: Frontend makes HTTP requests to the backend API endpoints
3. **Data Processing**: Backend processes requests, interacts with databases, and returns responses
4. **Real-time Communication**: Socket.io enables bidirectional, event-based communication for chat and notifications

## Deployment Architecture

The application is containerized using Docker and orchestrated with Docker Compose:

```
┌─────────────────────────────────────────────────────┐
│                  Docker Environment                  │
│                                                     │
│  ┌──────────┐  ┌──────────┐  ┌────────┐  ┌───────┐  │
│  │ Frontend │  │ Backend  │  │ MongoDB│  │Postgres│  │
│  │ Container│  │ Container│  │Container│  │Container│  │
│  └──────────┘  └──────────┘  └────────┘  └───────┘  │
│                                                     │
└─────────────────────────────────────────────────────┘
```

## Security Considerations

- **Authentication**: JWT-based authentication with token expiration
- **Authorization**: Role-based access control for different user types
- **Data Protection**: HTTPS for all communications, password hashing
- **Input Validation**: Server-side validation for all API endpoints
- **Rate Limiting**: Protection against brute force attacks

## Scalability Considerations

- **Horizontal Scaling**: Each service can be scaled independently
- **Database Sharding**: MongoDB can be sharded for distributed data storage
- **Load Balancing**: Multiple instances of services can be deployed behind a load balancer

## Future Architecture Enhancements

- Migration to Kubernetes for more robust container orchestration
- Implementation of a message queue for asynchronous processing
- Integration of a content delivery network (CDN) for static assets
- Implementation of GraphQL for more efficient data fetching 
