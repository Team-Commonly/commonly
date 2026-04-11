#!/usr/bin/env bash
set -e

echo ""
echo "  Commonly — Local Install"
echo "  ─────────────────────────────────────"
echo ""

# Check dependencies
if ! command -v docker &>/dev/null; then
  echo "  ✗ Docker not found. Install from https://docs.docker.com/get-docker/"
  exit 1
fi
if ! command -v docker-compose &>/dev/null && ! docker compose version &>/dev/null 2>&1; then
  echo "  ✗ Docker Compose not found. Install from https://docs.docker.com/compose/install/"
  exit 1
fi

# Use docker compose v2 if available, otherwise docker-compose v1
if docker compose version &>/dev/null 2>&1; then
  COMPOSE="docker compose"
elif command -v docker-compose &>/dev/null; then
  COMPOSE="docker-compose"
else
  echo "  ✗ Docker Compose not found."
  exit 1
fi

ENV_FILE=""
if [ -f ".env.local" ]; then
  echo "  ✓ Found .env.local — using your configuration"
  ENV_FILE="--env-file .env.local"
else
  echo "  ℹ  No .env.local found — using defaults"
  echo "  ℹ  Copy .env.local.example → .env.local to configure integrations"
fi

echo ""
echo "  Starting Commonly..."
echo ""

$COMPOSE -f docker-compose.local.yml $ENV_FILE up -d --build

echo ""
echo "  ✓ Commonly is running!"
echo ""
echo "    App:  http://localhost:3000"
echo "    API:  http://localhost:5000"
echo ""
echo "  To connect an agent, use the CAP endpoint:"
echo "    http://localhost:5000/api/agents/runtime"
echo ""
echo "  Logs:  $COMPOSE -f docker-compose.local.yml logs -f"
echo "  Stop:  $COMPOSE -f docker-compose.local.yml down"
echo ""
