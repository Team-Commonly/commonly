# microsandbox on a GitHub-hosted Windows runner: the second probe.
# It asks what the OpenShell spike asked on Linux:
#   1. what the default network fence allows, and whether a `host` rule reaches
#      a service bound only to the runner's 127.0.0.1;
#   2. whether one turn's code runs under the driver contract (stdin in, a
#      timeout exit code, no host environment inside) and how long that takes;
#   3. whether Claude Code and Codex run inside with Commonly's provider proxy
#      as their only way out.
# Spike only: every key is fake, and the runner is thrown away afterwards.
$ErrorActionPreference = 'Continue'
$msb = $env:MSB
$here = $PSScriptRoot
$front = Join-Path $env:RUNNER_TEMP 'front'

function Section($t) { "`n==== $t" }
# Strips CR: a Windows checkout gives this file CRLF, and a guest shell would
# keep the CR in every value and file name.
function B64($s) { [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($s -replace "`r", ''))) }
# Runs a shell script inside a sandbox without Windows quoting getting in the way.
function GuestSh($name, $script) {
  & $msb exec $name -- sh -c "echo $(B64 $script) | base64 -d | sh"
  "exit: $LASTEXITCODE"
}
$probePy = Get-Content -Raw (Join-Path $here 'guest-net-probe.py')
function NetProbe($label, $netFlags, $targets) {
  Section "net: $label  [$($netFlags -join ' ')]"
  & $msb run @netFlags python -- python3 -c "import base64;exec(base64.b64decode('$(B64 $probePy)'))" @targets
  "exit: $LASTEXITCODE"
}

Section 'msb run cost, warm (the boot step already pulled the python image)'
foreach ($i in 1..3) {
  $t = Measure-Command { & $msb run python -- python3 -c "print(6*7)" | Out-Host }
  "msb run python $i : $([int]$t.TotalMilliseconds) ms"
}

Section 'front: stub model, provider proxies, and a loopback-only stand-in for Postgres'
node --version
$env:FRONT_DIR = $front
$env:FRONT_BIND = '127.0.0.1'
Start-Process node -ArgumentList (Join-Path $here 'sandbox-front.mjs') -NoNewWindow -RedirectStandardOutput "$env:RUNNER_TEMP\front.out" -RedirectStandardError "$env:RUNNER_TEMP\front.err"
Start-Process node -ArgumentList '-e', "require('net').createServer(s=>s.end('LOOPBACK-ONLY-SERVICE\n')).listen(18199,'127.0.0.1')" -NoNewWindow
foreach ($i in 1..30) { if (Test-Path "$front\front.json") { break }; Start-Sleep 1 }
if (-not (Test-Path "$front\front.json")) { Get-Content "$env:RUNNER_TEMP\front.err"; throw 'front did not start' }
$cfg = Get-Content -Raw "$front\front.json" | ConvertFrom-Json
'front ready; every listener is on 127.0.0.1 only'
Get-NetTCPConnection -State Listen | Where-Object { $_.LocalPort -in 18090, 18100, 18101, 18102, 18199 } | Select-Object LocalAddress, LocalPort | Format-Table -AutoSize | Out-String

$H = 'host.microsandbox.internal'
$targets = @('--http', 'http://169.254.169.254/metadata/instance?api-version=2021-02-01', '--http', 'http://example.com/', "example.com:443", "${H}:18100", "${H}:18199", "169.254.169.254:80")
NetProbe 'default policy' @() $targets
NetProbe '--no-net' @('--no-net') $targets
NetProbe 'deny-all + allow host:18100 only' @('--no-net', '--net-rule', 'allow@host:tcp:18100') $targets
NetProbe 'deny-all + dns + allow host:18100 only' @('--no-net', '--net-rule', 'allow@dns,allow@host:tcp:18100') $targets
NetProbe 'deny-all + allow the whole host group' @('--no-net', '--net-rule', 'allow@dns,allow@host') $targets

Section 'net: one request through the provider proxy (stub model echoes the key it got)'
& $msb run --no-net --net-rule 'allow@dns,allow@host:tcp:18100' python -- python3 -c "import base64;exec(base64.b64decode('$(B64 $probePy)'))" --proxy "${H}:18100" $cfg.anthropicProxyToken
"exit: $LASTEXITCODE"
'front request log:'
Get-Content "$front\requests.log"

