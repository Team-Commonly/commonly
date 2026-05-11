#!/usr/bin/env bash
# Smoke test for the post-YC demo-fidelity sprint.
#
# Asserts every demo-critical flow end-to-end against the configured Commonly
# instance using the demo account's runtime token. A sprint item is "done"
# only when its tag in this script asserts green. See
# `.dev/yc-application/SPRINT_POST_YC.md` for the tag → sprint-item map.
#
# Usage:
#   bash scripts/smoke-test-demo.sh                # use .dev/yc-application/.smoke-env
#   API=https://api-dev.commonly.me TOKEN=... DEMO_POD=... bash scripts/smoke-test-demo.sh
#
# Exits non-zero if any check fails. Each check prints `[tag] green|red[ note]`.

set -uo pipefail
HTTP_CODE=000

# --- config ---------------------------------------------------------------
SMOKE_ENV="${SMOKE_ENV:-.dev/yc-application/.smoke-env}"
if [ -f "$SMOKE_ENV" ]; then
  # shellcheck disable=SC1090
  set -a; source "$SMOKE_ENV"; set +a
fi
API="${API:-https://api-dev.commonly.me}"
TOKEN="${TOKEN:-}"
DEMO_POD="${DEMO_POD:-}"
NOVA_AGENT="${NOVA_AGENT:-nova-claude-nova}"
CODY_AGENT="${CODY_AGENT:-codex-bot-codex}"
PIXEL_AGENT="${PIXEL_AGENT:-pixel-stub-pixel}"

if [ -z "$TOKEN" ] || [ -z "$DEMO_POD" ]; then
  echo "error: TOKEN and DEMO_POD must be set (via env or $SMOKE_ENV)" >&2
  exit 2
fi

# --- counters -------------------------------------------------------------
PASS=0; FAIL=0; SKIP=0
FAILED_TAGS=""

# --- helpers --------------------------------------------------------------
green() { printf "[\033[32m%s\033[0m] green%s\n" "$1" "${2:+ $2}"; PASS=$((PASS+1)); }
red()   { printf "[\033[31m%s\033[0m] red%s\n"   "$1" "${2:+ $2}"; FAIL=$((FAIL+1)); FAILED_TAGS="$FAILED_TAGS $1"; }
todo()  { printf "[\033[33m%s\033[0m] TODO%s\n"  "$1" "${2:+ $2}"; SKIP=$((SKIP+1)); }

# Curl with auth + short timeout. Sets globals HTTP_CODE + HTTP_BODY.
# Don't capture via $(http ...) — that's a subshell, the globals would be
# lost. Call directly, then read HTTP_BODY / HTTP_CODE.
HTTP_BODY=""
http() {
  local method="$1" path="$2" body="${3:-}"
  HTTP_CODE=000
  HTTP_BODY=""
  local args=(-sS -w "\n%{http_code}" -X "$method" -H "Authorization: Bearer $TOKEN" --max-time 30)
  if [ -n "$body" ]; then
    args+=(-H "Content-Type: application/json" -d "$body")
  fi
  local raw
  raw=$(curl "${args[@]}" "${API}${path}" 2>/dev/null) || return 1
  HTTP_CODE="${raw##*$'\n'}"
  HTTP_BODY="${raw%$'\n'*}"
  return 0
}

# --- baseline checks ------------------------------------------------------

# auth — does the token resolve to a user. /api/auth/me 404s on this backend;
# use a route that requires auth and returns username consistently.
http GET "/api/pods"
if [ "$HTTP_CODE" = "200" ]; then
  green auth "token resolves (GET /api/pods 200)"
else
  red auth "HTTP=$HTTP_CODE"
fi

