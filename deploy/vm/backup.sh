#!/bin/sh
# Nightly Postgres and MongoDB backups to an S3-compatible bucket (Cloudflare R2).
# Runs in the pg-backup service of deploy/vm/docker-compose.yml, on the same
# postgres image as the database, so pg_dump matches the server's major version.
#
#   commonly-backup loop    wait for BACKUP_HOUR_UTC, back up, repeat (the service)
#   commonly-backup once    one backup now, then exit
#   commonly-backup pg-once one Postgres-only backup now, then exit
#   commonly-backup check   healthy while the last success, or the service's
#                           start, is under 26 hours old
#   commonly-backup list    list stored backups
#   commonly-backup fetch <path>   stream one stored backup to stdout
#
# Objects land at <bucket>/<prefix>/postgres/postgres-<UTC stamp>.dump (pg_dump -Fc)
# and <bucket>/<prefix>/mongodb/mongodb-<UTC stamp>.archive.gz (mongodump --archive
# --gzip). Old objects are pruned only after a night where both dumps passed
# their content checks and uploaded. Nothing here prints a credential.
#
# BACKUP_PG_EVERY_HOURS (0 = off) adds Postgres-only dumps between the nightly
# runs, at each multiple of that many hours UTC. They land beside the nightly
# dumps, the nightly prune ages them out on the same retention, and they never
# touch the success stamp: health still means "a full backup in 26 hours".
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

# Validate the command before reading any configuration or installing tools.
# A bare call used to default to `loop`, so running `commonly-backup` by hand
# inside the container to read its usage started a second backup loop beside
# the entrypoint's (2026-11-18). Compose passes `loop` explicitly.
USAGE="usage: commonly-backup loop|once|pg-once|check|list|fetch <path>"
case "${1:-}" in
  loop|once|pg-once|check|list|fetch) ;;
  *) echo "$USAGE" >&2; exit 2 ;;
esac

if [ "$1" = "check" ]; then check; exit 0; fi

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
PG_EVERY="${BACKUP_PG_EVERY_HOURS:-0}"
case "$PG_EVERY" in ''|*[!0-9]*) fail "BACKUP_PG_EVERY_HOURS must be a whole number of hours, 0 for off" ;; esac
PG_EVERY=$(printf '%s' "$PG_EVERY" | sed 's/^0*//')
PG_EVERY=${PG_EVERY:-0}
[ "$PG_EVERY" -le 24 ] || fail "BACKUP_PG_EVERY_HOURS must be 0 to 24"

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

# Dump, check and upload one Postgres backup. Returns 1 on any failure.
# Every step is checked by hand: callers run on the left of `||`, where
# `set -e` does not apply.
backup_postgres() {
  if ! PGPASSWORD="$PG_ADMIN_PASSWORD" pg_dump -h "${PGHOST:-postgres}" -U "$PG_ADMIN_USER" \
      -d "$PG_DATABASE" -Fc -f "$1"; then
    echo "postgres dump FAILED"; return 1
  elif ! pg_restore -l "$1" | grep -q ' TABLE DATA '; then
    echo "postgres dump has no table data; not uploaded"; return 1
  elif ! rclone copyto "$1" "$REMOTE/postgres/postgres-$2.dump"; then
    echo "postgres upload FAILED"; return 1
  fi
  echo "postgres backup uploaded: $PREFIX/postgres/postgres-$2.dump"
}

# A Postgres-only run: no MongoDB dump, no prune, no success stamp.
backup_pg_only() {
  stamp=$(date -u +%Y%m%d-%H%M%S)
  work=$(mktemp -d)
  rc=0
  backup_postgres "$work/postgres-$stamp.dump" "$stamp" || rc=1
  rm -rf "$work"
  return "$rc"
}

# Every step is checked by hand: this runs on the left of `||` in the loop,
# where `set -e` does not apply.
backup_once() {
  stamp=$(date -u +%Y%m%d-%H%M%S)
  work=$(mktemp -d)
  pg_file="$work/postgres-$stamp.dump"
  mongo_file="$work/mongodb-$stamp.archive.gz"
  ok=1

  backup_postgres "$pg_file" "$stamp" || ok=0

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

# Both waits take one clock reading from the caller, so a tie stays a tie.
seconds_until_next_run() {
  now=$1
  wait=$(( (HOUR * 3600 - now % 86400 + 86400) % 86400 ))
  [ "$wait" -eq 0 ] && wait=86400
  echo "$wait"
}

# Seconds to the next multiple of PG_EVERY hours UTC; only called when PG_EVERY > 0.
seconds_until_next_pg() {
  period=$(( PG_EVERY * 3600 ))
  wait=$(( period - $1 % period ))
  echo "$wait"
}

# Stamp the loop's start before installing tools, so a slow install can't fail
# the first health checks.
if [ "$1" = loop ]; then date -u +%s > "$START_STAMP"; fi
install_tools
case "$1" in
  once) backup_once ;;
  pg-once) backup_pg_only ;;
  list) rclone lsl "$REMOTE" ;;
  fetch) rclone cat "$REMOTE/${2:?usage: commonly-backup fetch <path under the prefix>}" ;;
  loop)
    nightly_due=0
    while :; do
      now=$(date -u +%s)
      # A Postgres-only run that overran the nightly slot must not skip that
      # night: run the full backup now, whether or not the Postgres run passed.
      if [ "$nightly_due" -gt 0 ] && [ "$now" -ge "$nightly_due" ]; then
        nightly_due=0
        echo "nightly slot passed during a postgres-only run; backing up now"
        backup_once || echo "backup run failed; next attempt tomorrow"
        continue
      fi
      wait=$(seconds_until_next_run "$now")
      nightly_due=$(( now + wait ))
      # A Postgres-only slot that falls before the nightly run goes first. When
      # both fall at the same moment the nightly run wins, since it dumps Postgres too.
      pg_wait=0
      [ "$PG_EVERY" -gt 0 ] && pg_wait=$(seconds_until_next_pg "$now")
      if [ "$pg_wait" -gt 0 ] && [ "$pg_wait" -lt "$wait" ]; then
        wait=$pg_wait
        echo "next postgres-only backup in ${wait}s"
        sleep "$wait"
        backup_pg_only || echo "postgres-only backup failed; next attempt at the next slot"
        continue
      fi
      echo "next backup in ${wait}s (${HOUR}:00 UTC)"
      sleep "$wait"
      nightly_due=0
      backup_once || echo "backup run failed; next attempt tomorrow"
    done
    ;;
  *) echo "$USAGE" >&2; exit 2 ;;
esac
