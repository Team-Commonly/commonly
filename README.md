# Commonly

[![Node.js Tests](https://github.com/YOURUSERNAME/commonly/actions/workflows/tests.yml/badge.svg)](https://github.com/YOURUSERNAME/commonly/actions/workflows/tests.yml)
[![Lint Code](https://github.com/YOURUSERNAME/commonly/actions/workflows/lint.yml/badge.svg)](https://github.com/YOURUSERNAME/commonly/actions/workflows/lint.yml)
[![Test Coverage](https://github.com/YOURUSERNAME/commonly/actions/workflows/coverage.yml/badge.svg)](https://github.com/YOURUSERNAME/commonly/actions/workflows/coverage.yml)

A social platform for connecting with friends and communities. Driven by your AI common friend.

## Setup and Installation

### Prerequisites

1. **Install Docker and Docker Compose**
   - For Windows: [Docker Desktop for Windows](https://docs.docker.com/desktop/install/windows-install/)
   - For Mac: [Docker Desktop for Mac](https://docs.docker.com/desktop/install/mac-install/)
   - For Linux: [Docker Engine](https://docs.docker.com/engine/install/) and [Docker Compose](https://docs.docker.com/compose/install/)

### Development Setup

1. Clone the repository:
   ```
   git clone https://github.com/YOURUSERNAME/commonly.git
   cd commonly
   ```

2. Download the CA certificate for PostgreSQL:
   ```
   node download-ca.js
   ```
   This will download the CA certificate from Aiven and save it as `ca.pem` in the root directory.

3. Create a `.env` file in the root directory based on `.env.example`.
   - For development, you can use the example values
   - **For production environment variables, please contact Sam**

4. Build and start the application:
   ```
   docker-compose build
   docker-compose up -d
   ```

5. Access the application:
   - Frontend: `http://localhost:3000`
   - Backend API: `http://localhost:5000`

### Production Deployment

For production deployment:

1. Ensure you have the production `.env` file (contact Sam for this file)
2. Build and start the containers:
   ```
   docker-compose -f docker-compose.yml build
   docker-compose -f docker-compose.yml up -d
   ```

## Running Tests

To run tests in the Docker container:

```
docker exec -e NODE_ENV=test -e JWT_SECRET=test-jwt-secret backend npm test
```

## Features

- **Dual Database Architecture**: 
  - MongoDB: Handles posts, user profiles, and general application data
  - PostgreSQL: Specifically manages chat functionality (pods and messages)
- **Real-time Chat**: Communicate with friends and communities in real-time using Socket.io.
- **User Authentication**: Secure user authentication using JWT.
- **Community Pods**: Create and join different types of community pods (Chat, Study, Games).

## Documentation

For more detailed information about the project, please refer to the following documentation:

- [Architecture Overview](./docs/ARCHITECTURE.md) - Overall system design and components
- [Frontend Documentation](./docs/FRONTEND.md) - React application structure and components
- [Backend Documentation](./docs/BACKEND.md) - API endpoints and server structure
- [Database Schema](./docs/DATABASE.md) - MongoDB and PostgreSQL schema details
- [Deployment Guide](./docs/DEPLOYMENT.md) - Detailed deployment instructions
- [Linting Policy](./docs/LINTING.md) - Code style guidelines and auto-fix setup

## Database Architecture

The application uses a dual database architecture:

- **MongoDB**: Primary database for user accounts, posts, and general application data
- **PostgreSQL**: Specialized database for chat functionality (pods and messages)

This separation allows for:
- Optimized performance for different data types
- Flexibility in scaling each database independently
- Ability to leverage the strengths of each database system

## PostgreSQL Configuration (for Chat)

To enable PostgreSQL for chat functionality:

1. Ensure you have the CA certificate (`ca.pem`) in the root directory.
2. Configure the PostgreSQL connection in the `.env` file:
   ```
   PG_USER=your_pg_user
   PG_PASSWORD=your_pg_password
   PG_HOST=your_pg_host
   PG_PORT=your_pg_port
   PG_DATABASE=your_pg_database
   PG_SSL_CA_PATH=/app/ca.pem
   ```
3. The application will automatically detect and use PostgreSQL for chat if configured.
4. If PostgreSQL is not available, the application will fall back to MongoDB for all functionality.

## Development

- **Backend**: Node.js, Express
- **Databases**: MongoDB (posts, users), PostgreSQL (chat)
- **Frontend**: React, Material-UI
- **Real-time Communication**: Socket.io