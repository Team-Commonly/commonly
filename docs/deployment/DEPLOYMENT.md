# Deployment Guide

This document provides detailed instructions for deploying the Commonly application in various environments.

## Prerequisites

Before deploying the application, ensure you have the following:

1. **Docker and Docker Compose**:
   - Docker Engine 20.10.x or later
   - Docker Compose 2.0.x or later

2. **Environment Files**:
   - Production `.env` file with proper secrets (contact Sam for this file)
   - SSL certificates for production deployment

3. **Server Requirements**:
   - Minimum 2 CPU cores
   - 4GB RAM
   - 20GB disk space

4. **Discord Integration (Optional)**:
   - Discord application credentials (see [Discord App Setup](./DISCORD_APP_SETUP.md))
   - Bot token with proper permissions
   - Public interactions endpoint URL (for slash commands) reachable from Discord

## Local Development Deployment

### Step 1: Clone the Repository

```bash
git clone https://github.com/YOURUSERNAME/commonly.git
cd commonly
```

### Step 2: Set Up Environment Files

1. Create a `.env` file in the project root:

```
# Server
NODE_ENV=development
PORT=5000
JWT_SECRET=your_local_jwt_secret

# MongoDB
MONGO_URI=mongodb://mongo:27017/commonly

# PostgreSQL
PG_USER=postgres
PG_PASSWORD=postgres
PG_HOST=postgres
PG_PORT=5432
PG_DATABASE=commonly
PG_SSL_CA_PATH=/app/ca.pem

# Frontend
REACT_APP_API_URL=http://localhost:5000

# Email (optional for development)
SENDGRID_API_KEY=your_sendgrid_api_key
SENDGRID_FROM_EMAIL=no-reply@commonly.com
FRONTEND_URL=http://localhost:3000

# Discord Integration (optional)
DISCORD_CLIENT_ID=your_discord_client_id
DISCORD_BOT_TOKEN=your_discord_bot_token
DISCORD_PUBLIC_KEY=your_discord_public_key

# Telegram Integration (optional)
TELEGRAM_BOT_TOKEN=your_telegram_bot_token
TELEGRAM_SECRET_TOKEN=your_telegram_webhook_secret
```

2. Download the CA certificate (if using external PostgreSQL):

```bash
node download-ca.js
```

### Step 3: Build and Start the Containers

```bash
docker-compose build
docker-compose up -d
```

Note: In development, the backend container will install dependencies on first boot if
`/app/node_modules` is empty. This can make the initial startup take longer.

**Note:** If Discord credentials are provided, slash commands will be automatically registered during container startup.

### Step 4: Verify the Deployment

1. Access the frontend at: http://localhost:3000
2. Access the backend API at: http://localhost:5000
3. Check Discord integration health: http://localhost:5000/api/discord/health

## Production Deployment

### Step 1: Prepare the Production Server

