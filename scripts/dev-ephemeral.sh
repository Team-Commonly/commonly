#!/bin/bash

# ./dev.sh up --ephemeral and ./dev.sh gc (D177, TASK-619).
# One native backend and one vite-preview frontend per worktree, on that
# worktree's slot ports, with its own Mongo and Postgres database. The shared
# compose pair (mongo, postgres) is reused by every slot.
#
#   scripts/dev-ephemeral.sh up   - claim (or reuse) this worktree's slot and start it
#   scripts/dev-ephemeral.sh gc   - stop and drop slots past their 24 h TTL

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
COMPOSE=(docker compose -f "$ROOT/docker-compose.dev.yml")
DEV_DIR="${COMMONLY_DEV_DIR:-$HOME/.commonly/dev}"
LOCK_DIR="$DEV_DIR/registry.lock"
SLOTS_MJS="$ROOT/scripts/dev-slots.mjs"
MONGO_CREDS="commonly:commonly_dev"
PG_CREDS="postgres:postgres"

# Node 20 matches CI. Use the Homebrew keg when it exists; otherwise fall back to PATH.
node20_bin() {
  local prefix
  prefix="$(brew --prefix node@20 2>/dev/null || true)"
  if [ -n "$prefix" ] && [ -x "$prefix/bin/node" ]; then
    echo "$prefix/bin"
  fi
}

lock_acquire() {
  mkdir -p "$DEV_DIR"
  local tries=0
  until mkdir "$LOCK_DIR" 2>/dev/null; do
    tries=$((tries + 1))
    if [ "$tries" -gt 150 ]; then
      echo "registry lock is held: $LOCK_DIR (remove it only if no ./dev.sh is running)" >&2
      exit 1
    fi
    sleep 0.2
  done
  trap 'rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT
}

lock_release() {
  rmdir "$LOCK_DIR" 2>/dev/null || true
  trap - EXIT
}

require_docker() {
  if ! docker info >/dev/null 2>&1; then
    echo "Docker is not running. The ephemeral slot needs the shared mongo and postgres containers." >&2
    exit 1
  fi
}

wait_port() {
  local port="$1" label="$2" tries=0
  until nc -z 127.0.0.1 "$port" 2>/dev/null; do
    tries=$((tries + 1))
    if [ "$tries" -gt 150 ]; then
      echo "$label did not open port $port within 30s" >&2
      exit 1
    fi
    sleep 0.2
  done
}

wait_http() {
  local url="$1" label="$2" log="$3" tries=0
  until curl -fsS "$url" >/dev/null 2>&1; do
    tries=$((tries + 1))
    if [ "$tries" -gt 300 ]; then
      echo "$label did not answer $url within 60s. Last log lines:" >&2
      tail -n 20 "$log" >&2 || true
      exit 1
    fi
    sleep 0.2
  done
}

ensure_pg_database() {
  local name="$1"
  if ! "${COMPOSE[@]}" exec -T postgres psql -U postgres -tAc "SELECT 1 FROM pg_database WHERE datname='$name'" | grep -q 1; then
    "${COMPOSE[@]}" exec -T postgres psql -U postgres -qc "CREATE DATABASE \"$name\""
  fi
}

# Stops the processes this slot recorded, but only if the PID still belongs to a slot server.
# A PID the OS has since reused is left alone.
stop_pid() {
  local pid="$1" pattern="$2"
  [ -n "$pid" ] && [ "$pid" != "null" ] || return 0
  if kill -0 "$pid" 2>/dev/null && ps -o command= -p "$pid" | grep -q "$pattern"; then
    kill "$pid" 2>/dev/null || true
  fi
}

