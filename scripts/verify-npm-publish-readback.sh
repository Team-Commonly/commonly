#!/usr/bin/env bash
#
# Poll the registry until it serves exactly the version this run just published.
#
# Earned 2026-09-23 (TASK-100). cli 0.1.65 (run 35498255344) and cli 0.1.66 (run
# 35804128707) both published FINE — `npm view <pkg> version` moved, `npx
# @commonlyai/cli --version` returned the new version — and the workflow went red
# anyway, because the read-back gave up after ~60s. The registry's own docs put
# propagation at "a few minutes", so a fixed one-minute window turns a good
# publish into a red run. That is worse than a miss: a check that is red on a
# known-good outcome is the stale signal reviewers learn to ignore, and the next
# red — the one that means the publish never landed — gets read the same way.
#
# The cost of the wider window is paid only by the pushes that actually publish
# (most pushes are "registry already equal" and never reach here), so it is at
# most ~4 extra minutes on a release, and zero on everything else.
#
# On exhaustion this names what the registry DID serve (dist-tags and latest)
# alongside the version that never appeared. A read-back that can only report
# the value it was looking for cannot distinguish "propagation is still slow"
# from "the publish silently did not happen" or "the token has no read access" —
# the same false negative one layer down.
#
# Env:
#   NAME                            package name, e.g. @commonlyai/cli   (required)
#   WANT                            the version just published           (required)
#   READBACK_TIMEOUT_SECONDS        total budget, default 300
#   READBACK_INTERVAL_SECONDS       gap between polls, default 10
#
# Exits 0 once the registry serves NAME@WANT; 1 if the budget runs out. Never
# exits 0 on a value it did not read.

set -euo pipefail

: "${NAME:?NAME is required (package name, e.g. @commonlyai/cli)}"
: "${WANT:?WANT is required (the version just published)}"
TIMEOUT_SECONDS="${READBACK_TIMEOUT_SECONDS:-300}"
INTERVAL_SECONDS="${READBACK_INTERVAL_SECONDS:-10}"

# `npm view` reads the package named on the command line, so this is
# cwd-independent on purpose: the publish job runs it with working-directory set
# to the package dir, and a test harness runs it from anywhere.
stderr_file=$(mktemp)
trap 'rm -f "$stderr_file"' EXIT

elapsed=0
attempt=0
while :; do
  attempt=$((attempt + 1))
  got=$(npm view "$NAME@$WANT" version 2>"$stderr_file" || true)

  if [ "$got" = "$WANT" ]; then
    echo "✓ $NAME@$WANT is live (attempt $attempt, ${elapsed}s after publish)"
    exit 0
  fi

  if [ "$elapsed" -ge "$TIMEOUT_SECONDS" ]; then
    break
  fi

  echo "· $NAME@$WANT not visible yet (attempt $attempt, ${elapsed}s; got '${got:-<empty>}') — retrying in ${INTERVAL_SECONDS}s"
  sleep "$INTERVAL_SECONDS"
  elapsed=$((elapsed + INTERVAL_SECONDS))
done

echo "::error::$NAME@$WANT is not visible on the registry after ${TIMEOUT_SECONDS}s (${attempt} attempt(s)). The publish step reported success, so check what the registry is actually serving below before re-running."
echo "--- what the registry serves for $NAME ---"
echo "dist-tags: $(npm view "$NAME" dist-tags --json 2>&1 | tr -d '\n' || true)"
echo "latest:    $(npm view "$NAME" version 2>&1 | tr -d '\n' || true)"
echo "--- last error from: npm view $NAME@$WANT version ---"
if [ -s "$stderr_file" ]; then
  cat "$stderr_file"
else
  echo "(npm view wrote nothing to stderr — read error, or an empty response)"
fi
exit 1
