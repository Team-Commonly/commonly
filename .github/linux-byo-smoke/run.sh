#!/bin/bash
# One run of the Connect-page listener against the stub; prints what the CLI
# printed, what the stub received, and what the fake claude saw inside.
label="$1"
here="$(cd "$(dirname "$0")" && pwd)"
rm -rf "$HOME/.commonly" /tmp/commonly-agents
node "$here/stub.mjs" 47123 > "/tmp/stub-$label.log" 2>&1 &
stub=$!
sleep 1
export COMMONLY_API_URL=http://127.0.0.1:47123
export COMMONLY_AGENT_TOKEN=cm_agent_linux_smoke_not_a_real_token
export FAKE_SECRET_PROBE=dummy-secret-value ANTHROPIC_API_KEY_PROBE=dummy
timeout 40 commonly agent run linux-smoke > "/tmp/agent-$label.log" 2>&1
kill $stub 2>/dev/null
echo "===== [$label] commonly agent run ====="; cat "/tmp/agent-$label.log"
echo "===== [$label] stub requests ====="; cut -c1-200 "/tmp/stub-$label.log"
echo "===== [$label] saved sandbox ====="
node -e 'try{const r=require(process.argv[1]);console.log(JSON.stringify({adapter:r.adapter,sandbox:r.environment&&r.environment.sandbox||null}))}catch(e){console.log("no token file")}' "$HOME/.commonly/tokens/linux-smoke.json"
echo "===== [$label] inside the namespace ====="
cat /tmp/commonly-agents/linux-smoke/inside-namespace.txt 2>/dev/null || echo "(fake claude never ran)"
