#!/usr/bin/env bash
# The two-worker proof: the VM's own compose file (deploy/vm/), with a local
# MongoDB and a stub model (compose.ci.yml), on a throwaway Linux Docker host.
# Never a serving VM: it refuses to run where deploy/vm already holds an env
# file, writes throwaway ones, runs under its own project name (commonly-ci)
# and removes its containers, volumes and env files when done.
#
#   IMAGE=<registry>/commonly-backend:<tag> bash scripts/vm-two-workers/ci/run.sh
#
# 1. One backend (the profile off): load phases, CPU sampled.
# 2. Two backends behind api-lb: the limiter checks, the same load phases.
# 3. Redis stopped: backend-2 stops serving, every user is answered by backend,
#    and backend-2 comes back once Redis does.
# Prints a markdown summary to stdout (and to $GITHUB_STEP_SUMMARY when set).
set -euo pipefail

: "${IMAGE:?set IMAGE to the backend image under test}"
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
vm="$repo/deploy/vm"
state="$(mktemp -d)"
chmod 777 "$state"
summary="$state/summary.md"
DURATION="${DURATION:-60}"
POLL_LOW="${POLL_LOW:-300}"
POLL_HIGH="${POLL_HIGH:-500}"
TURNS="${TURNS:-240}"
MIX_AGENTS="${MIX_AGENTS:-300}"
MIX_TURNS="${MIX_TURNS:-120}"

registry="${IMAGE%/commonly-backend:*}"
tag="${IMAGE##*:}"
[ "$registry/commonly-backend:$tag" = "$IMAGE" ] || { echo "IMAGE must look like <registry>/commonly-backend:<tag>" >&2; exit 1; }

for file in .env backend.env litellm.env commonly-bot.env backup.env; do
  if [ -e "$vm/$file" ]; then
    echo "deploy/vm/$file exists: this looks like a real install. The proof runs only on a throwaway checkout." >&2
    exit 1
  fi
done
project=commonly-ci
compose() { docker compose -p "$project" -f "$vm/docker-compose.yml" -f "$here/compose.ci.yml" "$@"; }
secret() { head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n'; }

cleanup() {
  [ -n "${sampler:-}" ] && kill "$sampler" 2>/dev/null || true
  compose --profile two-workers logs --no-color backend backend-2 api-lb redis > "$state/stack.log" 2>&1 || true
  compose --profile two-workers down -v --remove-orphans >/dev/null 2>&1 || true
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ] && [ -f "$summary" ]; then cat "$summary" >> "$GITHUB_STEP_SUMMARY"; fi
  [ -n "${KEEP_LOGS:-}" ] && cp "$state/stack.log" "$KEEP_LOGS" 2>/dev/null || true
  rm -f "$vm/.env" "$vm/backend.env" "$vm/litellm.env" "$vm/commonly-bot.env" "$vm/backup.env"
  rm -rf "$state"
}
trap cleanup EXIT

# --- env files (throwaway values; nothing here is a real credential) ---
umask 077
cat > "$vm/.env" <<EOF
COMMONLY_IMAGE_REGISTRY='$registry'
COMMONLY_IMAGE_TAG='$tag'
TUNNEL_TOKEN='unused'
PG_ADMIN_USER='commonly_admin'
PG_ADMIN_PASSWORD='$(secret)'
PG_DATABASE='commonly'
PG_USER='commonly_app'
PG_PASSWORD='$(secret)'
LITELLM_PG_USER='litellm'
LITELLM_PG_PASSWORD='$(secret)'
REDIS_PASSWORD='$(secret)'
BACKUP_S3_ENDPOINT='unused'
BACKUP_S3_BUCKET='unused'
BACKUP_S3_ACCESS_KEY_ID='unused'
BACKUP_S3_SECRET_ACCESS_KEY='unused'
EOF
cat > "$vm/backend.env" <<EOF
JWT_SECRET='$(secret)'
MONGO_URI='mongodb://mongo:27017/commonly'
LITELLM_MASTER_KEY='stub'
FRONTEND_URL='http://localhost'
AGENT_USER_DAILY_RUN_CEILING='0'
AGENT_USER_DAILY_RUN_CEILING_PRO='0'
EOF
: > "$vm/litellm.env"
: > "$vm/commonly-bot.env"
: > "$vm/backup.env"
[ -e "$vm/litellm/config.yaml" ] || { mkdir -p "$vm/litellm"; : > "$vm/litellm/config.yaml"; }
umask 022

network="${project}_commonly"
gen() { # <tag> <api> <mode> <args...>
  local label="$1" api="$2"; shift 2
  docker run --rm --network "$network" -e "API=$api" -e "TAG=$label" -e STATE=/state \
    -v "$here:/lg:ro" -v "$state:/state" --entrypoint node "$IMAGE" /lg/loadgen.mjs "$@"
}
node_check() { # <script> <args...>
  local script="$1"; shift
  docker run --rm --network "$network" -v "$here:/lg:ro" --entrypoint node "$IMAGE" "/lg/$script" "$@"
}

# CPU per container every 2 s: "<epoch> <name> <cpu%>".
sample() {
  while true; do
    docker stats --no-stream --format '{{.Name}} {{.CPUPerc}}' 2>/dev/null \
      | sed "s/^/$(date +%s) /; s/%$//" >> "$state/cpu.log" || true
    sleep 2
  done
}
cpu_between() { # <container-suffix> <from-epoch> <to-epoch> -> mean cpu%
  awk -v n="$project-$1-1" -v a="$2" -v b="$3" \
    '$2 == n && $1 >= a && $1 <= b { s += $3; c += 1 } END { if (c) printf "%.0f%%", s / c; else printf "-" }' "$state/cpu.log"
}

