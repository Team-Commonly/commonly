#!/usr/bin/env bash
# Gate verdict for one PR head (TASK-595). The policy is docs/development/external-review.md.
#
# Passes when every changed file is docs or test code (Tier 0), or when the latest verdict
# from the gate account at the exact head is `GATE: PASS` and names the head SHA. Anything
# else fails, including an API error or a file list shorter than the PR's changed_files.
#
# This script runs from the PR checkout, so a PR that edits it grades itself until it is
# pinned to main's copy. Do not make the check required before then.
#
# Env: REPO (owner/name), PR_NUMBER, HEAD_SHA, GH_TOKEN (pull-requests: read).
# Optional: GATE_REVIEWER (default lilyshen0722), the account seat verdicts are posted from.
set -euo pipefail

: "${REPO:?set REPO}" "${PR_NUMBER:?set PR_NUMBER}" "${HEAD_SHA:?set HEAD_SHA}"
export GATE_REVIEWER="${GATE_REVIEWER:-lilyshen0722}" HEAD_SHA

# Tier 0 is docs and test files only. Dot-directories never count as docs: .github,
# .claude and .agents hold workflows and agent skills, which change behaviour.
EXEMPT_RE='^(docs/([^./][^/]*/)*[^/]+\.(md|mdx|txt|png|jpe?g|gif|svg|webp)|([^./][^/]*/)*[^/]+\.(md|mdx)|([^./][^/]*/)*__tests__/([^/]+/)*[^/]+|([^./][^/]*/)*[^/]+\.(test|spec)\.[cm]?[jt]sx?)$'
# Markdown that the code or the agents load is behaviour: skill files and skill trees, the
# k8s config directory and the agent instruction files. Under docs/ it stays docs.
BEHAVIOUR_RE='(^|/)SKILL\.md$|(^|/)[^/]*skills/|^k8s/helm/commonly/configs/|(^|/)(CLAUDE|AGENTS|REVIEW)\.md$'

# One line per changed file: "<filename>\t<previous_filename>". A rename lists both paths.
rows="$(gh api --paginate "repos/$REPO/pulls/$PR_NUMBER/files" --jq '.[] | [.filename, (.previous_filename // "")] | @tsv')"
listed="$(printf '%s\n' "$rows" | grep -c . || true)"
expected="$(gh api "repos/$REPO/pulls/$PR_NUMBER" --jq '.changed_files')"
paths="$(printf '%s\n' "$rows" | tr '\t' '\n' | grep . || true)"

# The list must be complete: a file list shorter than changed_files is not Tier 0.
if [ "$listed" -gt 0 ] && [ "$listed" -eq "$expected" ] &&
  [ -z "$(printf '%s\n' "$paths" | grep -Ev "$EXEMPT_RE" || true)" ] &&
  [ -z "$(printf '%s\n' "$paths" | grep -E "$BEHAVIOUR_RE" | grep -Ev '^docs/' || true)" ]; then
  echo "✓ Tier 0: every changed file is docs or test code, so no seat gate is needed"
  exit 0
fi

# One line per review by the gate account at this head: "<id>\t<submitted_at>\t<last line>\t<names SHA>".
# The last line is read the way the press reads it: footers and markup removed, blank lines skipped.
# Pending and dismissed reviews don't count. The text decides the verdict, not the review state.
verdicts="$(gh api --paginate "repos/$REPO/pulls/$PR_NUMBER/reviews" --jq '
  def last_line:
    split("\n")
    | map(sub("\\s+$"; "") | gsub("[*`]"; "") | sub("^\\s+"; ""))
    | map(select(test("^(written[ -]by|pod[ -]thread)"; "i") | not))
    | map(select(length > 0))
    | (last // "");
  .[]
  | select((.user.login | ascii_downcase) == ($ENV.GATE_REVIEWER | ascii_downcase))
  | select(.commit_id == $ENV.HEAD_SHA and .state != "PENDING" and .state != "DISMISSED")
  | (.body // "") as $body
  | [.id, .submitted_at, ($body | last_line),
     (if ($body | contains($ENV.HEAD_SHA | .[0:7])) then "yes" else "no" end)]
  | @tsv')"

# Review ids rise with creation, so the highest id is the latest verdict. Any last line that
# mentions GATE: is a verdict, so a decorated HOLD after a PASS blocks it.
latest="$(printf '%s\n' "$verdicts" | awk -F '\t' 'tolower($3) ~ /gate:/' | sort -t $'\t' -k1,1n | tail -n 1)"
if [ -z "$latest" ]; then
  echo "::error::no GATE verdict from $GATE_REVIEWER at $HEAD_SHA. A PR that is not docs-only or test-only needs a seat gate at its exact head, and a new push needs a new gate."
  exit 1
fi

review_id="$(printf '%s\n' "$latest" | cut -f 1)"
verdict="$(printf '%s\n' "$latest" | cut -f 3)"
named="$(printf '%s\n' "$latest" | cut -f 4)"
if [ "$verdict" != "GATE: PASS" ]; then
  echo "::error::the latest verdict from $GATE_REVIEWER at $HEAD_SHA (review $review_id) is '$verdict', not 'GATE: PASS'. A PASS at this head is needed."
  exit 1
fi
if [ "$named" != yes ]; then
  echo "::error::the GATE: PASS from $GATE_REVIEWER (review $review_id) does not name the head SHA ${HEAD_SHA:0:7}. The verdict must say which commit it checked out."
  exit 1
fi
echo "✓ $GATE_REVIEWER: GATE: PASS at $HEAD_SHA (review $review_id)"
