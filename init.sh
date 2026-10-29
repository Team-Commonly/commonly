#!/usr/bin/env bash
# One command: dependencies, the baseline, and the feature scoreboard.
# Every session runs this first (AGENTS.md). A red baseline is fixed before new work.
set -euo pipefail
cd "$(dirname "$0")"
export PATH="$HOME/.commonly/toolchains/v4/bin:$PATH"

for tool in go bun; do
  command -v "$tool" >/dev/null || { echo "missing $tool: see AGENTS.md (Commands)"; exit 1; }
done

echo "== baseline: make preflight"
make preflight

if [ -d worker ] && [ -f e2e/go.mod -o -d e2e ]; then
  echo "== baseline: make e2e"
  make e2e
fi

echo "== features"
bun -e '
const { features } = JSON.parse(await Bun.file("feature_list.json").text());
const pass = features.filter(f => f.passes).length;
for (const f of features) {
  const mark = f.passes ? "pass" : f.blockedBy ? "blocked" : "todo";
  console.log(`${f.id}  ${mark.padEnd(7)}  ${f.description}`);
}
const next = features.find(f => !f.passes && !f.blockedBy);
console.log(`\n${pass}/${features.length} passing. Next: ${next ? next.id + " " + next.description : "none unblocked"}`);
'
