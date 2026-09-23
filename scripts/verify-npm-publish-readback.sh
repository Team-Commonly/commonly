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
# A published version is not the same as a MOVED TAG (TASK-116). `latest` comes
# from the dist-tags document, a third read again — and also uncached
# (`cf-cache-status: DYNAMIC`, 19 bytes) — so a publish that lands without moving
# `latest` is a different defect from a version that never appeared. It is
# assertable here because nothing in this repo publishes with `--tag`: there is
# one `npm publish --provenance --access public` (npm-publish.yml:143) and
# neither package sets `publishConfig.tag`. That is why the assertion is exact
# rather than pre-weakened for a prerelease shape we do not ship — and it is the
# assertion that will say so the day someone adds one.
#
# Both claims are made INSIDE the poll loop, and only exhaustion is a failure.
# One publish writes two documents and nothing here has measured that they become
# visible at the same instant, so a version that is live while `latest` still
# points at the previous one is a RETRY, not a red — failing on the first read is
# the defect class this very row removed (a check red on a good publish is the
# stale signal reviewers learn to ignore). Same for a dist-tags read that does
# not answer: a public package answers this anonymously, so a non-200 sustained
# for the whole budget is a finding and a non-200 on one read is not.
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
ENCODED_NAME="$(printf '%s' "$NAME" | sed 's|/|%2f|g')"
DOC_URL="$REGISTRY_URL/$ENCODED_NAME/$WANT"
# The tag is a second document: asking the version document which version exists
# cannot answer which version `latest` points at.
DIST_TAGS_URL="$REGISTRY_URL/-/package/$ENCODED_NAME/dist-tags"

stderr_file=$(mktemp)
tag_file=$(mktemp)
tag_err=$(mktemp)
trap 'rm -f "$stderr_file" "$tag_file" "$tag_err"' EXIT

# Read `latest` from the uncached dist-tags document. Echoes the tag (empty when
# there is none) and leaves the HTTP status in DT_STATUS, because the three
# outcomes are genuinely different findings and must not collapse into one:
#   200 + the published version -> the tag moved
#   200 + anything else        -> published, tag did not move
#   anything else              -> the document could not be read at all, so the
#                                 check cannot claim the tag moved. A public
#                                 package answers this anonymously (a name the
#                                 registry will not serve answers 401, not 404),
#                                 so a non-200 here is itself the finding.
# The status rides a FILE, not a variable: `latest=$(read_latest_tag)` is a
# subshell, so a variable assigned inside would never reach the caller — which is
# exactly how the first draft of this read a 401 as an empty tag.
tag_status_file=$(mktemp)
trap 'rm -f "$stderr_file" "$tag_file" "$tag_err" "$tag_status_file"' EXIT
read_latest_tag() {
  status=$(curl -sS -o "$tag_file" -w '%{http_code}' "$DIST_TAGS_URL" 2>"$tag_err" || true)
  printf '%s' "$status" > "$tag_status_file"
  if [ "$status" != "200" ]; then
    return 0
  fi
  node -p 'JSON.parse(require("fs").readFileSync(0, "utf8")).latest ?? ""' < "$tag_file" 2>/dev/null || true
}
tag_status() { cat "$tag_status_file"; }

