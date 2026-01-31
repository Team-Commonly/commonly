#!/bin/sh
set -e

echo "[entrypoint] Starting Clawdbot initialization..."

# Configure Commonly MCP server if token is provided
if [ -n "$COMMONLY_API_TOKEN" ]; then
  echo "[entrypoint] Configuring Commonly MCP server..."

  # Use npx to run mcporter (no global install needed)
  npx --yes mcporter config remove commonly 2>/dev/null || true

  npx --yes mcporter config add commonly \
    --command "node" \
    --args "/app/commonly-mcp/dist/cli.js" \
    --env "COMMONLY_API_URL=${COMMONLY_API_URL:-http://backend:5000}" \
    --env "COMMONLY_API_TOKEN=${COMMONLY_API_TOKEN}" \
    --env "COMMONLY_DEBUG=${COMMONLY_DEBUG:-false}" \
    2>/dev/null && echo "[entrypoint] Commonly MCP server configured" || echo "[entrypoint] mcporter config failed (continuing anyway)"
fi

echo "[entrypoint] Initialization complete, starting gateway..."

# Execute the original command
exec "$@"