phase() { # <config> <api> <label> <mode> <args...>
  local config="$1" api="$2" label="$3"; shift 3
  local t0 t1 line
  t0=$(date +%s)
  line="$(gen "$label" "$api" "$@" | grep '^RESULT' | tr '\n' ' ')"
  t1=$(date +%s)
  echo "$line"
  local p50 p95 err rps
  p50="$(grep -o 'p50=[^ ]*' <<<"$line" | head -1 | cut -d= -f2)"
  p95="$(grep -o 'p95=[^ ]*' <<<"$line" | head -1 | cut -d= -f2)"
  err="$(grep -o 'err=[^ ]*' <<<"$line" | head -1 | cut -d= -f2)"
  rps="$(grep -o 'rps=[^ ]*' <<<"$line" | head -1 | cut -d= -f2)"
  local cpu="$(cpu_between backend "$t0" "$t1")"
  [ "$config" = two ] && cpu="$cpu / $(cpu_between backend-2 "$t0" "$t1")"
  echo "| $config | $label | $rps | $p50 | $p95 | $err | $cpu |" >> "$summary"
}

run_phases() { # <config> <api>
  phase "$1" "$2" "poll $POLL_LOW" poll "$POLL_LOW" "$DURATION"
  phase "$1" "$2" "poll $POLL_HIGH" poll "$POLL_HIGH" "$DURATION"
  phase "$1" "$2" "posts $TURNS/min" turns "$TURNS" "$DURATION"
  phase "$1" "$2" "mix $MIX_AGENTS + $MIX_TURNS/min" mix "$MIX_AGENTS" "$MIX_TURNS" "$DURATION"
}

{
  echo "## Two backend workers: proof"
  echo
  echo "Runner: $(nproc) vCPU. Each backend process is held to 1 CPU. Stub model ~3 s. ${DURATION} s per phase."
  echo "A mix row shows its pollers; posts are in the log. The scheduler runs on backend, as on the VM."
  echo
} > "$summary"

echo "== one backend (the profile off)"
compose up -d --wait
sample & sampler=$!
gen setup http://backend:5000 setup 25 20
{
  echo "| config | phase | req/s | p50 | p95 | errors | backend CPU (backend-2) |"
  echo "|---|---|---|---|---|---|---|"
} >> "$summary"
run_phases one http://backend:5000

echo "== two backends behind api-lb"
COMPOSE_PROFILES=two-workers compose up -d --wait
run_phases two http://api-lb:5000

{
  echo
  echo "### Checks"
  echo
} >> "$summary"
# Records PASS or FAIL and carries on, so one failure doesn't hide the rest;
# the exit status at the end reads the summary.
check() { # <description> <command...>
  local description="$1"; shift
  local out
  if out="$("$@" 2>&1)"; then
    echo "- PASS $description" >> "$summary"
  else
    echo "- FAIL $description" >> "$summary"
  fi
  echo "$out"
}

# A fresh login window per check: each uses its own random addresses.
check "both processes count a limit in one shared window" node_check limiter-check.mjs shared
check "through api-lb the limiter keys on the end user's address" node_check limiter-check.mjs via-lb

backend_restarts() { docker inspect -f '{{.RestartCount}} {{.State.StartedAt}}' "$project-backend-1"; }
before="$(backend_restarts)"
echo "== Redis stopped"
compose stop redis
# backend-2 drops its sockets and drains; watch it stop serving.
for _ in $(seq 1 60); do
  if ! docker run --rm --network "$network" "$IMAGE" curl -fsS -o /dev/null --max-time 2 http://backend-2:5000/api/health/live 2>/dev/null; then break; fi
  sleep 1
done
check "backend-2 stops serving once Redis is gone" bash -c \
  "! docker run --rm --network $network $IMAGE curl -fsS -o /dev/null --max-time 2 http://backend-2:5000/api/health/live"
check "with Redis down, every user is answered through api-lb" docker run --rm --network "$network" \
  -v "$repo/scripts/vm-two-workers:/srv:ro" python:3.12-alpine python3 -I -c "
import urllib.request, sys
bad = []
for n in range(1, 41):
    ip = f'198.51.100.{n}'
    req = urllib.request.Request('http://api-lb:5000/api/health/live', headers={'CF-Connecting-IP': ip})
    try:
        urllib.request.urlopen(req, timeout=15).read()
    except Exception as e:
        bad.append(f'{ip}: {e}')
print('\n'.join(bad) or 'all 40 answered')
sys.exit(1 if bad else 0)
"
check "backend kept serving: no restart while Redis was down" test "$(backend_restarts)" = "$before"

compose start redis
for _ in $(seq 1 120); do
  if docker run --rm --network "$network" "$IMAGE" curl -fsS -o /dev/null --max-time 2 http://backend-2:5000/api/health/live 2>/dev/null; then break; fi
  sleep 2
done
check "backend-2 serves again once Redis is back" docker run --rm --network "$network" "$IMAGE" \
  curl -fsS -o /dev/null --max-time 5 http://backend-2:5000/api/health/live

{
  echo
  echo "Singleton jobs: scheduler start lines per process (backend, backend-2): $(compose logs --no-color backend 2>/dev/null | grep -c 'Starting summarizer scheduler' || true), $(compose --profile two-workers logs --no-color backend-2 2>/dev/null | grep -c 'Starting summarizer scheduler' || true)"
} >> "$summary"

cat "$summary"
grep -q '^- FAIL' "$summary" && exit 1
exit 0
