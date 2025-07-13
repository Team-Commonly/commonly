# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

### Docker Setup
- `docker-compose build` - Build all containers
- `docker-compose up -d` - Start all services in detached mode
- `docker-compose down` - Stop all services

### Testing
- `docker exec -e NODE_ENV=test -e JWT_SECRET=test-jwt-secret backend npm test` - Run backend tests in Docker
- `cd backend && npm test` - Run backend tests locally
- `cd backend && npm run test:watch` - Run backend tests in watch mode
- `cd backend && npm run test:coverage` - Run backend tests with coverage
- `cd frontend && npm test` - Run frontend tests
- `cd frontend && npm run test:coverage` - Run frontend tests with coverage

### Linting
- `npm run lint` - Lint both frontend and backend
- `npm run lint:fix` - Auto-fix linting issues in both
- `cd backend && npm run lint:fix` - Fix backend linting only
- `cd frontend && npm run lint:fix` - Fix frontend linting only

### Discord Commands
- `cd backend && npm run discord:deploy` - Deploy Discord slash commands
- `cd backend && npm run discord:register` - Register Discord commands
- `cd backend && npm run discord:list` - List Discord commands

### Development
- `cd backend && npm run dev` - Start backend with nodemon
- `cd frontend && npm start` - Start frontend dev server
- `node download-ca.js` - Download PostgreSQL CA certificate

## Architecture Overview

### Dual Database System
- **MongoDB**: Primary database for users, posts, general app data
- **PostgreSQL**: Specialized for chat functionality (pods and messages)
- Both databases are required for full functionality

### Service Structure
- **Frontend**: React.js with Material-UI on port 3000
- **Backend**: Node.js/Express API on port 5000  
- **Real-time**: Socket.io for chat and live updates

### Key Backend Services
- `services/discordService.js` - Discord bot integration
- `services/summarizerService.js` - AI-powered content summarization using Gemini
- `services/schedulerService.js` - Background tasks and periodic jobs
- `services/integrationService.js` - Third-party service management

### Database Models
- **MongoDB models**: `models/User.js`, `models/Post.js`, `models/Pod.js`
- **PostgreSQL models**: `models/pg/Pod.js`, `models/pg/Message.js`
- **Discord models**: `models/DiscordIntegration.js`, `models/DiscordMessageBuffer.js`

### Route Structure
- `/api/auth` - User authentication
- `/api/pods` - Chat pod management (dual DB)
- `/api/messages` - Message handling (dual DB)
- `/api/discord` - Discord integration endpoints
- `/api/integrations` - Third-party service management

### Environment Variables
Key required variables:
- `MONGO_URI` - MongoDB connection
- `PG_*` variables - PostgreSQL connection details
- `JWT_SECRET` - Authentication secret
- `DISCORD_BOT_TOKEN` - Discord bot integration
- `GEMINI_API_KEY` - AI summarization service

### Testing Strategy
- Backend uses Jest with MongoDB Memory Server and pg-mem for isolated testing
- Frontend uses React Testing Library
- Integration tests cover dual database scenarios
- Discord functionality has dedicated test files

### Discord Integration
- Full Discord bot with slash commands
- Message bridging between Discord and app chat
- Command registration via scripts in `backend/scripts/`
- Interaction handling in `services/discordCommandService.js`