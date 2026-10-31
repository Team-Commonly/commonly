#!/usr/bin/env bash
# Gate verdict for one PR head (TASK-595). The policy is docs/development/external-review.md.
#
# Passes when every changed file is docs or test code (Tier 0), or when the latest verdict
# from the gate account at the exact head opens `GATE: PASS` and names the head SHA on its first
# line, and its last line is `GATE: PASS`. Anything else fails, including an API error or a file
# list shorter than the PR's changed_files.
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

# One line per review by the gate account at this head: "<id>\t<submitted_at>\t<first line>\t<last line>".
# Both ends are read the way the press reads them: footers and markup removed, blank lines skipped.
# Pending and dismissed reviews don't count. The text decides the verdict, not the review state.
verdicts="$(gh api --paginate "repos/$REPO/pulls/$PR_NUMBER/reviews" --jq '
  def clean_lines:
    split("\n")
    | map(sub("\\s+$"; "") | gsub("[*`]"; "") | sub("^\\s+"; ""))
    | map(select(length > 0 and (test("^(written[ -]by|pod[ -]thread)"; "i") | not)));
  .[]
  | select((.user.login | ascii_downcase) == ($ENV.GATE_REVIEWER | ascii_downcase))
  | select(.commit_id == $ENV.HEAD_SHA and .state != "PENDING" and .state != "DISMISSED")
  | (.body // "" | clean_lines) as $lines
  | [.id, .submitted_at, ($lines | .[0] // ""), ($lines | .[-1] // "")]
  | @tsv')"

# Review ids rise with creation, so the highest id is the latest verdict. A review is a verdict when
# its first or its last line mentions GATE:, so a HOLD at either end blocks a PASS before it.
latest="$(printf '%s\n' "$verdicts" | awk -F '\t' 'tolower($3) ~ /gate:/ || tolower($4) ~ /gate:/' | sort -t $'\t' -k1,1n | tail -n 1)"
if [ -z "$latest" ]; then
  echo "::error::no GATE verdict from $GATE_REVIEWER at $HEAD_SHA. A PR that is not docs-only or test-only needs a seat gate at its exact head, and a new push needs a new gate."
  exit 1
fi

review_id="$(printf '%s\n' "$latest" | cut -f 1)"
first="$(printf '%s\n' "$latest" | cut -f 3)"
last="$(printf '%s\n' "$latest" | cut -f 4)"
# A PASS opens with the words GATE: PASS and names the head's first seven characters, and its last
# line is exactly GATE: PASS. Both ends are needed, as review-checklist rules 44 and 51 require.
opens_pass=no
case "$first" in "GATE: PASS "*"${HEAD_SHA:0:7}"*) opens_pass=yes ;; esac
if [ "$opens_pass" != yes ] || [ "$last" != "GATE: PASS" ]; then
  echo "::error::the latest verdict from $GATE_REVIEWER at $HEAD_SHA (review $review_id) is not a PASS at this head. Its first line is '$first' and its last line is '$last'. A PASS needs a first line that opens 'GATE: PASS' and names ${HEAD_SHA:0:7}, and a last line of exactly 'GATE: PASS'."
  exit 1
fi
echo "✓ $GATE_REVIEWER: GATE: PASS at $HEAD_SHA (review $review_id)"