1. Install Docker and Docker Compose:
   - [Docker Installation Guide](https://docs.docker.com/engine/install/)
   - [Docker Compose Installation Guide](https://docs.docker.com/compose/install/)

2. Clone the repository:
   ```bash
   git clone https://github.com/YOURUSERNAME/commonly.git
   cd commonly
   ```

### Step 2: Obtain Production Configuration

1. **Request the production .env file from Sam**, which will include:
   - Secure JWT secret
   - Production database URIs
   - API keys for external services
   - HTTPS configuration
   - Discord integration credentials (if applicable)

2. Place the `.env` file in the project root directory.

3. Download the CA certificate (if using external PostgreSQL):
   ```bash
   node download-ca.js
   ```

### Step 3: Configure HTTPS (Optional but Recommended)

1. Obtain SSL certificates:
   - Use Let's Encrypt for free certificates
   - Or use a commercial certificate provider

2. Create a `certs` directory and add your certificates:
   ```bash
   mkdir -p certs
   # Copy your certificate files to this directory
   ```

3. Update the Nginx configuration in `frontend/nginx.conf` to use SSL:
   ```
   server {
       listen 80;
       listen 443 ssl;
       server_name your-domain.com;

       ssl_certificate /etc/nginx/certs/fullchain.pem;
       ssl_certificate_key /etc/nginx/certs/privkey.pem;
       
       # ... rest of the configuration
   }
   ```

### Step 4: Build and Deploy

1. Build the production containers:
   ```bash
   docker-compose -f docker-compose.yml build
   ```

2. Start the application:
   ```bash
   docker-compose -f docker-compose.yml up -d
   ```

**Discord Integration:** Commands are automatically registered during startup if Discord credentials are provided.

### Discord Interactions Endpoint (Public URL)

If you configure a public Discord interactions endpoint (for slash commands), ensure the hostname routes to your backend:

- The endpoint must be reachable at `https://<host>/api/discord/interactions`.
- If you use Cloudflare Tunnel, **DNS alone is not enough** — add the hostname to the tunnel ingress and restart the tunnel.
- Discord verifies this URL by sending a signed request; if it cannot reach your backend, verification fails.

### Step 5: Verify the Deployment

1. Check the container status:
   ```bash
   docker-compose ps
   ```

2. Check the logs for any errors:
   ```bash
   docker-compose logs
   ```

3. Access the application using your domain name or server IP.

4. Verify Discord integration (if configured):
   ```bash
   curl http://your-domain.com/api/discord/health
   ```

## Discord Command Registration

The application includes automated Discord slash command registration that integrates with the deployment process.

### Automatic Registration

Commands are automatically registered when:
- The container starts (if Discord credentials are provided)
- A new Discord integration is created
- The application is deployed

### Manual Registration

If you need to manually register commands:

```bash
# Deploy commands for all integrations
npm run discord:deploy

# Verify registration status
npm run discord:verify

# Check health
curl http://localhost:5000/api/discord/health
```

### Health Monitoring

Monitor Discord integration health:

```bash
# Health check endpoint
GET /api/discord/health

# Expected response
{
  "status": "healthy",
  "integrations": [...],
  "summary": {
    "total": 1,
    "registered": 1,
    "failed": 0
  }
}
```

For detailed Discord deployment information, see [Discord Deployment Guide](./DISCORD_DEPLOYMENT.md).

## Continuous Deployment

The repository includes GitHub Actions workflows for continuous integration and deployment.

### GitHub Actions Workflows

1. **tests.yml**: Runs tests when changes are pushed
   - Uses Docker Compose to set up testing environment
   - Executes tests in the backend container
   
2. **lint.yml**: Checks code style and quality
   - Runs linting inside Docker containers
   - Lints both frontend and backend code
   
3. **coverage.yml**: Generates and reports test coverage
   - Runs tests with coverage enabled in Docker container
   - Uploads coverage reports as artifacts
   
4. **deploy.yml**: Deploys to production (configured for specific branches)

### GitHub Actions Configuration Notes

- All workflows use the `isbang/compose-action` to ensure Docker Compose is properly installed
- Tests and linting run in containers to ensure consistency across environments
- This approach eliminates "works on my machine" problems by using the same Docker setup in CI/CD as in development

### Setting Up GitHub Secrets

For the workflows to function properly, set up the following GitHub secrets:

1. `SSH_PRIVATE_KEY`: SSH key for the production server
2. `SSH_HOST`: Hostname of the production server
3. `SSH_USERNAME`: Username for SSH access
4. `DOCKER_USERNAME`: Docker Hub username (if using private Docker registry)
5. `DOCKER_PASSWORD`: Docker Hub password

## Scaling the Application

### Horizontal Scaling

For higher traffic loads, you can scale the application horizontally:

1. **Frontend Scaling**:
   ```bash
   docker-compose up -d --scale frontend=3
   ```

2. **Backend Scaling**:
   ```bash
   docker-compose up -d --scale backend=3
   ```

3. Add a load balancer like Nginx or Traefik to distribute traffic.

### Database Scaling

1. **MongoDB**:
   - Set up a MongoDB replica set for high availability
   - Consider MongoDB Atlas for managed MongoDB hosting

2. **PostgreSQL**:
   - Set up PostgreSQL replication
   - Consider managed PostgreSQL services like AWS RDS or Aiven

## Backup and Restore

### Database Backups

1. **MongoDB Backup**:
   ```bash
   docker exec mongodb mongodump --out /backup/mongodb_$(date +%Y-%m-%d)
   ```

2. **PostgreSQL Backup**:
   ```bash
   docker exec postgres pg_dump -U postgres commonly > postgres_backup_$(date +%Y-%m-%d).sql
   ```

### Application Data Backup

1. Back up uploaded files:
   ```bash
   docker cp backend:/app/uploads ./backups/uploads_$(date +%Y-%m-%d)
   ```

2. Back up environment variables:
   ```bash
   cp .env ./backups/.env_$(date +%Y-%m-%d)
   ```

## Monitoring and Logging

### Monitoring Stack

Consider adding a monitoring stack:

1. **Prometheus**: For metrics collection
2. **Grafana**: For visualization
3. **cAdvisor**: For container metrics

Example docker-compose addition:
```yaml
prometheus:
  image: prom/prometheus
  volumes:
    - ./prometheus.yml:/etc/prometheus/prometheus.yml
  ports:
    - "9090:9090"

grafana:
  image: grafana/grafana
  ports:
    - "3001:3000"
  depends_on:
    - prometheus
```

### Centralized Logging

Consider adding an ELK stack for centralized logging:

```yaml
elasticsearch:
  image: docker.elastic.co/elasticsearch/elasticsearch:7.14.0
  environment:
    - discovery.type=single-node
  ports:
    - "9200:9200"

kibana:
  image: docker.elastic.co/kibana/kibana:7.14.0
  ports:
    - "5601:5601"
  depends_on:
    - elasticsearch

logstash:
  image: docker.elastic.co/logstash/logstash:7.14.0
  depends_on:
    - elasticsearch
```

### Discord Integration Monitoring

Monitor Discord integration health:

```bash
# Set up health check monitoring
*/5 * * * * curl -f http://localhost:5000/api/discord/health || echo "Discord health check failed"

# Check logs for Discord-related issues
docker-compose logs backend | grep -i discord
```

## Troubleshooting

### Common Issues

1. **Container fails to start**:
   - Check logs: `docker-compose logs [service_name]`
   - Verify environment variables
   - Check for port conflicts

2. **Database connection issues**:
   - Verify database credentials in `.env`
   - Check if database containers are running
   - Verify network connectivity between containers

3. **Frontend not connecting to backend**:
   - Check REACT_APP_API_URL environment variable
   - Verify CORS configuration in backend
   - Check for network issues between containers

4. **Discord commands not appearing**:
   - Check Discord integration health: `curl http://localhost:5000/api/discord/health`
   - Verify bot permissions in Discord Developer Portal
   - Check container logs for Discord registration errors
   - Manually register commands: `npm run discord:deploy`

### Getting Support

For deployment issues or questions:

1. Open an issue on the GitHub repository
2. Contact Sam for production environment files or credentials
3. Refer to the documentation in the `docs` directory 
4. Check Discord integration status and logs 
