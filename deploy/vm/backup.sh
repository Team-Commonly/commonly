#!/bin/sh
# Nightly Postgres and MongoDB backups to an S3-compatible bucket (Cloudflare R2).
# Runs in the pg-backup service of deploy/vm/docker-compose.yml, on the same
# postgres image as the database, so pg_dump matches the server's major version.
#
#   commonly-backup loop    wait for BACKUP_HOUR_UTC, back up, repeat (the service)
#   commonly-backup once    one backup now, then exit
#   commonly-backup check   healthy while the last success, or the service's
#                           start, is under 26 hours old
#   commonly-backup list    list stored backups
#   commonly-backup fetch <path>   stream one stored backup to stdout
#
# Objects land at <bucket>/<prefix>/postgres/postgres-<UTC stamp>.dump (pg_dump -Fc)
# and <bucket>/<prefix>/mongodb/mongodb-<UTC stamp>.archive.gz (mongodump --archive
# --gzip). Old objects are pruned only after a night where both dumps passed
# their content checks and uploaded. Nothing here prints a credential.
set -eu

STATE_DIR=/var/lib/commonly-backup
SUCCESS_STAMP="$STATE_DIR/last-success"
START_STAMP=/tmp/commonly-backup-started
MAX_AGE_SECONDS=93600

fail() { echo "commonly-backup: $*" >&2; exit 1; }

stamp_age() { echo $(( $(date -u +%s) - $(cat "$1") )); }

check() {
  newest=""
  for f in "$SUCCESS_STAMP" "$START_STAMP"; do
    [ -f "$f" ] || continue
    age=$(stamp_age "$f")
    if [ -z "$newest" ] || [ "$age" -lt "$newest" ]; then newest=$age; fi
  done
  [ -n "$newest" ] || fail "no successful backup and no service start recorded"
  [ "$newest" -lt "$MAX_AGE_SECONDS" ] || fail "no successful backup in ${newest}s"
  echo "ok: newest stamp ${newest}s old"
}

if [ "${1:-loop}" = "check" ]; then check; exit 0; fi

: "${PG_ADMIN_USER:?}" "${PG_ADMIN_PASSWORD:?}" "${PG_DATABASE:?}" "${MONGO_URI:?}"
: "${BACKUP_S3_ENDPOINT:?}" "${BACKUP_S3_BUCKET:?}"
: "${BACKUP_S3_ACCESS_KEY_ID:?}" "${BACKUP_S3_SECRET_ACCESS_KEY:?}"
PREFIX="${BACKUP_S3_PREFIX:-commonly}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
MONGO_MIN_BYTES="${BACKUP_MONGO_MIN_BYTES:-65536}"

# The prune below deletes under the prefix, so it must be a real sub-path:
# not empty, absolute, ".", "./", "..", or holding an empty or dot segment.
case "/$PREFIX/" in
  //|//*|*//*|*/./*|*/../*) fail "BACKUP_S3_PREFIX must be a relative path with no empty, . or .. segment" ;;
esac
case "$RETENTION_DAYS" in ''|*[!0-9]*) fail "BACKUP_RETENTION_DAYS must be a whole number of days" ;; esac
[ "$RETENTION_DAYS" -ge 1 ] || fail "BACKUP_RETENTION_DAYS must be at least 1"
case "$MONGO_MIN_BYTES" in ''|*[!0-9]*) fail "BACKUP_MONGO_MIN_BYTES must be a whole number" ;; esac
HOUR="${BACKUP_HOUR_UTC:-2}"
case "$HOUR" in ''|*[!0-9]*) fail "BACKUP_HOUR_UTC must be an hour, 0 to 23" ;; esac
HOUR=$(printf '%s' "$HOUR" | sed 's/^0*//')
HOUR=${HOUR:-0}
[ "$HOUR" -le 23 ] || fail "BACKUP_HOUR_UTC must be an hour, 0 to 23"

