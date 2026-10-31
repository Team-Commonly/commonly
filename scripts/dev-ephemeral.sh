#!/bin/bash

# ./dev.sh up --ephemeral and ./dev.sh gc (D177, TASK-619).
# One native backend and one vite-preview frontend per worktree, on that
# worktree's slot ports. Each slot also gets its own Mongo and Postgres
# containers on their own volumes, so no slot touches the shared compose
# services and gc can remove a slot's data by removing its containers.
#
#   scripts/dev-ephemeral.sh up   - claim (or reuse) this worktree's slot and start it
#   scripts/dev-ephemeral.sh gc   - stop and remove slots past their 24 h TTL

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEV_DIR="${COMMONLY_DEV_DIR:-$HOME/.commonly/dev}"
LOCK_DIR="$DEV_DIR/registry.lock"
SLOTS_MJS="$ROOT/scripts/dev-slots.mjs"
# Same images as docker-compose.dev.yml, so a slot runs the versions CI runs.
PG_IMAGE="postgres:17"
MONGO_IMAGE="mongo:8.2"
# Local only: each slot's Postgres and Mongo listen on 127.0.0.1.
PG_APP_USER="commonly"
PG_APP_PASSWORD="${COMMONLY_SLOT_PG_PASSWORD:-commonly_dev}"

LSOF=""

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
    echo "Docker is not running. The ephemeral slot needs its own Mongo and Postgres containers." >&2
    exit 1
  fi
}

