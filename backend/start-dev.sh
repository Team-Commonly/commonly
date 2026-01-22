#!/usr/bin/env bash
set -e

echo "Starting Commonly Backend (dev)..."

if [ ! -d "/app/node_modules" ] \
    || [ -z "$(ls -A /app/node_modules 2>/dev/null)" ] \
    || [ ! -d "/app/node_modules/@google/generative-ai" ]; then
    echo "Installing backend dependencies (dev)..."
    npm install --include=dev
else
    echo "Dependencies already present, skipping install"
fi

echo "Starting dev server..."
exec npm run dev
