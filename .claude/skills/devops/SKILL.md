---
name: devops
description: DevOps and infrastructure context for Docker, CI/CD, GitHub Actions, deployment, and monitoring. Use when working on containers, pipelines, or deployment.
---

# DevOps & Infrastructure

**Technologies**: Docker, Docker Compose, GitHub Actions, Nginx, Prometheus

## Required Knowledge
- Docker containerization and multi-stage builds
- Docker Compose orchestration
- CI/CD pipeline design (GitHub Actions)
- Nginx configuration
- Environment variable management
- Monitoring and logging

## Relevant Documentation

| Document | Topics Covered |
|----------|----------------|
| [DEPLOYMENT.md](../../../docs/deployment/DEPLOYMENT.md) | Docker setup, CI/CD, scaling, monitoring |
| [ARCHITECTURE.md](../../../docs/architecture/ARCHITECTURE.md) | Container architecture |
| [LINTING.md](../../../docs/development/LINTING.md) | Code quality automation |

## Infrastructure Components

```
docker-compose.yml          # Production configuration
docker-compose.dev.yml      # Development with hot reload
.github/workflows/
├── tests.yml               # Automated testing
├── lint.yml                # Code quality checks
├── coverage.yml            # Test coverage reports
└── deploy.yml              # Production deployment
```

## Key Commands

```bash
# Development
./dev.sh up                 # Start dev environment
./dev.sh logs backend       # View backend logs
./dev.sh test               # Run tests

# Production
./prod.sh deploy            # Build and deploy
./prod.sh logs              # View logs

# Clawdbot (AI Agent Runtime)
./dev.sh clawdbot up        # Start Clawdbot services (gateway, cli, bridge)
./dev.sh clawdbot down      # Stop Clawdbot services
./dev.sh clawdbot logs      # View Clawdbot bridge logs
./dev.sh clawdbot restart   # Restart Clawdbot services
./dev.sh clawdbot build     # Rebuild Clawdbot image
```

## Clawdbot Configuration

The Clawdbot gateway uses Claude Code OAuth by default (mounts `~/.claude` credentials).

**Key files:**
- `external/clawdbot-state/config/moltbot.json` - Gateway configuration
- `_external/clawdbot/Dockerfile.claude` - Custom image with Claude Code CLI

**To use API keys instead of OAuth:**
```bash
CLAWDBOT_DOCKERFILE=Dockerfile ./dev.sh clawdbot up
```

**Dashboard access:**
Open `http://127.0.0.1:18789/?token=YOUR_GATEWAY_TOKEN`

## Docker Patterns

### Multi-stage Build
```dockerfile
# Build stage
FROM node:18-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# Production stage
FROM node:18-alpine
COPY --from=builder /app/dist ./dist
CMD ["node", "dist/index.js"]
```

### Health Checks
```yaml
healthcheck:
  test: ["CMD", "curl", "-f", "http://localhost:5000/health"]
  interval: 30s
  timeout: 10s
  retries: 3
```
