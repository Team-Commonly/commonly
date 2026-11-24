#!/usr/bin/env bash
set -e

echo "Starting Commonly Backend (dev)..."

if [ ! -d "/app/node_modules" ] \
    || [ -z "$(ls -A /app/node_modules 2>/dev/null)" ] \
    || [ ! -d "/app/node_modules/@google/generative-ai" ] \
    || [ ! -f "/app/node_modules/.bin/ts-node" ]; then
    echo "Installing backend dependencies (dev)..."
    # @openuidev/lang-core's postinstall sends install telemetry unless this is set.
    OPENUI_TELEMETRY_DISABLED=1 npm install --include=dev
else
    echo "Dependencies already present, skipping install"
fi

echo "Starting dev server..."
exec npm run dev