# rclone reads its remote from the environment; nothing is written to disk.
export RCLONE_CONFIG=/dev/null
export RCLONE_CONFIG_BUCKET_TYPE=s3
export RCLONE_CONFIG_BUCKET_PROVIDER=Cloudflare
export RCLONE_CONFIG_BUCKET_ENDPOINT="$BACKUP_S3_ENDPOINT"
export RCLONE_CONFIG_BUCKET_ACCESS_KEY_ID="$BACKUP_S3_ACCESS_KEY_ID"
export RCLONE_CONFIG_BUCKET_SECRET_ACCESS_KEY="$BACKUP_S3_SECRET_ACCESS_KEY"
# An R2 token scoped to one bucket cannot create buckets; skip the check.
export RCLONE_CONFIG_BUCKET_NO_CHECK_BUCKET=true
REMOTE="bucket:${BACKUP_S3_BUCKET}/${PREFIX}"

install_tools() {
  if ! command -v mongodump >/dev/null 2>&1 || ! command -v rclone >/dev/null 2>&1; then
    apk add --no-cache --quiet mongodb-tools rclone || fail "could not install mongodb-tools and rclone"
  fi
}

# Every step is checked by hand: this runs on the left of `||` in the loop,
# where `set -e` does not apply.
backup_once() {
  stamp=$(date -u +%Y%m%d-%H%M%S)
  work=$(mktemp -d)
  pg_file="$work/postgres-$stamp.dump"
  mongo_file="$work/mongodb-$stamp.archive.gz"
  ok=1

  if ! PGPASSWORD="$PG_ADMIN_PASSWORD" pg_dump -h "${PGHOST:-postgres}" -U "$PG_ADMIN_USER" \
      -d "$PG_DATABASE" -Fc -f "$pg_file"; then
    echo "postgres dump FAILED"; ok=0
  elif ! pg_restore -l "$pg_file" | grep -q ' TABLE DATA '; then
    echo "postgres dump has no table data; not uploaded"; ok=0
  elif ! rclone copyto "$pg_file" "$REMOTE/postgres/postgres-$stamp.dump"; then
    echo "postgres upload FAILED"; ok=0
  else
    echo "postgres backup uploaded: $PREFIX/postgres/postgres-$stamp.dump"
  fi

  # The URI goes in a 0600 config file, not argv, where ps would show it.
  mongo_conf="$work/mongodump.yaml"
  (umask 077 && printf "uri: '%s'\n" "$(printf '%s' "$MONGO_URI" | sed "s/'/''/g")" > "$mongo_conf")
  if ! mongodump --config="$mongo_conf" --archive="$mongo_file" --gzip --quiet; then
    echo "mongodb dump FAILED"; ok=0
  elif [ "$(wc -c < "$mongo_file")" -lt "$MONGO_MIN_BYTES" ]; then
    echo "mongodb archive is under ${MONGO_MIN_BYTES} bytes; not uploaded"; ok=0
  elif ! rclone copyto "$mongo_file" "$REMOTE/mongodb/mongodb-$stamp.archive.gz"; then
    echo "mongodb upload FAILED"; ok=0
  else
    echo "mongodb backup uploaded: $PREFIX/mongodb/mongodb-$stamp.archive.gz"
  fi
  rm -rf "$work"

  [ "$ok" -eq 1 ] || { echo "backup incomplete: nothing pruned"; return 1; }
  if ! rclone delete "$REMOTE" --min-age "${RETENTION_DAYS}d"; then
    echo "prune FAILED"; return 1
  fi
  mkdir -p "$STATE_DIR"
  date -u +%s > "$SUCCESS_STAMP"
  echo "backup complete; pruned objects older than ${RETENTION_DAYS} days"
}

seconds_until_next_run() {
  now=$(date -u +%s)
  wait=$(( (HOUR * 3600 - now % 86400 + 86400) % 86400 ))
  [ "$wait" -eq 0 ] && wait=86400
  echo "$wait"
}

# Stamp the loop's start before installing tools, so a slow install can't fail
# the first health checks.
if [ "${1:-loop}" = loop ]; then date -u +%s > "$START_STAMP"; fi
install_tools
case "${1:-loop}" in
  once) backup_once ;;
  list) rclone lsl "$REMOTE" ;;
  fetch) rclone cat "$REMOTE/${2:?usage: commonly-backup fetch <path under the prefix>}" ;;
  loop)
    while :; do
      wait=$(seconds_until_next_run)
      echo "next backup in ${wait}s (${HOUR}:00 UTC)"
      sleep "$wait"
      backup_once || echo "backup run failed; next attempt tomorrow"
    done
    ;;
  *) echo "usage: commonly-backup loop|once|check|list|fetch <path>"; exit 2 ;;
esac
