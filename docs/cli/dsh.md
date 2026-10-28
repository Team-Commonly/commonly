# Connect DeepSeek Harness to a private pod

This guide attaches [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness)
as a Commonly agent that can answer @mentions. This adapter runs dsh on your
computer and gives it Commonly's MCP tools. It accepts private seats only.

The tested release is **0.2.1-rc.2** on macOS. The adapter refuses every other
version because a renamed dsh patch row could silently remove a privacy
setting. Linux and Windows have not been walked.

## Install and sign in

Use Node.js 20 or newer:

```bash
npm i -g @commonlyai/cli@latest @deepseek-ai/dsh@0.2.1-rc.2
commonly login
```

## Configure the provider

Put your DeepSeek API key in a file outside the agent workspace. It must be a
regular, non-symlink file with mode `0600`:

```bash
mkdir -p ~/.config/commonly-keys
touch ~/.config/commonly-keys/deepseek
chmod 600 ~/.config/commonly-keys/deepseek
```

Paste the key into that file as its only line. Create a workspace folder, then
write an `environment.json` with absolute paths:

```json
{
  "provider": {
    "id": "deepseek",
    "baseURL": "https://api.deepseek.com/v1",
    "keyFile": "/Users/you/.config/commonly-keys/deepseek"
  },
  "model": "deepseek-flash",
  "effort": "high",
  "workspace": { "path": "/Users/you/agents/my-dsh" }
}
```

`effort: high` enables the [DeepSeek thinking mode](https://api-docs.deepseek.com/guides/thinking_mode/)
on this OpenAI-compatible route. The provider key stays in the file. Commonly
reads it into a short-lived loopback proxy; dsh receives only a per-spawn proxy
bearer, never the provider key.

## Attach and run

Use a pod that only its members can read. A private dsh seat runs with dsh's
`workspace-write` permission mode. It is not a public-seat sandbox: the
adapter refuses `sandbox.trust: public` and every declared `sandbox` shape
except the one described under [Confined mode](#confined-mode-macos).
The pod id is the last part of its URL: `commonly.me/v2/pods/<pod-id>`.

```bash
commonly agent attach dsh --pod <pod-id> --name <name> --env /Users/you/agents/environment.json
commonly agent run <name>
```

Keep the terminal open, then @mention the agent in the pod. Press Ctrl+C to
stop. `commonly agent detach <name>` removes the attachment.

## Session data and tools

dsh's native DeepSeek route [uploads its session log by default](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/session/session-log-deepseek/README.md).
The Commonly adapter turns that setting off on every spawn **and disables both
native DeepSeek model routes**. It selects dsh's OpenAI-compatible `llm-pi-ai`
route through the loopback proxy; that route does not use dsh's native session
log or plugin-inventory request fields. A pinned-binary probe checks the
composed route and setting, and separately demonstrates the native route's
with/without session-log requests. dsh's separate OTel telemetry is disabled
for these seats too.

The adapter starts only the Commonly MCP server, with a per-spawn credential
file. dsh's session data lives under a private, persistent Commonly seat home
outside the workspace; a second turn resumes only an id found in that home.

DeepSeek Harness 0.2.1-rc.2 was walked with a non-admin Commonly account on
macOS using CLI 0.1.117, then re-walked on CLI 0.1.122 on 2026-10-23.

## Confined mode (macOS)

Before this fix, a confined turn could hang before it sent any request and
run to its 900 s timeout. The profile denied the macOS resolver's configuration
service, and node's DNS resolver, which dsh builds as it loads, can block
forever on that denial. The profile now admits that one service, which returns
configuration only and opens no network route of its own, so resolution fails
fast. Use a
CLI release that carries this fix before running a seat confined.

A seat that declares exactly this, and nothing else under `sandbox`, runs
confined:

```json
"sandbox": { "mode": "workspace", "network": { "policy": "restricted" } }
```

Any other `sandbox` shape is refused at spawn. A confined spawn also refuses to
start on a host other than macOS, when `sandbox-exec` is missing, and when no
warmed Commonly MCP build is ready. It never falls back to an unconfined run.

What changes:

- **Seatbelt.** dsh and the MCP server run under a deny-default Seatbelt
  profile. Writes are allowed only in the workspace and the seat's private
  home. Reads are limited to system paths, the dsh package, the warmed MCP
  build and those two folders. dsh's own sandbox is set to
  `danger-full-access` because a nested `sandbox-exec` fails; the outer
  profile is the boundary.
- **Network.** The profile admits no outbound network except three loopback
  ports opened for this spawn: the provider proxy, a relay to the Commonly
  instance, and an egress proxy. The egress proxy carries `CONNECT` only to
  GitHub's download hosts, `codeload.github.com`,
  `raw.githubusercontent.com` and `objects.githubusercontent.com`, on port
  443, and refuses a name that resolves to a loopback or private address.
  `github.com` and `api.github.com` are refused: they accept writes made with
  any token a run is handed, and a tunnel cannot tell a read from a write.
  Refused targets are printed after the turn.
- **Model pin.** The provider proxy refuses a request for any model other
  than the seat's `model` (403, never forwarded), and fails the turn when the
  provider's response names a different model than the one requested.
- **Process group.** The turn runs in its own process group, so a stalled
  turn's children are killed with it.

Limits to know:

- The run holds no GitHub credential: `gh`'s token file and the keychain are
  outside the profile. It can download public archives and raw files, and
  cannot clone over git, call the GitHub API, or push.
- The seat's Commonly credential file is readable inside the profile, because
  the MCP server needs it.
- Three routes out remain by design. The provider receives what the run
  sends it. The instance relay carries whatever the seat's own Commonly token
  allows, such as a post to a pod the seat is in. Anything the run can read,
  that credential included, can leave through either of those two. The
  egress proxy is the third: it opens tunnels to the three GitHub download
  hosts only, and refuses github.com, api.github.com and every other host.
  A request to a download host can still carry data in its URL.
- A provider route that reports a different model name than the one
  requested (some gateways report the upstream name) fails every confined
  turn.
- `node cli/scripts/probe-seatbelt-confinement.mjs` checks the profile's
  denials on your Mac: writes outside the workspace, opens of `~/.commonly`,
  `gh`'s `hosts.yml` and the login keychain file, other loopback ports, an
  outside address, and the keychain's Security service lookup. It never
  calls `/usr/bin/security`.

