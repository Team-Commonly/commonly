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
# On exhaustion this names what the registry DID serve (the version document
# it read, plus the packument's dist-tags and latest) alongside the version that
# never appeared. A read-back that can only report the value it was looking for
# cannot distinguish "propagation is still slow" from "the publish silently did
# not happen" or "the token has no read access" — the same false negative one
# layer down.
#
# The registry read is the VERSION DOCUMENT, not the packument (TASK-115).
# `npm view <pkg>@<version> version` fetches the whole packument — 130KB for
# @commonlyai/cli — and filters locally, and that endpoint is served through a
# CDN with `cache-control: public, max-age=300`: a copy cached moments before
# the publish stays stale for almost exactly as long as this loop is willing to
# wait (the budget default is also 300s), which showed up as 31 E404s followed
# by success with no propagation delay involved (Vera 71761-71763: the cache
# headers, the 300s/300s coincidence, and the endpoint). The
# version document is `cf-cache-status: DYNAMIC` — not edge-cached at all,
# 2.4KB — so it answers the question this check actually means to ask. `curl`
# also sidesteps the runner's local npm cache, which `--prefer-online` only
# papers over, and a 404 there is genuinely "not published yet", so the retry
# loop still earns its place for real propagation.
#
# Env:
#   NAME                            package name, e.g. @commonlyai/cli   (required)
#   WANT                            the version just published           (required)
#   READBACK_TIMEOUT_SECONDS        total wall-clock budget, default 300
#   READBACK_INTERVAL_SECONDS       gap between polls, default 10
#   READBACK_REGISTRY_URL           registry base, default https://registry.npmjs.org
#
# `node` on PATH: the version document is parsed as JSON. The publish job already
# guarantees it (`actions/setup-node` at npm-publish.yml:69 runs before this), and
# the stub-driven tests never reach it — but this is the one script that runs
# after a publish has already happened, so its dependencies belong here.
#
# The budget is measured on a CLOCK, not by adding up the gaps. Summing the
# intervals made the budget depend on an env var the caller controls: at
# READBACK_INTERVAL_SECONDS=0 the loop could never reach the timeout (789
# attempts in 8s, still reporting 0s, killed by an external alarm — Vera 71347),
# and at any interval it undercounted by every `npm view` round-trip, so the
# "after 300s" in the failure line was not what happened. Both matter here: this
# runs inside a release job, where a loop that cannot terminate is not a red step
# but a run held to the six-hour limit.
#
# Exits 0 once the registry serves NAME@WANT; 1 if the budget runs out. Never
# exits 0 on a value it did not read.

set -euo pipefail

: "${NAME:?NAME is required (package name, e.g. @commonlyai/cli)}"
: "${WANT:?WANT is required (the version just published)}"
TIMEOUT_SECONDS="${READBACK_TIMEOUT_SECONDS:-300}"
INTERVAL_SECONDS="${READBACK_INTERVAL_SECONDS:-10}"

# The version document, not the packument: `npm view` reads the package named
# on the command line, so the old form was cwd-independent on purpose — the
# publish job runs this with working-directory set to the package dir, and a
# test harness runs it from anywhere. A URL is cwd-independent by construction.
# The name is percent-encoded because a scoped name contains a path separator;
# both forms answer, and the encoded one is the shape the measurement above was
# taken on.
REGISTRY_URL="${READBACK_REGISTRY_URL:-https://registry.npmjs.org}"
DOC_URL="$REGISTRY_URL/$(printf '%s' "$NAME" | sed 's|/|%2f|g')/$WANT"

stderr_file=$(mktemp)
trap 'rm -f "$stderr_file"' EXIT

started_at=$(date +%s)
attempt=0
body=''
while :; do
  attempt=$((attempt + 1))
  body=$(curl -fsS "$DOC_URL" 2>"$stderr_file" || true)
  # `-f` keeps a 404 body out of the parse: the registry answers a missing
  # version with the plain text `"version not found: 9.9.9"`, which is not JSON,
  # so a read that fails is an empty value rather than a confusing one.
  got=$(printf '%s' "$body" | node -p 'JSON.parse(require("fs").readFileSync(0, "utf8")).version ?? ""' 2>/dev/null || true)
  elapsed=$(( $(date +%s) - started_at ))

  if [ "$got" = "$WANT" ]; then
    echo "✓ $NAME@$WANT is live (attempt $attempt, ${elapsed}s after publish)"
    exit 0
  fi

  if [ "$elapsed" -ge "$TIMEOUT_SECONDS" ]; then
    break
  fi

  echo "· $NAME@$WANT not visible yet (attempt $attempt, ${elapsed}s; got '${got:-<empty>}') — retrying in ${INTERVAL_SECONDS}s"
  sleep "$INTERVAL_SECONDS"
done

echo "::error::$NAME@$WANT is not visible on the registry after ${TIMEOUT_SECONDS}s (${attempt} attempt(s)) at GET $DOC_URL. The publish step reported success, so check what the registry is actually serving below before re-running."
echo "--- what the registry serves for $NAME ---"
echo "version document (the endpoint this poll reads, uncached): $(printf '%s' "$body" | head -c 400)"
echo "dist-tags: $(npm view "$NAME" dist-tags --json 2>&1 | tr -d '\n' || true)"
echo "latest:    $(npm view "$NAME" version 2>&1 | tr -d '\n' || true)"
echo "(the two lines above are PACKUMENT reads — edge-cached up to 300s, so they can lag a just-published version by themselves)"
echo "--- last error from: curl -fsS $DOC_URL ---"
if [ -s "$stderr_file" ]; then
  cat "$stderr_file"
else
  echo "(curl wrote nothing to stderr — read error, or an empty response)"
fi
exit 1
