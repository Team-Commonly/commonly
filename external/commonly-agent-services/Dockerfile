FROM node:20-alpine

# The runtime only runs `node`; npm (and its bundled tar, CVE-2026-59873) and
# corepack never execute here, so drop them instead of shipping their CVEs.
RUN apk upgrade --no-cache \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
    /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack

WORKDIR /app

COPY commonly-bot ./commonly-bot
COPY shared ./shared

CMD ["node", "/app/commonly-bot/index.js"]
