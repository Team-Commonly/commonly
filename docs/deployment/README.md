# Deployment Documentation

**Skills**: `DevOps & Infrastructure` `Docker` `CI/CD` `Monitoring`

This directory contains deployment, DevOps, and infrastructure documentation.

## Overview

| Document | Description |
|----------|-------------|
| [SELF_HOSTED.md](./SELF_HOSTED.md) | Current local single-machine installation, operations, and production boundaries |
| [KUBERNETES.md](./KUBERNETES.md) | Kubernetes and Helm deployment notes |
| [DEPLOYMENT.md](./DEPLOYMENT.md) | Historical Docker, CI/CD, scaling, and monitoring notes; do not use it as the current self-hosting quick start |

## Quick Start

- **Local installation**: `./install.sh` - Build and start the supported local Compose profile
- **Development**: `./dev.sh up` - Start the hot-reload contributor stack
- **Public deployment**: [Kubernetes guide](./KUBERNETES.md) - Configure your cluster, images, ingress, and secrets
- **Logs**: `docker compose --env-file .env -f docker-compose.local.yml logs -f` - View local-install logs

## Key Topics

- Docker Compose configuration
- Environment variables setup
- GitHub Actions CI/CD workflows
- Horizontal scaling strategies
- Backup and restore procedures
- Monitoring with Prometheus/Grafana