started_at=$(date +%s)
attempt=0
body=''
# The LAST tag state seen, so the exhaustion message names which claim failed
# instead of collapsing three findings into one. `''` = the version was never
# served at all.
last_tag=''
last_tag_state=''
while :; do
  attempt=$((attempt + 1))
  body=$(curl -fsS "$DOC_URL" 2>"$stderr_file" || true)
  # `-f` keeps a 404 body out of the parse: the registry answers a missing
  # version with the plain text `"version not found: 9.9.9"`, which is not JSON,
  # so a read that fails is an empty value rather than a confusing one.
  got=$(printf '%s' "$body" | node -p 'JSON.parse(require("fs").readFileSync(0, "utf8")).version ?? ""' 2>/dev/null || true)
  elapsed=$(( $(date +%s) - started_at ))

  if [ "$got" = "$WANT" ]; then
    latest=$(read_latest_tag)
    tag_st=$(tag_status)
    last_tag="$latest"
    if [ "$tag_st" != "200" ]; then
      last_tag_state="unreadable"
    elif [ "$latest" = "$WANT" ]; then
      # Both claims held together, inside the budget: this is what success means.
      echo "✓ $NAME@$WANT is live and latest points at it (attempt $attempt, ${elapsed}s after publish)"
      exit 0
    else
      last_tag_state="behind"
    fi
  fi

  if [ "$elapsed" -ge "$TIMEOUT_SECONDS" ]; then
    break
  fi

  if [ "$last_tag_state" = "behind" ]; then
    echo "· $NAME@$WANT is live and latest still points at '${last_tag:-<empty>}' (attempt $attempt, ${elapsed}s) — retrying in ${INTERVAL_SECONDS}s"
  elif [ "$last_tag_state" = "unreadable" ]; then
    echo "· $NAME@$WANT is live and the dist-tags document did not answer (HTTP $(tag_status), attempt $attempt, ${elapsed}s) — retrying in ${INTERVAL_SECONDS}s"
  else
    echo "· $NAME@$WANT not visible yet (attempt $attempt, ${elapsed}s; got '${got:-<empty>}') — retrying in ${INTERVAL_SECONDS}s"
  fi
  sleep "$INTERVAL_SECONDS"
done

diagnose() {
  echo "--- what the registry serves for $NAME ---"
  echo "version document (the endpoint this poll reads, uncached): $(printf '%s' "$body" | head -c 400)"
  echo "dist-tags (uncached, the endpoint the tag check reads): latest=$(read_latest_tag) [HTTP $(tag_status)]"
  if [ "$(tag_status)" != "200" ] && [ -s "$tag_err" ]; then
    echo "  (dist-tags read failed: $(tr -d '\n' < "$tag_err"))"
  fi
  echo "what a cached npm client may still serve (PACKUMENT, edge-cached up to 300s, so it can lag a just-published version by itself): $(npm view "$NAME" version 2>&1 | tr -d '\n' || true)"
  echo "--- last error from: curl -fsS $DOC_URL ---"
  if [ -s "$stderr_file" ]; then
    cat "$stderr_file"
  else
    echo "(curl wrote nothing to stderr — read error, or an empty response)"
  fi
}

# Which claim was still outstanding when the budget ran out decides the message.
# The version being absent, the tag being behind, and the tag being unreadable are
# three findings, and a red run that conflates them sends the reader to the wrong
# place.
if [ "$last_tag_state" = "behind" ]; then
  echo "::error::$NAME@$WANT is live, but latest still pointed at '${last_tag:-<empty>}' after ${TIMEOUT_SECONDS}s (${attempt} attempt(s)) at GET $DIST_TAGS_URL — the version is published and the tag did NOT move. This is not 'not published yet': the version document served $WANT. This repo publishes without --tag (npm-publish.yml:143), so latest is expected to move; check for a publish that used one, or a visibility change."
  diagnose
  exit 1
fi
if [ "$last_tag_state" = "unreadable" ]; then
  echo "::error::$NAME@$WANT is live, but the dist-tags document did not answer for ${TIMEOUT_SECONDS}s (${attempt} attempt(s), last HTTP $(tag_status) at GET $DIST_TAGS_URL), so the check cannot confirm that latest moved. A published package answers this anonymously (a name the registry will not serve answers 401, not 404), so a sustained non-200 is itself the finding: check the publish's visibility (--access) before re-running."
  diagnose
  exit 1
fi
echo "::error::$NAME@$WANT is not visible on the registry after ${TIMEOUT_SECONDS}s (${attempt} attempt(s)) at GET $DOC_URL. The publish step reported success, so check what the registry is actually serving below before re-running."
diagnose
exit 1
