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
# The page attacks run from https://example.com, a public page like every
# allowed host (asserted). Under the image's policy they also run from a page
# the runner serves over http on a private address (recorded); the chart's
# allowlist refuses that page outright. The private page and the rebind name
# are marked trustworthy, so mixed-content blocking can't pass for a policy
# block.
# The runner also serves https://page.probe.test/ with a throwaway certificate
# that Chrome is told to accept by its key alone. The chart is rendered with
# it as an allowed host, so a redirect from an allowed host can be tested.
# CI only: it needs docker, sudo, openssl, helm and yq, and mounts no secrets.
set -euo pipefail

chart=k8s/helm/commonly
user=aaaaaaaaaaaaaaaaaaaaaaaa
page_port=8080
page_origin="http://page.probe.test:$page_port"
secure_page="https://page.probe.test/"
tmp=$(mktemp -d)
page_pid=""
cleanup() {
  docker rm -f steel-probe-enforce steel-probe-report > /dev/null 2>&1 || true
  if [ -n "$page_pid" ]; then sudo kill "$page_pid" 2> /dev/null || true; fi
  sudo rm -rf "$tmp"
}
trap cleanup EXIT

q() { yq -N "$1" "$tmp/on.yaml"; }
# The allowed hosts are the public attacking page's and the runner's https
# page, so the policy is the one the chart renders for any allowlist, and every
# other host is refused.
helm template commonly-dev "$chart" -f "$chart/values.yaml" -f "$chart/values-dev.yaml" \
  --set "agentComputer.users[0]=$user" --set-string 'backend.env.agentComputerAllowedHosts=example.com\,page.probe.test' > "$tmp/on.yaml"
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
while IFS= read -r pair; do
  env_args+=(-e "$pair")
done < <(q "$browser | .env[] | select(has(\"value\")) | .name + \"=\" + .value")
# The run must carry the pod's env, or Chrome starts with Steel's defaults.
printf '%s\n' "${env_args[@]}" | grep -qx 'DISABLE_CHROME_SANDBOX=true'
printf '%s\n' "${env_args[@]}" | grep -qx "CHROME_USER_DATA_DIR=$profile_dir"
mapfile -t steel_args < <(q "$browser | .args[]")

# The attacking pages: a page, a text file, and a redirect to any URL, over
# http on :$page_port and https on :443, with a log of every path served at
# http://page.probe.test:$page_port/hits.
mkdir -p "$tmp/page"
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj "/CN=page.probe.test" \
  -addext "subjectAltName=DNS:page.probe.test" \
  -keyout "$tmp/page/key.pem" -out "$tmp/page/cert.pem" 2> /dev/null
spki=$(openssl x509 -in "$tmp/page/cert.pem" -pubkey -noout | openssl pkey -pubin -outform der | openssl dgst -sha256 -binary | base64)
cat > "$tmp/page/server.py" << 'EOF'
import http.server, json, ssl, sys, threading, urllib.parse
served = []
class Page(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        url = urllib.parse.urlparse(self.path)
        if url.path == "/hits":
            body = json.dumps(served).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(body)
            return
        served.append(self.path)
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
plain = http.server.ThreadingHTTPServer(("0.0.0.0", int(sys.argv[1])), Page)
secure = http.server.ThreadingHTTPServer(("0.0.0.0", 443), Page)
context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
context.load_cert_chain(sys.argv[2], sys.argv[3])
secure.socket = context.wrap_socket(secure.socket, server_side=True)
threading.Thread(target=secure.serve_forever, daemon=True).start()
plain.serve_forever()
EOF
sudo python3 "$tmp/page/server.py" "$page_port" "$tmp/page/cert.pem" "$tmp/page/key.pem" &
page_pid=$!
for _ in $(seq 1 30); do
  curl -sf "http://127.0.0.1:$page_port/hits" > /dev/null && curl -sfk https://127.0.0.1/ > /dev/null && break
  sleep 1
done
curl -sf "http://127.0.0.1:$page_port/hits" > /dev/null

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
    -e "CHROME_ARGS=--unsafely-treat-insecure-origin-as-secure=$page_origin,http://loop.probe.test:3999 --ignore-certificate-errors-spki-list=$spki" \
    -v "$tmp/$mode/profile:$profile_dir" -v "$tmp/$mode/files:$files_dir" \
    -v "$PWD/scripts/agent-computer-steel-probe.mjs:/probe/probe.mjs:ro" \
    --add-host "page.probe.test:host-gateway" --add-host "loop.probe.test:127.0.0.1" \
    "$@" "$image" "${steel_args[@]}" > /dev/null
}

probe() {
  local mode=$1
  if docker exec -e "PROBE_MODE=$mode" -e "PROBE_PAGE=$page_origin/" -e "PROBE_LOOP_NAME=loop.probe.test" \
    -e "PROBE_SECURE_PAGE=$secure_page" -e "PROBE_PAGE_HITS=$page_origin/hits" \
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
mine = {r["test"]: r for r in enforce["results"]}
other = {r["test"]: r for r in report["results"]}
order = [r["test"] for r in enforce["results"]] + [r["test"] for r in report["results"] if r["test"] not in mine]
def word(x):
    if x is None:
        return "not loaded"
    if x["kind"] == "control":
        return "ok" if x["reached"] else "FAILED"
    if x["counted"] == "policy":
        return "not refused" if x["reached"] else "refused"
    return "reached" if x["reached"] else "blocked"
print(f"Browser: {enforce['browser']}")
print(f"{'attack':38} {'kind':9} {'counted':8} {'chart policy':14} {'image policy':14}")
for test in order:
    r = mine.get(test) or other[test]
    print(f"{test:38} {r['kind']:9} {r['counted']:8} {word(mine.get(test)):14} {word(other.get(test)):14} {r['detail'][:70]}")
EOF

enforce_rc=$(cat "$tmp/enforce.rc")
report_rc=$(cat "$tmp/report.rc")
test "$report_rc" = 0 || { echo "report run: a control failed"; exit 1; }
reached_in_report() { python3 -c 'import json,sys; r={x["test"]: x for x in json.load(open(sys.argv[1]))["results"]}; print("yes" if r.get(sys.argv[2], {}).get("reached") else "no")' "$tmp/report.json" "$1"; }
seen=$(python3 -c 'import json,sys; r=json.load(open(sys.argv[1]))["results"]; print(sum(1 for x in r if x["test"].startswith("page-private-") and x["reached"]))' "$tmp/report.json")
test "$seen" -gt 0 || { echo "report run: no page attack reached the witness, so the probe can't tell a block from a broken attack"; exit 1; }
# A blocked redirect hop means something only if the same hop gets through
# under the image's policy.
for row in cdp-nav-redirect-hop; do
  test "$(reached_in_report "$row")" = yes || { echo "report run: $row did not reach the witness, so its block under the chart's policy proves nothing"; exit 1; }
done
test "$enforce_rc" = 0 || { echo "enforce run: $(python3 -c 'import json,sys; print(", ".join(json.load(open(sys.argv[1]))["failures"]))' "$tmp/enforce.json") got through the chart's policy"; exit 1; }
echo "agent computer browser probe: ok"
