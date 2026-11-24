#!/usr/bin/env bash
# F597 comparison on a throwaway Docker host: the VM's compose file with one
# backend (the two-workers profile off), a local MongoDB and a stub model, as in
# run.sh. Each leg starts from empty volumes and runs the same client
# (longpoll-gen.mjs) against a different backend image.
#
#   LEGS="before=<registry>/commonly-backend:<tag> after=<registry>/commonly-backend:<tag>" \
#     bash scripts/vm-two-workers/ci/longpoll.sh
#
# Prints a markdown summary to stdout (and to $GITHUB_STEP_SUMMARY when set).
set -euo pipefail

: "${LEGS:?set LEGS to name=image pairs}"
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
vm="$repo/deploy/vm"
state="$(mktemp -d)"
chmod 777 "$state"
summary="$state/summary.md"
AGENTS="${AGENTS:-300}"
IDLE_SECONDS="${IDLE_SECONDS:-240}"
TRICKLE_SECONDS="${TRICKLE_SECONDS:-150}"
POSTS_PER_MIN="${POSTS_PER_MIN:-12}"
WAIT_MS="${WAIT_MS:-25000}"

for file in .env backend.env litellm.env commonly-bot.env backup.env; do
  if [ -e "$vm/$file" ]; then
    echo "deploy/vm/$file exists: this looks like a real install. The comparison runs only on a throwaway checkout." >&2
    exit 1
  fi
done
project=commonly-ci
compose() { docker compose -p "$project" -f "$vm/docker-compose.yml" -f "$here/compose.ci.yml" "$@"; }
secret() { head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n'; }

cleanup() {
  [ -n "${sampler:-}" ] && kill "$sampler" 2>/dev/null || true
  compose down -v --remove-orphans >/dev/null 2>&1 || true
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ] && [ -f "$summary" ]; then cat "$summary" >> "$GITHUB_STEP_SUMMARY"; fi
  [ -n "${KEEP_LOGS:-}" ] && cp "$state"/*.log "$KEEP_LOGS"/ 2>/dev/null || true
  rm -f "$vm/.env" "$vm/backend.env" "$vm/litellm.env" "$vm/commonly-bot.env" "$vm/backup.env"
  rm -rf "$state"
}
trap cleanup EXIT

write_env() { # <image>
  local image="$1"
  local registry="${image%/commonly-backend:*}" tag="${image##*:}"
  [ "$registry/commonly-backend:$tag" = "$image" ] || { echo "an image must look like <registry>/commonly-backend:<tag>" >&2; exit 1; }
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
}

network="${project}_commonly"
run_node() { # <image> <script> <args...>
  local image="$1" script="$2"; shift 2
  docker run --rm --network "$network" -e API=http://backend:5000 -e "TAG=${leg:-}" -e STATE=/state \
    -v "$here:/lg:ro" -v "$state:/state" --entrypoint node "$image" "/lg/$script" "$@"
}

# CPU per container every 2 s: "<epoch> <name> <cpu%>".
sample() {
  while true; do
    docker stats --no-stream --format '{{.Name}} {{.CPUPerc}}' 2>/dev/null \
      | sed "s/^/$(date +%s) /; s/%$//" >> "$state/cpu.log" || true
    sleep 2
  done
}
cpu_between() { # <from-epoch> <to-epoch> -> mean backend cpu%
  awk -v n="$project-backend-1" -v a="$1" -v b="$2" \
    '$2 == n && $1 >= a && $1 <= b { s += $3; c += 1 } END { if (c) printf "%.1f%%", s / c; else printf "-" }' "$state/cpu.log"
}
field() { grep -o "$1=[^ ]*" <<<"$2" | head -1 | cut -d= -f2; }

{
  echo "## F597: idle agents polling, with and without the long-poll"
  echo
  echo "Runner: $(nproc) vCPU. One backend, held to 1 CPU. ${AGENTS} BYO agents, each running the CLI's loop"
  echo "(asks for a ${WAIT_MS} ms hold; an unheld empty answer waits the normal 5 s). The first 30 s of each phase are ramp-up."
  echo "Idle: ${IDLE_SECONDS} s, no posts. Trickle: ${TRICKLE_SECONDS} s, ${POSTS_PER_MIN} posts/min into the polling agents' pods."
  echo
  echo "| leg | phase | req/h per agent | req/s | p50 | p95 | p95 unheld | errors | backend CPU | delivery p50 / p95 |"
  echo "|---|---|---|---|---|---|---|---|---|---|"
} > "$summary"

for pair in $LEGS; do
  leg="${pair%%=*}"
  image="${pair#*=}"
  echo "== leg $leg ($image)"
  write_env "$image"
  compose up -d --wait
  : > "$state/cpu.log"
  sample & sampler=$!
  run_node "$image" loadgen.mjs setup "$(( (AGENTS + 19) / 20 ))" 20 | tail -1
  # Let the boot-time jobs settle before measuring.
  sleep 20

  t0=$(date +%s)
  out="$(run_node "$image" longpoll-gen.mjs idle "$AGENTS" "$IDLE_SECONDS" "$WAIT_MS" | grep '^RESULT' || true)"
  t1=$(date +%s)
  echo "$out"
  echo "| $leg | idle | $(field perAgentHour "$out") | $(field rps "$out") | $(field p50 "$out") | $(field p95 "$out") | $(field quickP95 "$out") | $(field err "$out") | $(cpu_between $((t0 + 30)) "$t1") | - |" >> "$summary"

  t0=$(date +%s)
  out="$(run_node "$image" longpoll-gen.mjs trickle "$AGENTS" "$POSTS_PER_MIN" "$TRICKLE_SECONDS" "$WAIT_MS" | grep '^RESULT' || true)"
  t1=$(date +%s)
  echo "$out"
  echo "| $leg | trickle | $(field perAgentHour "$out") | $(field rps "$out") | $(field p50 "$out") | $(field p95 "$out") | $(field quickP95 "$out") | $(field err "$out") | $(cpu_between $((t0 + 30)) "$t1") | $(field deliveryP50 "$out") / $(field deliveryP95 "$out") ($(field delivered "$out") events) |" >> "$summary"

  kill "$sampler" 2>/dev/null || true
  sampler=
  cp "$state/cpu.log" "$state/cpu-$leg.log"
  compose logs --no-color backend > "$state/backend-$leg.log" 2>&1 || true
  compose down -v --remove-orphans >/dev/null 2>&1 || true
done

cat "$summary"
