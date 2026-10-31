#!/usr/bin/env bash
# Gate verdict for one PR head (TASK-595). The policy is docs/development/external-review.md.
#
# Passes when every changed file is docs or test code (Tier 0), or when the gate account
# has a review at the exact head whose last line is `GATE: PASS` and the latest verdict at
# that head is that PASS. Anything else fails, including an API error.
#
# Env: REPO (owner/name), PR_NUMBER, HEAD_SHA, GH_TOKEN (pull-requests: read).
# Optional: GATE_REVIEWER (default lilyshen0722), the account seat verdicts are posted from.
set -euo pipefail

: "${REPO:?set REPO}" "${PR_NUMBER:?set PR_NUMBER}" "${HEAD_SHA:?set HEAD_SHA}"
export GATE_REVIEWER="${GATE_REVIEWER:-lilyshen0722}" HEAD_SHA

# Tier 0 is docs and test files only. Dot-directories never count as docs: .github,
# .claude and .agents hold workflows and agent skills, which change behaviour.
EXEMPT_RE='^(docs/([^/]+/)*[^/]+\.(md|mdx|txt|png|jpe?g|gif|svg|webp)|([^./][^/]*/)*[^/]+\.(md|mdx)|([^./][^/]*/)*__tests__/([^/]+/)*[^/]+|([^./][^/]*/)*[^/]+\.(test|spec)\.[cm]?[jt]sx?)$'

files="$(gh api --paginate "repos/$REPO/pulls/$PR_NUMBER/files" --jq '.[].filename')"
if [ -n "$files" ] && [ -z "$(printf '%s\n' "$files" | grep -Ev "$EXEMPT_RE" || true)" ]; then
  echo "✓ Tier 0: every changed file is docs or test code, so no seat gate is needed"
  exit 0
fi

# One line per review by the gate account at this head: "<id>\t<submitted_at>\t<last non-blank line>".
# Pending and dismissed reviews don't count. The text decides the verdict, not the review state.
verdicts="$(gh api --paginate "repos/$REPO/pulls/$PR_NUMBER/reviews" --jq '
  .[]
  | select((.user.login | ascii_downcase) == ($ENV.GATE_REVIEWER | ascii_downcase))
  | select(.commit_id == $ENV.HEAD_SHA and .state != "PENDING" and .state != "DISMISSED")
  | [.id, .submitted_at, ((.body // "") | split("\n") | map(sub("\\s+$"; "")) | map(select(length > 0)) | (last // ""))]
  | @tsv')"

# Review ids rise with creation, so the highest id is the latest verdict. A FAIL after a PASS blocks it.
latest="$(printf '%s\n' "$verdicts" | awk -F '\t' '$3 ~ /^GATE: (PASS|FAIL)$/' | sort -t $'\t' -k1,1n | tail -n 1)"
review_id="${latest%%$'\t'*}"
verdict="${latest##*$'\t'}"

if [ "$verdict" = "GATE: PASS" ]; then
  echo "✓ $GATE_REVIEWER: GATE: PASS at $HEAD_SHA (review $review_id)"
  exit 0
fi

if [ -z "$latest" ]; then
  why="no GATE verdict from $GATE_REVIEWER at $HEAD_SHA"
else
  why="the latest verdict from $GATE_REVIEWER at $HEAD_SHA (review $review_id) is '$verdict'"
fi
echo "::error::$why. A PR that is not docs-only or test-only needs a seat gate at its exact head, and a new push needs a new gate."
exit 1