up_ephemeral() {
  require_docker
  local node_bin
  node_bin="$(node20_bin)"
  if [ -n "$node_bin" ]; then
    export PATH="$node_bin:$PATH"
  else
    echo "⚠️  node@20 not found under Homebrew; using $(node -v). CI runs Node 20." >&2
  fi

  lock_acquire
  local slug assignments
  slug="$(basename "$ROOT" | tr -cs 'a-zA-Z0-9' '_' | tr 'A-Z' 'a-z' | cut -c1-24)"
  assignments="$(node "$SLOTS_MJS" claim "$ROOT" "$slug")"
  eval "$assignments"
  lock_release

  echo "🧩 Slot $SLOT_N: backend :$BACKEND_PORT, frontend :$FRONTEND_PORT, database $DB_NAME"
  mkdir -p "$SLOT_DIR"

  "${COMPOSE[@]}" up -d mongo postgres >/dev/null
  wait_port 27017 mongo
  wait_port 5432 postgres
  ensure_pg_database "$DB_NAME"

  echo "🔨 Building backend (Node $(node -v))..."
  (cd "$ROOT/backend" && npm run build >"$SLOT_DIR/build-backend.log" 2>&1) || {
    echo "backend build failed; see $SLOT_DIR/build-backend.log" >&2
    tail -n 20 "$SLOT_DIR/build-backend.log" >&2
    exit 1
  }

  # Start the server with the slot's own connection settings. RUN_WORKER=0 keeps the
  # scheduler out of a local walk, and LOCAL_DEV_LOGIN_ENABLED exposes the fixed dev login.
  (cd "$ROOT/backend" && env \
    PORT="$BACKEND_PORT" \
    MONGO_URI="mongodb://$MONGO_CREDS@127.0.0.1:27017/$DB_NAME?authSource=admin" \
    PG_HOST=127.0.0.1 PG_PORT=5432 PG_USER=postgres PG_PASSWORD=postgres PG_DATABASE="$DB_NAME" \
    RUN_WORKER=0 LOCAL_DEV_LOGIN_ENABLED=true \
    NODE_OPTIONS="--max-old-space-size=768" \
    nohup node dist/server.js >"$SLOT_DIR/backend.log" 2>&1 & echo $! >"$SLOT_DIR/backend.pid")
  local backend_pid
  backend_pid="$(cat "$SLOT_DIR/backend.pid")"
  wait_http "http://127.0.0.1:$BACKEND_PORT/api/health/live" backend "$SLOT_DIR/backend.log"

  echo "🔨 Building frontend..."
  (cd "$ROOT/frontend" && REACT_APP_API_URL="http://127.0.0.1:$BACKEND_PORT" \
    ./node_modules/.bin/vite build --outDir "$SLOT_DIR/web" --emptyOutDir >"$SLOT_DIR/build-frontend.log" 2>&1) || {
    echo "frontend build failed; see $SLOT_DIR/build-frontend.log" >&2
    tail -n 20 "$SLOT_DIR/build-frontend.log" >&2
    exit 1
  }
  (cd "$ROOT/frontend" && nohup ./node_modules/.bin/vite preview --outDir "$SLOT_DIR/web" \
    --host 127.0.0.1 --port "$FRONTEND_PORT" --strictPort >"$SLOT_DIR/preview.log" 2>&1 & echo $! >"$SLOT_DIR/frontend.pid")
  local frontend_pid
  frontend_pid="$(cat "$SLOT_DIR/frontend.pid")"
  wait_http "http://127.0.0.1:$FRONTEND_PORT/" frontend "$SLOT_DIR/preview.log"

  lock_acquire
  node "$SLOTS_MJS" set-pids "$SLOT_N" "$backend_pid" "$frontend_pid"
  lock_release

  local rss
  rss="$(ps -o rss= -p "$backend_pid","$frontend_pid" | awk '{s+=$1} END {printf "%.0f", s/1024}')"
  echo "✅ Slot $SLOT_N is up: frontend http://127.0.0.1:$FRONTEND_PORT  backend http://127.0.0.1:$BACKEND_PORT"
  echo "   RSS of backend + preview: ${rss} MB (excludes Docker VM)"
  echo "   Stop it with: ./dev.sh gc (expires after 24 h; logs in $SLOT_DIR)"
}

gc_ephemeral() {
  lock_acquire
  local line
  node "$SLOTS_MJS" expired | while IFS= read -r line; do
    [ -n "$line" ] || continue
    local n db backend frontend dir
    n="$(node -pe 'JSON.parse(process.argv[1]).n' "$line")"
    db="$(node -pe 'JSON.parse(process.argv[1]).dbName' "$line")"
    backend="$(node -pe 'JSON.parse(process.argv[1]).pids?.backend ?? ""' "$line")"
    frontend="$(node -pe 'JSON.parse(process.argv[1]).pids?.frontend ?? ""' "$line")"
    dir="$DEV_DIR/slot-$n"
    echo "🧹 Reaping slot $n ($db)"
    stop_pid "$backend" "dist/server.js"
    stop_pid "$frontend" "vite"
    if docker info >/dev/null 2>&1; then
      "${COMPOSE[@]}" exec -T postgres psql -U postgres -qc "DROP DATABASE IF EXISTS \"$db\"" 2>/dev/null \
        || echo "   could not drop Postgres database $db" >&2
      "${COMPOSE[@]}" exec -T mongo mongosh --quiet -u commonly -p commonly_dev \
        --authenticationDatabase admin "$db" --eval 'db.dropDatabase()' >/dev/null 2>&1 \
        || echo "   could not drop Mongo database $db (mongosh missing or auth failed)" >&2
    fi
    rm -rf "$dir"
    node "$SLOTS_MJS" drop "$n"
  done
  lock_release
  echo "✅ gc done"
}

case "${1:-}" in
  up) up_ephemeral ;;
  gc) gc_ephemeral ;;
  *)
    echo "usage: scripts/dev-ephemeral.sh up|gc" >&2
    exit 2
    ;;
esac
