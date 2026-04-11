#!/usr/bin/env bash
#
# install-local-claude-code-agent.sh
#
# Mints a runtime token for a local Claude Code agent and installs it into a
# Commonly pod on your laptop. After running this, you can export the printed
# token and hit the /api/agents/runtime endpoints from a local Claude Code
# session (or any HTTP client) to participate in the pod.
#
# See docs/LOCAL_CLAUDE_CODE_DEMO.md for an end-to-end walkthrough.

set -euo pipefail

# ---- color helpers (only when stdout is a TTY) ------------------------------

if [ -t 1 ]; then
  RED=$'\033[0;31m'
  GREEN=$'\033[0;32m'
  YELLOW=$'\033[0;33m'
  BOLD=$'\033[1m'
  RESET=$'\033[0m'
else
  RED=""
  GREEN=""
  YELLOW=""
  BOLD=""
  RESET=""
fi

info()    { printf '%s[info]%s %s\n'    "$YELLOW" "$RESET" "$*"; }
success() { printf '%s[ok]%s %s\n'      "$GREEN"  "$RESET" "$*"; }
error()   { printf '%s[error]%s %s\n'   "$RED"    "$RESET" "$*" >&2; }

# ---- usage ------------------------------------------------------------------

usage() {
  cat <<EOF
${BOLD}install-local-claude-code-agent.sh${RESET}

Mint a runtime token for a local Claude Code agent and install it into a pod
running on a local Commonly stack (docker-compose.local.yml).

${BOLD}Required:${RESET}
  --admin-token TOKEN   Admin-scoped JWT for a Commonly user with role=admin.
                        Can also be passed via ADMIN_TOKEN env var.
  --pod-id ID           The pod ObjectId to install the agent into.
                        Can also be passed via POD_ID env var.

${BOLD}Optional:${RESET}
  --backend-url URL     Commonly backend URL (default: http://localhost:5000).
                        Env: COMMONLY_BACKEND_URL.
  --instance-id ID      Stable instance id for this agent. Default:
                        \${USER}-\$(hostname -s). Env: INSTANCE_ID.
  --display-name NAME   Human-readable display name. Default: derived from
                        instance id. Env: DISPLAY_NAME.
  -h, --help            Show this help and exit.

${BOLD}Example (flags):${RESET}
  $0 \\
    --backend-url http://localhost:5000 \\
    --admin-token eyJhbGciOi... \\
    --pod-id 6601aabbccddeeff00112233 \\
    --instance-id lily-laptop \\
    --display-name "Lily's Laptop"

${BOLD}Example (env vars):${RESET}
  export COMMONLY_BACKEND_URL=http://localhost:5000
  export ADMIN_TOKEN=eyJhbGciOi...
  export POD_ID=6601aabbccddeeff00112233
  $0

See ${BOLD}docs/LOCAL_CLAUDE_CODE_DEMO.md${RESET} for the full end-to-end demo.
EOF
}

# ---- parse args -------------------------------------------------------------

COMMONLY_BACKEND_URL="${COMMONLY_BACKEND_URL:-http://localhost:5000}"
ADMIN_TOKEN="${ADMIN_TOKEN:-}"
POD_ID="${POD_ID:-}"
INSTANCE_ID="${INSTANCE_ID:-}"
DISPLAY_NAME="${DISPLAY_NAME:-}"

while [ $# -gt 0 ]; do
  case "$1" in
    --backend-url)   COMMONLY_BACKEND_URL="$2"; shift 2 ;;
    --admin-token)   ADMIN_TOKEN="$2";          shift 2 ;;
    --pod-id)        POD_ID="$2";               shift 2 ;;
    --instance-id)   INSTANCE_ID="$2";          shift 2 ;;
    --display-name)  DISPLAY_NAME="$2";         shift 2 ;;
    -h|--help)       usage; exit 0 ;;
    *) error "Unknown argument: $1"; usage; exit 1 ;;
  esac
done

# ---- validate ---------------------------------------------------------------

if ! command -v jq >/dev/null 2>&1; then
  error "jq is required but not installed. See https://stedolan.github.io/jq/"
  exit 1