Section 'driver contract: create once, exec turns, timeout, stdin, host env'
$env:SPIKE_HOST_ONLY = 'fake-host-env-should-not-leak'
$t = Measure-Command { & $msb create --name cm-turn-1 --cpus 1 --memory 512M --no-net python 2>&1 | Out-Host }
"create: $([int]$t.TotalMilliseconds) ms (exit $LASTEXITCODE)"
& $msb ls 2>&1 | Out-Host
foreach ($i in 1..2) {
  $t = Measure-Command { & $msb exec -q cm-turn-1 -- python3 -c "print(6*7)" | Out-Host }
  "exec -q $i : $([int]$t.TotalMilliseconds) ms"
}
foreach ($i in 1..3) {
  $t = Measure-Command { & $msb exec cm-turn-1 -- python3 -c "print(6*7)" | Out-Host }
  "exec $i : $([int]$t.TotalMilliseconds) ms"
}
'-- code on stdin (what the driver would send)'
"import os, sys`nprint('stdin ok', sys.version.split()[0])`nprint('host env inside:', os.environ.get('SPIKE_HOST_ONLY', '<absent>'))" | & $msb exec cm-turn-1 -- python3 -
"exit: $LASTEXITCODE"
'-- the same on --stream'
"print('stream ok')" | & $msb exec --stream cm-turn-1 -- python3 -
"exit: $LASTEXITCODE"
'-- nonzero exit'
& $msb exec cm-turn-1 -- python3 -c "import sys; sys.exit(3)"
"exit: $LASTEXITCODE"
'-- timeout'
$t = Measure-Command { & $msb exec --timeout 3s cm-turn-1 -- python3 -c "import time; time.sleep(20)" | Out-Host }
"timeout run: exit $LASTEXITCODE after $([int]$t.TotalMilliseconds) ms"
'-- writes inside the guest (the VM is the boundary, so root inside is expected)'
GuestSh 'cm-turn-1' 'id; echo x > /etc/spike && echo wrote /etc/spike; uname -r; unshare --user --map-root-user true && echo "user namespaces: allowed" || echo "user namespaces: refused"'
'-- node image'
$t = Measure-Command { & $msb run node -- node -e "console.log('node', process.version)" | Out-Host }
"node run: $([int]$t.TotalMilliseconds) ms"
& $msb rm --force cm-turn-1 2>&1 | Select-Object -First 3

Section 'create: why "Access is denied"'
$env:RUST_LOG = 'debug'
& $msb create --name cm-dbg --no-net python 2>&1 | Select-Object -Last 25
Remove-Item Env:RUST_LOG
& $msb inspect cm-dbg 2>&1 | Select-String -Pattern 'net|rule|default|egress|status' | Select-Object -First 25
& $msb rm --force cm-dbg 2>&1 | Select-Object -First 2

Section 'fence: rules alone vs rules on --no-net, and domain rule forms, via msb run'
$vendor = "fetch('https://api.anthropic.com/v1/models').then(r=>console.log('anthropic status',r.status)).catch(e=>console.log('anthropic refused:',e.cause?.code||e.message));fetch('https://registry.npmjs.org/-/ping').then(r=>console.log('registry status',r.status)).catch(e=>console.log('registry refused:',e.cause?.code||e.message))"
foreach ($flags in @(
    @('--net-rule', 'allow@dns,allow@registry.npmjs.org:tcp:443'),
    @('--no-net', '--net-rule', 'allow@dns,allow@registry.npmjs.org:tcp:443'),
    @('--no-net', '--net-rule', 'allow@dns,allow@registry.npmjs.org'),
    @('--no-net', '--net-rule', 'allow@dns,allow@*.npmjs.org'))) {
  "-- [$($flags -join ' ')]"
  & $msb run @flags node -- node -e $vendor
}

