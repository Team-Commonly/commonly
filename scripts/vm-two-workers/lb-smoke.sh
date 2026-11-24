#!/usr/bin/env bash
# Runs deploy/vm/api-lb/nginx.conf, in its pinned image and under the compose
# file's lockdown, in front of two stand-in backends, and checks stickiness,
# header passthrough and failover (lb-check.py). Needs only Docker; pulls
# nginx and python images, builds nothing. Cleans up after itself.
#
#   bash scripts/vm-two-workers/lb-smoke.sh
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
nginx_image="$(sed -n 's/^    image: \(nginx:[^ ]*\)$/\1/p' "$repo/deploy/vm/docker-compose.yml")"
python_image="python:3.12-alpine"
[ -n "$nginx_image" ] || { echo "api-lb's image not found in the compose file" >&2; exit 1; }

net="lb-smoke-$$"
state="$(mktemp -d)"
chmod 777 "$state"
cleanup() {
  docker rm -f "$net-backend" "$net-backend-2" "$net-lb" >/dev/null 2>&1 || true
  docker network rm "$net" >/dev/null 2>&1 || true
  rm -rf "$state"
}
trap cleanup EXIT

docker network create "$net" >/dev/null

backend() { # <name> [MODE]
  docker run -d --name "$net-$1" --network "$net" --network-alias "$1" \
    -e "NAME=$1" -e "MODE=${2:-ok}" \
    -v "$here/echo-backend.py:/srv/echo-backend.py:ro" \
    "$python_image" python3 -I /srv/echo-backend.py >/dev/null
}
check() { # <phase>
  docker run --rm --network "$net" \
    -v "$here/lb-check.py:/srv/lb-check.py:ro" -v "$state:/state" \
    "$python_image" python3 -I /srv/lb-check.py "$1"
}

backend backend
backend backend-2
docker run -d --name "$net-lb" --network "$net" --network-alias api-lb \
  --read-only --tmpfs /var/cache/nginx --tmpfs /var/run \
  --cap-drop ALL --cap-add CHOWN --cap-add SETGID --cap-add SETUID \
  --security-opt no-new-privileges:true \
  -v "$repo/deploy/vm/api-lb/nginx.conf:/etc/nginx/nginx.conf:ro" \
  "$nginx_image" >/dev/null

for _ in $(seq 1 30); do
  if docker exec "$net-lb" wget -q -O /dev/null http://127.0.0.1:5000/lb-health 2>/dev/null; then break; fi
  sleep 1
done

echo "== both backends up"
check spread

echo "== backend-2 stopped"
docker rm -f "$net-backend-2" >/dev/null
check down

echo "== backend-2 back, answering 503 (draining)"
backend backend-2 503
# Docker DNS and nginx's resolver (valid=5s) pick the new container up.
sleep 7
check draining

echo "lb-smoke: all checks passed"