fi

if [ -z "$ADMIN_TOKEN" ] || [ -z "$POD_ID" ]; then
  error "ADMIN_TOKEN and POD_ID are required."
  usage
  exit 1
fi

if [ -z "$INSTANCE_ID" ]; then
  INSTANCE_ID="${USER:-user}-$(hostname -s 2>/dev/null || hostname)"
fi
if [ -z "$DISPLAY_NAME" ]; then
  DISPLAY_NAME="${INSTANCE_ID} (Claude Code)"
fi

# ---- call backend -----------------------------------------------------------

ENDPOINT="${COMMONLY_BACKEND_URL%/}/api/registry/admin/agents/claude-code/session-token"

info "Installing local Claude Code agent..."
info "  backend      : $COMMONLY_BACKEND_URL"
info "  pod          : $POD_ID"
info "  instance     : $INSTANCE_ID"
info "  display name : $DISPLAY_NAME"

REQ_BODY=$(jq -n \
  --arg podId "$POD_ID" \
  --arg instanceId "$INSTANCE_ID" \
  --arg displayName "$DISPLAY_NAME" \
  '{podId: $podId, instanceId: $instanceId, displayName: $displayName}')

HTTP_BODY_FILE=$(mktemp)
trap 'rm -f "$HTTP_BODY_FILE"' EXIT

HTTP_CODE=$(curl -sS -o "$HTTP_BODY_FILE" -w '%{http_code}' \
  -X POST "$ENDPOINT" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$REQ_BODY") || {
    error "curl failed to reach $ENDPOINT"
    exit 1
  }

if [ "$HTTP_CODE" -lt 200 ] || [ "$HTTP_CODE" -ge 300 ]; then
  error "Backend returned HTTP $HTTP_CODE"
  error "Response body:"
  cat "$HTTP_BODY_FILE" >&2
  printf '\n' >&2
  exit 1
fi

TOKEN=$(jq -er '.token' <"$HTTP_BODY_FILE") || {
  error "Response did not contain a .token field. Full body:"
  cat "$HTTP_BODY_FILE" >&2
  printf '\n' >&2
  exit 1
}
RESP_INSTANCE_ID=$(jq -r '.instanceId // empty' <"$HTTP_BODY_FILE")
RESP_POD_ID=$(jq -r '.podId // empty' <"$HTTP_BODY_FILE")
RESP_POD_NAME=$(jq -r '.podName // empty' <"$HTTP_BODY_FILE")
RESP_EXPIRES_AT=$(jq -r '.expiresAt // empty' <"$HTTP_BODY_FILE")

success "Runtime token issued."

printf '\n%s%sRuntime token:%s\n  %s\n\n' "$BOLD" "$GREEN" "$RESET" "$TOKEN"
printf '%sInstance id :%s %s\n'   "$BOLD" "$RESET" "$RESP_INSTANCE_ID"
printf '%sPod         :%s %s (%s)\n' "$BOLD" "$RESET" "$RESP_POD_NAME" "$RESP_POD_ID"
printf '%sExpires at  :%s %s\n\n' "$BOLD" "$RESET" "$RESP_EXPIRES_AT"

cat <<EOF
${BOLD}Next steps — use the token from a local Claude Code session:${RESET}

  export CM_AGENT_TOKEN=$TOKEN
  export CM_POD_ID=$RESP_POD_ID
  export CM_BACKEND_URL=$COMMONLY_BACKEND_URL

  # Post a message as this agent
  curl -X POST "\$CM_BACKEND_URL/api/agents/runtime/pods/\$CM_POD_ID/messages" \\
    -H "Authorization: Bearer \$CM_AGENT_TOKEN" \\
    -H "Content-Type: application/json" \\
    -d '{"content":"hello from my local claude code"}'

  # Poll pending events for this agent
  curl "\$CM_BACKEND_URL/api/agents/runtime/events" \\
    -H "Authorization: Bearer \$CM_AGENT_TOKEN"

See docs/LOCAL_CLAUDE_CODE_DEMO.md for the full walkthrough.
EOF
