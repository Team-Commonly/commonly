#!/usr/bin/env bash
set -euo pipefail
suite="$1"
test_path="$2"
integration="$3"
# Only git-listed source arrives on stdin. No host node_modules, cache or .git.
tar -C /source --null --files-from=- -cf - | tar -C /work -xf -
cd /work
export CI=true NODE_ENV=test HUSKY=0 JWT_SECRET=test-jwt-secret
export SENDGRID_API_KEY=fake-api-key SENDGRID_FROM_EMAIL=test@example.com
export FRONTEND_URL=http://localhost:3000
npm ci --include=dev --no-audit --no-fund
# Subprocess CLI tests import backend TS and the real MCP handler.
npm ci --prefix backend --include=dev --no-audit --no-fund
npm ci --prefix cli --include=dev --no-audit --no-fund
if [[ "$suite" == cli ]]; then
  npm ci --prefix commonly-mcp --include=dev --no-audit --no-fund
fi
if [[ "$suite" == frontend ]]; then
  npm ci --prefix frontend --include=dev --legacy-peer-deps --no-audit --no-fund
fi
if [[ "$integration" == true ]]; then
  export INTEGRATION_TEST=true MONGO_URI=mongodb://mongo:27017/commonly-test
  export PG_HOST=postgres PG_PORT=5432 PG_DATABASE=commonly-test PG_USER=postgres PG_PASSWORD=postgres PG_SSL_ENABLED=false
fi
cd "/work/$suite"
args=(--runInBand --forceExit --cacheDirectory=/tmp/jest-cache)
if [[ -n "$test_path" ]]; then args+=(--runTestsByPath "$test_path");
elif [[ "$integration" == true ]]; then args+=(--testPathPattern=__tests__/service); fi
if [[ "$suite" == cli ]]; then
  exec node --experimental-vm-modules node_modules/jest/bin/jest.js "${args[@]}"
fi
if [[ "$suite" == frontend ]]; then args+=(--watchAll=false); fi
node node_modules/jest/bin/jest.js "${args[@]}"
if [[ "$suite" == frontend && -z "$test_path" ]]; then
  exec node --test scripts/generate-seo-pages.test.mjs scripts/nginx-routing.test.mjs
fi