# lsof is found through PATH. macOS installs it in /usr/sbin, which some shells leave off PATH.
require_lsof() {
  PATH="$PATH:/usr/sbin:/sbin"
  LSOF="$(command -v lsof || true)"
  if [ -z "$LSOF" ]; then
    echo "lsof is not on PATH. The ephemeral slot needs it to record the PID that listens on each port." >&2
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

# Fails when a port is still taken. Used after the recorded processes are stopped.
wait_port_free() {
  local port="$1" tries=0
  while nc -z 127.0.0.1 "$port" 2>/dev/null; do
    tries=$((tries + 1))
    if [ "$tries" -gt 50 ]; then
      echo "port $port is still in use; stop that process or run ./dev.sh gc" >&2
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

# The PID that actually listens on a port. A background subshell's $! is not reliable as the server PID.
listening_pid() {
  local pid
  pid="$("$LSOF" -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null | head -n 1 || true)"
  if [ -z "$pid" ]; then
    echo "nothing is listening on port $1 after the health check passed" >&2
    exit 1
  fi
  echo "$pid"
}

# Stops a process this slot recorded, but only if the PID still belongs to that server.
# A PID the OS has since reused is left alone. Waits until the process is gone.
stop_pid() {
  local pid="$1" pattern="$2" tries=0
  [ -n "$pid" ] && [ "$pid" != "null" ] || return 0
  if kill -0 "$pid" 2>/dev/null && ps -o command= -p "$pid" | grep -q "$pattern"; then
    kill "$pid" 2>/dev/null || true
    while kill -0 "$pid" 2>/dev/null; do
      tries=$((tries + 1))
      if [ "$tries" -gt 50 ]; then
        kill -9 "$pid" 2>/dev/null || true
        break
      fi
      sleep 0.2
    done
  fi
}

# Per-slot secrets: created once, kept in the slot directory, never shared between slots.
ensure_slot_secrets() {
  local file="$SLOT_DIR/secrets.env"
  if [ ! -f "$file" ]; then
    (umask 077 && {
      echo "JWT_SECRET=$(openssl rand -hex 32)"
      echo "LOCAL_DEV_LOGIN_PASSWORD=$(openssl rand -hex 16)"
    } >"$file")
  fi
  # shellcheck disable=SC1090
  . "$file"
}

# Starts a named container, or restarts it when it exists but is stopped.
ensure_container() {
  local name="$1"
  shift
  if docker container inspect "$name" >/dev/null 2>&1; then
    if [ "$(docker inspect -f '{{.State.Running}}' "$name")" != "true" ]; then
      docker start "$name" >/dev/null
    fi
  else
    docker run -d --name "$name" "$@" >/dev/null
  fi
}

# Removes a slot's containers and volumes. Returns non-zero if any of them still exists.
remove_slot_containers() {
  local n="$1" name
  for name in "commonly-slot-$n-pg" "commonly-slot-$n-mongo"; do
    if docker container inspect "$name" >/dev/null 2>&1; then
      docker rm -f "$name" >/dev/null || return 1
    fi
  done
  for name in "commonly-slot-$n-pgdata" "commonly-slot-$n-mongodata"; do
    if docker volume inspect "$name" >/dev/null 2>&1; then
      docker volume rm "$name" >/dev/null || return 1
    fi
  done
}

# Records a launched PID in the registry right away, so a later failure in this run leaves
# something the next run or gc can stop.
record_pid() {
  local which="$1" pid="$2"
  lock_acquire
  if [ "$which" = "backend" ]; then
    node "$SLOTS_MJS" set-pids "$SLOT_N" "$pid" ""
  else
    node "$SLOTS_MJS" set-pids "$SLOT_N" "" "$pid"
  fi
  lock_release
}

up_ephemeral() {
  require_docker
  require_lsof
  local node_bin
  node_bin="$(node20_bin)"
  if [ -n "$node_bin" ]; then
    export PATH="$node_bin:$PATH"
  else
    echo "⚠️  node@20 not found under Homebrew; using $(node -v). CI runs Node 20." >&2
  fi

  lock_acquire
  local slug assignments
  slug="$(basename "$ROOT" | tr -cs 'a-zA-Z0-9' '_' | tr 'A-Z' 'a-z' | sed -E 's/^_+//; s/_+$//' | cut -c1-24)"
  assignments="$(node "$SLOTS_MJS" claim "$ROOT" "$slug")"
  eval "$assignments"
  lock_release

  local pg_port mongo_port
  pg_port=$((5102 + 10 * SLOT_N))
  mongo_port=$((5103 + 10 * SLOT_N))
  echo "🧩 Slot $SLOT_N: backend :$BACKEND_PORT, frontend :$FRONTEND_PORT, postgres :$pg_port, mongo :$mongo_port, database $DB_NAME"
  mkdir -p "$SLOT_DIR"
  ensure_slot_secrets

  # A slot that is already running is replaced, not reused. Its recorded servers are stopped
  # first, and a port still taken after that stops the run, so nothing runs that this run did not start.
  stop_pid "${BACKEND_PID:-}" "dist/server.js"
  stop_pid "${FRONTEND_PID:-}" "vite"
  wait_port_free "$BACKEND_PORT"
  wait_port_free "$FRONTEND_PORT"

  docker volume create "commonly-slot-$SLOT_N-pgdata" >/dev/null
  docker volume create "commonly-slot-$SLOT_N-mongodata" >/dev/null
  ensure_container "commonly-slot-$SLOT_N-pg" \
    -e POSTGRES_USER="$PG_APP_USER" -e POSTGRES_PASSWORD="$PG_APP_PASSWORD" -e POSTGRES_DB="$DB_NAME" \
    -p "127.0.0.1:$pg_port:5432" -v "commonly-slot-$SLOT_N-pgdata:/var/lib/postgresql" "$PG_IMAGE"
  ensure_container "commonly-slot-$SLOT_N-mongo" \
    -p "127.0.0.1:$mongo_port:27017" -v "commonly-slot-$SLOT_N-mongodata:/data/db" "$MONGO_IMAGE"
  wait_port "$mongo_port" "slot mongo"
  local tries=0
  until docker exec "commonly-slot-$SLOT_N-pg" pg_isready -U "$PG_APP_USER" -d "$DB_NAME" >/dev/null 2>&1; do
    tries=$((tries + 1))
    if [ "$tries" -gt 150 ]; then
      echo "slot postgres did not become ready within 30s" >&2
      exit 1
    fi
    sleep 0.2
  done

  echo "🔨 Building backend (Node $(node -v))..."
  (cd "$ROOT/backend" && npm run build >"$SLOT_DIR/build-backend.log" 2>&1) || {
    echo "backend build failed; see $SLOT_DIR/build-backend.log" >&2
    tail -n 20 "$SLOT_DIR/build-backend.log" >&2
    exit 1
  }

  # The server gets only what it needs. A fresh worktree has no backend/.env, so the slot's own
  # session secret and local login user are passed here.
  # exec makes the subshell's PID the node PID, so backend.pid names the server itself.
  # Its stdio is detached, or the pipe into this script never closes.
  (cd "$ROOT/backend" && exec env -i \
    PATH="$PATH" HOME="$HOME" TMPDIR="${TMPDIR:-/tmp}" LANG="${LANG:-en_US.UTF-8}" \
    PORT="$BACKEND_PORT" \
    MONGO_URI="mongodb://127.0.0.1:$mongo_port/$DB_NAME" \
    PG_HOST=127.0.0.1 PG_PORT="$pg_port" PG_USER="$PG_APP_USER" PG_PASSWORD="$PG_APP_PASSWORD" PG_DATABASE="$DB_NAME" \
    FRONTEND_URL="http://127.0.0.1:$FRONTEND_PORT" \
    JWT_SECRET="$JWT_SECRET" \
    LOCAL_DEV_LOGIN_ENABLED=true LOCAL_DEV_LOGIN_EMAIL="dev-slot-$SLOT_N@commonly.local" \
    LOCAL_DEV_LOGIN_PASSWORD="$LOCAL_DEV_LOGIN_PASSWORD" \
    RUN_WORKER=0 \
    NODE_OPTIONS="--max-old-space-size=768" \
    node dist/server.js </dev/null >"$SLOT_DIR/backend.log" 2>&1) </dev/null >/dev/null 2>&1 &
  local launched_backend_pid=$!
  record_pid "backend" "$launched_backend_pid"
  wait_http "http://127.0.0.1:$BACKEND_PORT/api/health/live" backend "$SLOT_DIR/backend.log"
  # Health alone only proves that something answers the port. The listener must be the process we launched.
  local backend_pid
  backend_pid="$(listening_pid "$BACKEND_PORT")"
  if [ "$backend_pid" != "$launched_backend_pid" ]; then
    echo "port $BACKEND_PORT answered from pid $backend_pid, not the slot server ($launched_backend_pid)" >&2
    exit 1
  fi
  echo "$backend_pid" >"$SLOT_DIR/backend.pid"

  # Login checks the slot's login user and session secret together. Health passes without either.
  # The user is created after the server starts listening, so wait for its ready line first.
  tries=0
  until grep -q '^\[local-dev-login\] Ready' "$SLOT_DIR/backend.log" 2>/dev/null; do
    tries=$((tries + 1))
    if [ "$tries" -gt 300 ]; then
      echo "local login user was not ready on slot $SLOT_N; see $SLOT_DIR/backend.log" >&2
      exit 1
    fi
    sleep 0.2
  done
  local login_body
  login_body="$(printf '{"email":"dev-slot-%s@commonly.local","password":"%s"}' "$SLOT_N" "$LOCAL_DEV_LOGIN_PASSWORD")"
  if ! curl -fsS -H 'content-type: application/json' -d "$login_body" "http://127.0.0.1:$BACKEND_PORT/api/auth/login" 2>/dev/null | grep -q '"token"'; then
    echo "local login failed on slot $SLOT_N; see $SLOT_DIR/backend.log" >&2
    exit 1
  fi

  echo "🔨 Building frontend..."
  (cd "$ROOT/frontend" && REACT_APP_API_URL="http://127.0.0.1:$BACKEND_PORT" \
    ./node_modules/.bin/vite build --outDir "$SLOT_DIR/web" --emptyOutDir >"$SLOT_DIR/build-frontend.log" 2>&1) || {
    echo "frontend build failed; see $SLOT_DIR/build-frontend.log" >&2
    tail -n 20 "$SLOT_DIR/build-frontend.log" >&2
    exit 1
  }
  (cd "$ROOT/frontend" && exec ./node_modules/.bin/vite preview --outDir "$SLOT_DIR/web" \
    --host 127.0.0.1 --port "$FRONTEND_PORT" --strictPort </dev/null >"$SLOT_DIR/preview.log" 2>&1) </dev/null >/dev/null 2>&1 &
  local launched_frontend_pid=$!
  record_pid "frontend" "$launched_frontend_pid"
  wait_http "http://127.0.0.1:$FRONTEND_PORT/" frontend "$SLOT_DIR/preview.log"
  local frontend_pid
  frontend_pid="$(listening_pid "$FRONTEND_PORT")"
  if [ "$frontend_pid" != "$launched_frontend_pid" ]; then
    echo "port $FRONTEND_PORT answered from pid $frontend_pid, not the slot preview ($launched_frontend_pid)" >&2
    exit 1
  fi
  echo "$frontend_pid" >"$SLOT_DIR/frontend.pid"

  lock_acquire
  node "$SLOTS_MJS" set-pids "$SLOT_N" "$backend_pid" "$frontend_pid"
  lock_release

  local rss
  rss="$(ps -o rss= -p "$backend_pid","$frontend_pid" | awk '{s+=$1} END {printf "%.0f", s/1024}')"
  echo "✅ Slot $SLOT_N is up: frontend http://127.0.0.1:$FRONTEND_PORT  backend http://127.0.0.1:$BACKEND_PORT"
  echo "   RSS of backend + preview: ${rss} MB (excludes Docker VM and the slot's containers)"
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
    # The slot stays claimed until its containers and volumes are gone. Otherwise a later
    # claim could reuse the number while the old data still exists.
    if ! docker info >/dev/null 2>&1; then
      echo "   Docker is not running; slot $n stays claimed for a later gc" >&2
      continue
    fi
    if ! remove_slot_containers "$n"; then
      echo "   could not remove slot $n's containers or volumes; slot stays claimed" >&2
      continue
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