Section 'agents: Claude Code 2.1.331 and Codex 0.172.0 inside, proxy as the only way out'
# Install unfenced onto an ext4 disk volume, then run the agents from it under
# the fence: only DNS and the two proxy ports.
& $msb volume create agents --kind disk --size 3G 2>&1 | Out-Host
$t = Measure-Command {
  & $msb run --cpus 2 --memory 2G --mount-named agents:/opt/agents:kind=disk,size=3G node -- sh -c "npm i -g --prefix /opt/agents --no-fund --no-audit @anthropic-ai/claude-code@2.1.331 @openai/codex@0.172.0 2>&1 | tail -5; ls /opt/agents/bin; cd /tmp && apt-get update -qq >/dev/null 2>&1 && apt-get download -qq bubblewrap && dpkg -x bubblewrap_*.deb /opt/agents/bubblewrap && ls -l /opt/agents/bubblewrap/usr/bin/bwrap" | Out-Host
}
"install (unfenced): $([int]$t.TotalSeconds) s"
$fence = @('--no-net', '--net-rule', 'allow@dns,allow@host:tcp:18100,allow@host:tcp:18101', '--mount-named', 'agents:/opt/agents:kind=disk,size=3G')
"fence: $($fence -join ' ')"
$codexCfg = @"
model = "spike-model"
model_provider = "commonly"
[model_providers.commonly]
name = "commonly"
base_url = "http://${H}:18101/v1"
env_key = "COMMONLY_PROXY_TOKEN"
wire_api = "responses"
"@
$agentScript = @"
export PATH=/opt/agents/bin:`$PATH
claude --version; codex --version
echo '== nesting: a bwrap sandbox shaped like the CLI bwrap mode, inside the microVM'
B=/opt/agents/bubblewrap/usr/bin/bwrap
mkdir -p /tmp/ws
`$B --ro-bind / / --bind /tmp/ws /tmp/ws --dev /dev --proc /proc --unshare-all --die-with-parent sh -c 'echo inside bwrap: uid `$(id -u); touch /tmp/ws/ok && echo workspace write ok; touch /etc/nested 2>/dev/null && echo "etc write ALLOWED" || echo "etc write refused"; node -e "require(\"net\").connect(53,\"1.1.1.1\").on(\"connect\",()=>{console.log(\"net ALLOWED\");process.exit()}).on(\"error\",e=>console.log(\"net refused:\",e.code))"'
echo "bwrap exit `$?"
echo '== nesting: Codex running a command under its own sandbox'
mkdir -p /tmp/cx && cd /tmp/cx
codex sandbox -- sh -c 'touch /etc/codex-nested 2>/dev/null && echo "etc write ALLOWED" || echo "etc write refused"; touch ./ok 2>/dev/null && echo "cwd write ALLOWED" || echo "cwd write refused"; echo codex-sandbox ran' > /tmp/cx.out 2>&1
echo "codex sandbox exit `$?"; tail -5 /tmp/cx.out; cd /
export HOME=/root ANTHROPIC_BASE_URL=http://${H}:18100 ANTHROPIC_API_KEY=$($cfg.anthropicProxyToken)
export CODEX_HOME=/root/.codex COMMONLY_PROXY_TOKEN=$($cfg.openaiProxyToken)
echo '== vendor hosts (should be refused)'
node -e 'fetch("https://api.anthropic.com/v1/models").then(r=>console.log("anthropic status",r.status)).catch(e=>console.log("anthropic refused:",e.cause?.code||e.message))'
node -e 'fetch("https://api.openai.com/v1/models").then(r=>console.log("openai status",r.status)).catch(e=>console.log("openai refused:",e.cause?.code||e.message))'
node -e 'fetch("http://host.microsandbox.internal:18090/v1/models").then(r=>console.log("raw upstream status",r.status)).catch(e=>console.log("raw upstream refused:",e.cause?.code||e.message))'
echo '== claude -p through the proxy'
timeout 120 claude -p 'reply with OK' --model spike-model; echo "claude exit `$?"
echo '== codex exec through the proxy'
mkdir -p /root/.codex && echo $(B64 $codexCfg) | base64 -d > /root/.codex/config.toml
timeout 120 codex exec --skip-git-repo-check 'reply with OK'; echo "codex exit `$?"
echo '-- codex with its own sandbox off'
timeout 120 codex exec --skip-git-repo-check --sandbox danger-full-access 'reply with OK'; echo "codex(off) exit `$?"
"@
$t = Measure-Command { & $msb run --cpus 2 --memory 2G @fence node -- sh -c "echo $(B64 $agentScript) | base64 -d | sh" | Out-Host }
"agents run: $([int]$t.TotalSeconds) s (exit $LASTEXITCODE)"
'front request log (after agents):'
Get-Content "$front\requests.log" | Select-Object -Last 20
