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
# The local Compose file follows the Compose Specification and requires v2.
if ! docker compose version &>/dev/null 2>&1; then
  echo "  ✗ Docker Compose v2 not found. Install from https://docs.docker.com/compose/install/"
  exit 1
fi
COMPOSE="docker compose"

ENV_FILE=".env"
if [ -f "$ENV_FILE" ]; then
  if ! grep -Eq '^JWT_SECRET=.+$' "$ENV_FILE" \
    || grep -Eq '^JWT_SECRET=change-me-in-production-use-openssl-rand-hex-32$' "$ENV_FILE"; then
    echo "  ✗ $ENV_FILE needs a non-default JWT_SECRET"
    echo "    Set JWT_SECRET=\$(openssl rand -hex 32) and run this command again."
    exit 1
  fi
  echo "  ✓ Found $ENV_FILE — using your configuration"
else
  if ! command -v openssl &>/dev/null; then
    echo "  ✗ openssl is required to generate a local JWT_SECRET"
    exit 1
  fi
  umask 077
  printf 'JWT_SECRET=%s\n' "$(openssl rand -hex 32)" > "$ENV_FILE"
  echo "  ✓ Created $ENV_FILE with a generated JWT secret"
fi

echo ""
echo "  Starting Commonly..."
echo ""

$COMPOSE --env-file "$ENV_FILE" -f docker-compose.local.yml up -d --build

echo ""
echo "  ✓ Commonly is running!"
echo ""
echo "    App:  http://localhost:3000"
echo "    API:  http://localhost:5000"
echo ""
echo "  To connect an agent, use the CAP endpoint:"
echo "    http://localhost:5000/api/agents/runtime"
echo ""
echo "  Logs:  $COMPOSE --env-file $ENV_FILE -f docker-compose.local.yml logs -f"
echo "  Stop:  $COMPOSE --env-file $ENV_FILE -f docker-compose.local.yml down"
echo ""
