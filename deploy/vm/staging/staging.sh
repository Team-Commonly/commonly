#!/bin/sh
# Staging on the prod VM: a second Compose project, stopped by default
# (docs/deployment/vm-staging.md). Run as root from the staging checkout.
#
#   staging.sh up <tag>   pull and start staging at an image tag; wait for health
#   staging.sh journey    run the stranger journey once against staging
#   staging.sh down       stop and remove staging's containers (volumes kept)
#   staging.sh status     list staging's containers
#
# Never touches the prod project: every compose call names the staging project
# and both files explicitly.
set -eu

HERE=$(cd "$(dirname "$0")/.." && pwd)   # deploy/vm of the staging checkout
cd "$HERE"
PROJECT=commonly-staging
compose() { docker compose -p "$PROJECT" -f docker-compose.yml -f staging/compose.staging.yml "$@"; }

die() { echo "staging: $*" >&2; exit 1; }

# The prod checkout must never be the one running this: same files, wrong project data.
[ "$HERE" != "/opt/commonly/deploy/vm" ] || die "refusing to run from the prod checkout"
[ -f .env ] || die "no .env in $HERE (see docs/deployment/vm-staging.md, First setup)"

# Drop staging's old image tags so a merge a day can't fill the disk. Keeps the
# current staging tag and every tag any prod .env or .env backup names (prod's
# live tag and its rollbacks); an image a container still uses is never removed.
prune_images() {
  cur=$(sed -n 's/^COMMONLY_IMAGE_TAG=//p' .env)
  keep=$(cat /opt/commonly/deploy/vm/.env /opt/commonly/deploy/vm/.env.bak-* 2>/dev/null | sed -n 's/^COMMONLY_IMAGE_TAG=//p' | sort -u)
  docker image ls --format '{{.Repository}}:{{.Tag}}' \
    | grep -E '/commonly-(backend|bot|frontend):[0-9a-f]{8}(-staging)?$' \
    | while read -r ref; do
        t=${ref##*:}; t=${t%-staging}
        [ "$t" = "$cur" ] && continue
        printf '%s\n' "$keep" | grep -qx "$t" && continue
        docker image rm "$ref" >/dev/null 2>&1 || true
      done
}

case "${1:-}" in
  up)
    TAG=${2:-}
    printf '%s' "$TAG" | grep -Eq '^[0-9a-f]{8}$' || die "up needs an 8-character image tag"
    sed -i "s/^COMMONLY_IMAGE_TAG=.*/COMMONLY_IMAGE_TAG=$TAG/" .env
    compose pull -q
    # --wait: every service with a healthcheck must report healthy. litellm's boot
    # check is the slow one under staging's CPU cap.
    compose up -d --wait --wait-timeout 600 --remove-orphans
    for i in $(seq 1 30); do
      if compose exec -T backend curl -fsS -o /dev/null http://localhost:5000/api/health/ready; then
        echo "staging up at $TAG"; compose ps --format '{{.Service}} {{.Status}}'; exit 0
      fi
      sleep 5
    done
    die "backend not ready after up"
    ;;
  journey)
    compose --profile jobs run --rm --no-deps stranger-journey
    ;;
  down)
    compose down --remove-orphans
    prune_images
    ;;
  status)
    compose ps --format '{{.Service}} {{.Status}}'
    ;;
  *)
    die "usage: staging.sh up <tag> | journey | down | status"
    ;;
esac