# pod-load
http GET "/api/pods/$DEMO_POD"
if [ "$HTTP_CODE" = "200" ]; then
  members=$(echo "$HTTP_BODY" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(len(d.get("members",[])))' 2>/dev/null || echo 0)
  if [ "$members" -ge 5 ]; then
    green pod-load "members=$members"
  else
    red pod-load "members=$members (<5)"
  fi
else
  red pod-load "HTTP=$HTTP_CODE"
fi

# scrollback
http GET "/api/messages/$DEMO_POD?limit=20"
if [ "$HTTP_CODE" = "200" ]; then
  count=$(echo "$HTTP_BODY" | python3 -c 'import sys,json; d=json.load(sys.stdin); msgs=d if isinstance(d,list) else d.get("messages",[]); print(len(msgs))' 2>/dev/null || echo 0)
  if [ "$count" -ge 15 ]; then
    green scrollback "count=$count"
  else
    red scrollback "count=$count (<15)"
  fi
else
  red scrollback "HTTP=$HTTP_CODE"
fi

# file-preview — sample asset must be reachable
# TODO: parameterize asset path; for now grep an asset URL from the scrollback
asset_path=$(echo "$HTTP_BODY" | python3 -c '
import sys, re, json
msgs = json.load(sys.stdin)
msgs = msgs if isinstance(msgs, list) else msgs.get("messages", [])
for m in msgs:
  content = m.get("content","") or ""
  m_re = re.search(r"\[\[file:([^|\]]+)", content)
  if m_re:
    print(m_re.group(1)); break
' 2>/dev/null || true)
if [ -n "$asset_path" ]; then
  todo file-preview "found asset token '$asset_path' (route check not yet implemented)"
else
  todo file-preview "no file tokens in scrollback"
fi

# --- mention-response — checks that the wired agents are actually alive --
# Posts a unique-timestamped @nova message, polls for a reply within 90s.
ts=$(date +%s)
marker="smoke-test-$ts"
post_body=$(printf '{"content":"@nova-demo smoke %s — please ack briefly"}' "$marker")
http POST "/api/messages/$DEMO_POD" "$post_body"
if [ "$HTTP_CODE" != "200" ] && [ "$HTTP_CODE" != "201" ]; then
  red mention-response "post HTTP=$HTTP_CODE"
else
  found="no"
  for i in $(seq 1 18); do
    sleep 5
    http GET "/api/messages/$DEMO_POD?limit=10"
    if echo "$HTTP_BODY" | python3 -c "
import sys,json
msgs = json.load(sys.stdin)
msgs = msgs if isinstance(msgs,list) else msgs.get('messages',[])
for m in msgs[-10:]:
  u = (m.get('username') or '').lower()
  c = (m.get('content','') or '').lower()
  if ('nova' in u) and ('$marker' in c or 'smoke' in c):
    sys.exit(0)
sys.exit(1)
" 2>/dev/null; then
      found="yes"; break
    fi
  done
  if [ "$found" = "yes" ]; then
    green mention-response "nova replied within $((i*5))s"
  else
    red mention-response "no nova reply within 90s"
  fi
fi

# --- sprint-item checks (TODOs first, fill in as items land) -------------

# B1: a2a-dm-listable — backend route GET /api/registry/pods/:podId/agents/:name/a2a-dms
http GET "/api/registry/pods/$DEMO_POD/agents/openclaw/a2a-dms?instanceId=nova-demo"
if [ "$HTTP_CODE" = "200" ]; then
  has_array=$(echo "$HTTP_BODY" | python3 -c 'import sys,json; d=json.load(sys.stdin); print("yes" if isinstance(d.get("a2aDms"), list) else "no")' 2>/dev/null || echo no)
  if [ "$has_array" = "yes" ]; then
    count=$(echo "$HTTP_BODY" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(len(d.get("a2aDms",[])))' 2>/dev/null || echo 0)
    green a2a-dm-listable "a2aDms array returned, count=$count"
  else
    red a2a-dm-listable "response missing a2aDms array"
  fi
else
  red a2a-dm-listable "HTTP=$HTTP_CODE"
fi

todo a2a-dm-load         "depends on B1 frontend deploy + Playwright verification"
todo byo-page            "depends on B3"
todo byo-token-issue     "depends on B3"
todo install-handoff     "depends on B2"
todo first-msg-empty-state "depends on B4 (Playwright; manual today)"
todo reaction-add        "depends on B5"
todo runtime-badges      "depends on C2 (today: pixel-stub-pixel patched)"
todo talk-to-cli         "depends on agent runtime token issuance; defer"

# --- summary --------------------------------------------------------------
echo
echo "summary: $PASS green, $FAIL red, $SKIP TODO"
if [ -n "$FAILED_TAGS" ]; then
  echo "failed tags:$FAILED_TAGS"
  exit 1
fi
exit 0
