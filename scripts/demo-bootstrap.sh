#!/usr/bin/env bash
# =============================================================================
# demo-bootstrap.sh — bring up local Commonly for the 3-minute demo.
#
# What this script does (automated):
#   1. Verify prerequisites (docker, node, npm).
#   2. Start the local stack via docker-compose.local.yml.
#   3. Wait for the backend to respond on :5000.
#
# What this script will NOT do (printed as next steps):
#   4. Register a user — done by you in the browser at http://localhost:3000.
#   5. Mint a runtime token — done via `commonly login` + `commonly agent attach`.
#   6. Attach the local claude CLI — see docs/DEMO_QUICKSTART.md Step 1.
#   7. Wire the python webhook bot + MCP client — Steps 2 and 3 in the same doc.
#
# Bias: do steps 1-3 reliably, then print a clear hand-off. Better than
# automating step 4+ in a way that mysteriously stalls mid-recording.
#
# Usage:
#   ./scripts/demo-bootstrap.sh           # bring up
#   ./scripts/demo-bootstrap.sh --down    # tear down (compose down -v)
# =============================================================================

set -euo pipefail

# Resolve repo root from this script's location so we can be invoked from
# anywhere (e.g. `bash scripts/demo-bootstrap.sh` or absolute path).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

COMPOSE_FILE="$REPO_ROOT/docker-compose.local.yml"
BACKEND_URL="http://localhost:5000"
FRONTEND_URL="http://localhost:3000"
HEALTH_PATH="/api/health"
HEALTH_TIMEOUT_S=60

# ── ANSI helpers ────────────────────────────────────────────────────────────
if [[ -t 1 ]]; then
  BOLD=$'\033[1m'; DIM=$'\033[2m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'
  RED=$'\033[31m'; CYAN=$'\033[36m'; RESET=$'\033[0m'
else
  BOLD=""; DIM=""; GREEN=""; YELLOW=""; RED=""; CYAN=""; RESET=""
fi

log()    { printf '%s\n' "$*"; }
info()   { printf '%s[*]%s %s\n'   "$CYAN"   "$RESET" "$*"; }
ok()     { printf '%s[+]%s %s\n'   "$GREEN"  "$RESET" "$*"; }
warn()   { printf '%s[!]%s %s\n'   "$YELLOW" "$RESET" "$*" 1>&2; }
err()    { printf '%s[x]%s %s\n'   "$RED"    "$RESET" "$*" 1>&2; }
section(){ printf '\n%s== %s ==%s\n' "$BOLD" "$*" "$RESET"; }

# ── On any unexpected exit, print a clear failure footer ────────────────────
on_err() {
  local rc=$?
  err "demo-bootstrap.sh failed (exit $rc) on line ${BASH_LINENO[0]}."
  err "Inspect logs with:  docker compose -f $COMPOSE_FILE logs --tail=80"
  exit "$rc"
}
trap on_err ERR

# ── Subcommand: --down ──────────────────────────────────────────────────────
if [[ "${1:-}" == "--down" ]]; then
  section "Stopping local Commonly stack"
  docker compose -f "$COMPOSE_FILE" down -v
  ok "Stack stopped and volumes removed."
  exit 0
fi

# ── 1. Prerequisites ────────────────────────────────────────────────────────
section "Checking prerequisites"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    err "Missing required command: $1"
    err "Install hint: $2"
    exit 1
  fi
  ok "$1 found ($(command -v "$1"))"
}

require_cmd docker "https://docs.docker.com/get-docker/"
require_cmd node   "https://nodejs.org/ — Node 20 or newer"
require_cmd npm    "ships with Node — see Node install link"
require_cmd curl   "apt-get install curl  /  brew install curl"

# Docker Compose v2 ships as a docker plugin. Probe rather than require a
# separate binary.
if ! docker compose version >/dev/null 2>&1; then
  err "docker compose v2 plugin not available."
  err "Install hint: https://docs.docker.com/compose/install/"
  exit 1
fi
ok "docker compose v2 found ($(docker compose version --short))"

# Node 20+ check — the CLI requires it. Don't gate on this for the bootstrap
# (which only runs docker), but warn early so the user knows.
NODE_MAJOR=$(node -v | sed -E 's/^v([0-9]+).*/\1/')
if (( NODE_MAJOR < 20 )); then
  warn "Node $NODE_MAJOR detected — the commonly CLI needs Node 20+."
  warn "Bootstrap will continue, but \`commonly login\` will fail until you upgrade."
fi

if [[ ! -f "$COMPOSE_FILE" ]]; then
  err "Compose file not found: $COMPOSE_FILE"
  err "Are you running this from inside the commonly repo?"
  exit 1
fi
ok "Compose file: $COMPOSE_FILE"

# ── 2. Bring the stack up ───────────────────────────────────────────────────
section "Starting local Commonly stack"
info "docker compose -f docker-compose.local.yml up -d --build"
docker compose -f "$COMPOSE_FILE" up -d --build
ok "Containers started."

# ── 3. Wait for backend health ──────────────────────────────────────────────
section "Waiting for backend at $BACKEND_URL$HEALTH_PATH"
deadline=$(( $(date +%s) + HEALTH_TIMEOUT_S ))
attempts=0
while true; do
  attempts=$(( attempts + 1 ))
  if curl --silent --fail --max-time 3 "$BACKEND_URL$HEALTH_PATH" >/dev/null 2>&1; then
    ok "Backend healthy after $attempts probe(s)."
    break
  fi
  if (( $(date +%s) > deadline )); then
    err "Backend did not respond within ${HEALTH_TIMEOUT_S}s."
    err "Check logs:  docker compose -f $COMPOSE_FILE logs backend --tail=80"
    exit 1
  fi
  printf '%s.%s' "$DIM" "$RESET"
  sleep 2
done

# ── 4. Print next steps ─────────────────────────────────────────────────────
section "Local Commonly is up — next steps"

cat <<EOF

  Frontend:  $FRONTEND_URL
  Backend:   $BACKEND_URL
  MongoDB:   inside the compose network (no host port)

  ${BOLD}Step A — Register a human user${RESET}

    Open $FRONTEND_URL in your browser → click ${BOLD}Sign up${RESET}.
    After signup you'll land in the app; create a pod for the demo (or use
    an existing one). Note the pod ID from the URL — looks like
    ${DIM}/pods/69b7ddff0ce64c9648365fc4${RESET}.

  ${BOLD}Step B — Log the CLI in to your local instance${RESET}

    cd cli && npm install && npm link    # one-time
    commonly login --instance $BACKEND_URL

    Use the same email + password you registered with.

  ${BOLD}Step C — Attach claude with the demo environment${RESET}

    commonly agent attach claude \\
      --pod <YOUR_POD_ID> \\
      --name my-claude \\
      --env examples/demo/demo.yaml

    Then in another terminal:  commonly agent run my-claude

  ${BOLD}Step D — Bring in the python webhook bot${RESET}

    Follow Step 2 in docs/DEMO_QUICKSTART.md — \`commonly agent init\`
    scaffolds the bot, then you run it from a third terminal.

  ${BOLD}Step E — Point Cursor / Claude Desktop at commonly-mcp${RESET}

    See Step 3 in docs/DEMO_QUICKSTART.md for the config snippet.

  ${BOLD}Tear down when you're done:${RESET}

    ./scripts/demo-bootstrap.sh --down

  Full walkthrough:  docs/DEMO_QUICKSTART.md

EOF
ok "Bootstrap complete."
