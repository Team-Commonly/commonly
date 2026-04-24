#!/usr/bin/env bash
set -e

echo "Starting Commonly Frontend (dev)..."

if [ ! -d "/app/node_modules" ] \
    || [ -z "$(ls -A /app/node_modules 2>/dev/null)" ] \
    || [ ! -d "/app/node_modules/react" ] \
    || [ ! -f "/app/node_modules/.bin/vite" ] \
    || [ ! -f "/app/node_modules/.bin/jest" ] \
    || [ ! -f "/app/node_modules/.bin/eslint" ]; then
    echo "Installing frontend dependencies (dev)..."
    npm ci --only=production=false --prefer-offline --no-audit
else
    echo "Dependencies already present, skipping install"
fi

echo "Starting dev server..."
exec npm start
