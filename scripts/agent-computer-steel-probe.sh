#!/usr/bin/env bash
# Attacks the agent computer's browser from a page, in CI
# (.github/workflows/agent-computer-steel-probe.yml). It starts the pinned
# Steel image twice, with the image, user, capabilities, env, args and Chrome
# policy read from the chart's own render, and runs
# scripts/agent-computer-steel-probe.mjs inside each:
#   - enforce: the chart's policy, mounted where the pod mounts it. Every
#     attack the policy should stop must leave the witness empty.
#   - report: the image's own policy. At least one page attack must reach the
#     witness, or the probe can't tell a block from a broken attack.
# The attacking page is served from the runner, a private address, and is
# marked a secure context, as an https page on the open web would be.
# CI only: it needs docker, sudo, helm and yq, and mounts no secrets.
set -euo pipefail

chart=k8s/helm/commonly
user=aaaaaaaaaaaaaaaaaaaaaaaa
page_port=8080
page_origin="http://page.probe.test:$page_port"
tmp=$(mktemp -d)
page_pid=""
cleanup() {
  docker rm -f steel-probe-enforce steel-probe-report > /dev/null 2>&1 || true
  if [ -n "$page_pid" ]; then kill "$page_pid" 2> /dev/null || true; fi
  sudo rm -rf "$tmp"
}
trap cleanup EXIT

q() { yq -N "$1" "$tmp/on.yaml"; }
helm template commonly-dev "$chart" -f "$chart/values.yaml" -f "$chart/values-dev.yaml" \
  --set "agentComputer.users[0]=$user" > "$tmp/on.yaml"
browser="select(.kind == \"Deployment\" and .metadata.name == \"steel-$user\") | .spec.template.spec.containers[] | select(.name == \"steel\")"

image=$(q "$browser | .image")
run_uid=$(q "$browser | .securityContext.runAsUser")
run_gid=$(q "$browser | .securityContext.runAsGroup")
test "$(q "$browser | .securityContext.runAsNonRoot")" = true
test "$(q "$browser | .securityContext.allowPrivilegeEscalation")" = false
test "$(q "$browser | .securityContext.capabilities.drop | join(\",\")")" = ALL
test "$run_uid" != 0
profile_dir=$(q "$browser | .volumeMounts[] | select(.name == \"profile\") | .mountPath")
files_dir=$(q "$browser | .volumeMounts[] | select(.name == \"steel-files\") | .mountPath")
policy_dir=$(q "$browser | .volumeMounts[] | select(.name == \"chrome-policy\") | .mountPath")
mkdir -p "$tmp/policy"
q 'select(.kind == "ConfigMap" and .metadata.name == "agent-computer-chrome-policy") | .data["00_policy.json"]' > "$tmp/policy/00_policy.json"
python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$tmp/policy/00_policy.json"

env_args=()
while IFS=$'\t' read -r name value; do
  env_args+=(-e "$name=$value")
done < <(q "$browser | .env[] | select(has(\"value\")) | .name + \"\t\" + .value")
mapfile -t steel_args < <(q "$browser | .args[]")

# The attacking page: a page, a text file, and a redirect to any URL.
mkdir -p "$tmp/page"
cat > "$tmp/page/server.py" << 'EOF'
import http.server, sys, urllib.parse
class Page(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        url = urllib.parse.urlparse(self.path)
        if url.path == "/redir":
            self.send_response(302)
            self.send_header("Location", urllib.parse.parse_qs(url.query)["to"][0])
            self.end_headers()
            return
        body = b"ok" if url.path == "/ok.txt" else b"<!doctype html><title>probe</title><body>probe</body>"
        self.send_response(200)
        self.send_header("Content-Type", "text/plain" if url.path == "/ok.txt" else "text/html")
        self.end_headers()
        self.wfile.write(body)
    def log_message(self, *args):
        pass
http.server.ThreadingHTTPServer(("0.0.0.0", int(sys.argv[1])), Page).serve_forever()
EOF
python3 "$tmp/page/server.py" "$page_port" &
page_pid=$!

docker pull -q "$image" > /dev/null

start() {
  local mode=$1
  shift
  mkdir -p "$tmp/$mode/profile" "$tmp/$mode/files"
  sudo chown -R "$run_uid:$run_gid" "$tmp/$mode"
  docker run -d --name "steel-probe-$mode" \
    --user "$run_uid:$run_gid" --cap-drop ALL --security-opt no-new-privileges \
    --shm-size 1g \
    "${env_args[@]}" \
    -e "CHROME_ARGS=--unsafely-treat-insecure-origin-as-secure=$page_origin" \
    -v "$tmp/$mode/profile:$profile_dir" -v "$tmp/$mode/files:$files_dir" \
    -v "$PWD/scripts/agent-computer-steel-probe.mjs:/probe/probe.mjs:ro" \
    --add-host "page.probe.test:host-gateway" --add-host "loop.probe.test:127.0.0.1" \
    "$@" "$image" "${steel_args[@]}" > /dev/null
}

probe() {
  local mode=$1
  if docker exec -e "PROBE_MODE=$mode" -e "PROBE_PAGE=$page_origin/" -e "PROBE_LOOP_NAME=loop.probe.test" \
    "steel-probe-$mode" node /probe/probe.mjs > "$tmp/$mode.json"; then
    echo 0 > "$tmp/$mode.rc"
  else
    echo $? > "$tmp/$mode.rc"
  fi
  if [ ! -s "$tmp/$mode.json" ]; then
    echo "probe ($mode) printed nothing; container log:"
    docker logs --tail 80 "steel-probe-$mode" 2>&1
    exit 1
  fi
}

start enforce -v "$tmp/policy:$policy_dir:ro"
start report
probe enforce
probe report

python3 - "$tmp/enforce.json" "$tmp/report.json" << 'EOF'
import json, sys
enforce, report = (json.load(open(p)) for p in sys.argv[1:3])
other = {r["test"]: r for r in report["results"]}
print(f"Browser: {enforce['browser']}")
print(f"{'attack':30} {'kind':9} {'chart policy':14} {'image policy':14}")
for r in enforce["results"]:
    word = lambda x: ("ok" if x["reached"] else "FAILED") if x["kind"] == "control" else ("reached" if x["reached"] else "blocked")
    print(f"{r['test']:30} {r['kind']:9} {word(r):14} {word(other[r['test']]):14} {r['detail'][:60]}")
EOF

enforce_rc=$(cat "$tmp/enforce.rc")
report_rc=$(cat "$tmp/report.rc")
test "$report_rc" = 0 || { echo "report run: a control failed"; exit 1; }
seen=$(python3 -c 'import json,sys; r=json.load(open(sys.argv[1]))["results"]; print(sum(1 for x in r if x["kind"]=="assert" and x["test"].startswith(("page-","worker-")) and x["reached"]))' "$tmp/report.json")
test "$seen" -gt 0 || { echo "report run: no page attack reached the witness, so the probe can't tell a block from a broken attack"; exit 1; }
test "$enforce_rc" = 0 || { echo "enforce run: $(python3 -c 'import json,sys; print(", ".join(json.load(open(sys.argv[1]))["failures"]))' "$tmp/enforce.json") got through the chart's policy"; exit 1; }
echo "agent computer browser probe: ok"
