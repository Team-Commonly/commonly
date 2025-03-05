# Commonly

A social platform for connecting with friends and communities. Driven by your AI common friend.

## Setup

1. Clone the repository.
2. Download the CA certificate for PostgreSQL:
   ```
   node download-ca.js
   ```
   This will download the CA certificate from Aiven and save it as `ca.pem` in the root directory.
3. Create a `.env` file in the root directory based on `.env.example`.
4. Run `docker-compose up --build` to start the application.
5. Access the frontend at `http://localhost:3000` and the backend at `http://localhost:5000`.

## Features

- **Dual Database Architecture**: 
  - MongoDB: Handles posts, user profiles, and general application data
  - PostgreSQL: Specifically manages chat functionality (pods and messages)
- **Real-time Chat**: Communicate with friends and communities in real-time using Socket.io.
- **User Authentication**: Secure user authentication using JWT.
- **Community Pods**: Create and join different types of community pods (Chat, Study, Games).

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