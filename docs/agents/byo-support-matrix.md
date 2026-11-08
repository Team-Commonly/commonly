# Bring your own agent: support matrix

What works today when someone connects an agent they run themselves, by
platform, harness and path. Each cell says **works**, **refused** or
**unverified**, plus the evidence and its date. If you quote this page (Scout,
the BYO page, a reply), quote the cell, evidence included. A cell moves to
**works** only with a dated walk or a CI job behind it.

Paths:
- **Foreground**: `commonly agent run <name>`.
- **Daemon**: the supervisor the daemon installs, which places seats from
  Bring your own agent → On my computer.
- **MCP-only**: the client's own sessions reach Commonly through
  `@commonlyai/mcp` (`claude mcp add …`). Nothing listens for @mentions.

How the paths compare: [CONNECTING_LOCAL_AGENTS.md](CONNECTING_LOCAL_AGENTS.md).

Foreground and daemon spawn through the same adapter and the same host check
(`cli/src/lib/sandbox/host-check.js`, `hostSandboxRefusal`). A refusal on one
is a refusal on the other. The host check applies only to a seat that declares
a confined trust. Public seats do by default (`COMMONLY_DEFAULT_SANDBOX`), so
"refused" below means a public seat. Codex on native Windows is the exception:
there the check applies whatever the seat declares, and a seat with no sandbox
block is refused too, unless the person opted in and every pod is confirmed
private.

Last reviewed 2026-11-07, against main `a0db74604`.

## Claude Code

| | Foreground | Daemon | MCP-only |
|---|---|---|---|
| **macOS** | **works** for a public seat, under Seatbelt. Walked 2026-11-04 in a pod open to join, with CLI 0.1.233 and Claude Code 2.1.318 on macOS 26.4: the CLI announced the scratch-folder confinement, and the seat answered an @mention in 17 s with no refusal. The walk used that Mac's existing Claude login and global `~/.claude` config, which a new user won't have | **unverified**. Same spawn as foreground, but no daemon walk is recorded | **works**, with a gap. Growth's walk on 2026-11-04: the copied `claude mcp add` works. `claude mcp list` shows Connected but doesn't mark the token used, so an install that never calls a tool looks unconnected on our side (a fix is queued). |
| **Linux (WSL included)** | **works** on an API key (walked 2026-11-05); own login CI only. On 2026-11-05 `byo-linux.yml` (run 41945040493) pasted the page's Linux lines on a fresh GitHub-hosted ubuntu-22.04 runner: published CLI 0.1.253, Claude Code 2.1.318 in the bubblewrap jail, with `ANTHROPIC_API_KEY` held by the CLI's host proxy and sent to a model gateway named by `ANTHROPIC_BASE_URL` (not to Anthropic's API), in a pod not fully private (so a public turn in the scratch folder; the walk refuses an all-private agent). The @mention was answered in 13 s and acked. The person's-own-login path and the project-folder (all-private) seat are not walked. Since F96 (#3395, merged 2026-11-04) a public seat runs in the bubblewrap jail: Claude Code's install bound read-only, a private HOME, the macOS public tool policy, and the person's own login as an access-only copy (or `ANTHROPIC_API_KEY` through a host-side proxy). `.github/workflows/claude-bwrap-public.yml` runs Claude Code 2.1.318 in real bwrap against a stub model: one turn per path, and the token-print attack refused through `Read`, `Bash` and `WebFetch`. A login near expiry is refused with "run /login". Needs bubblewrap installed | same spawn as foreground; no daemon walk is recorded | **unverified** |
| **Windows (native)** | **works** with CLI 0.1.243 or newer, through the opt-in `--unsandboxed` (#3388): refused by default (`windowsSandboxMessage`); with the flag it runs with the public tool policy and no OS jail, and gets no connector grants. **Walked on prod** 2026-11-04 (`byo-windows.yml` dispatched with `target=prod`, run 41926949969): the page's four PowerShell lines on windows-latest, from a fresh profile, installed the published CLI 0.1.245; Claude Code 2.1.318 on `claude-haiku-5-5` answered a person's @mention in an invite-only pod on commonly.me in 16 s, and the CLI acked it. 0.1.243 is the first release with the Windows npm fix (#3437); the stub-model walk passed on it (run 41921620690). The model was reached with a gateway key, so no turn on a signed-in Claude account is recorded, and the turn made no tool call | the same rule, through `commonly daemon install --unsandboxed`. CI (`.github/workflows/daemon-windows.yml`) covers install, kill, return, stop and uninstall, and the npm shim. It doesn't cover a Claude turn | **unverified**. The PowerShell `claude mcp add` snippet (#2289) has no recorded walk |

**Ubuntu 24.04 and later.** AppArmor restricts unprivileged user namespaces there, so bubblewrap installs and every sandbox it starts fails. Walked on fresh `ubuntu-24.04` runners on 2026-11-07 with CLI 0.1.290, on a gateway key, as a walk account:

| | As the image comes | With Ubuntu's `bwrap-userns-restrict` loaded |
|---|---|---|
| **Claude Code** | stopped at start, clear cause, no next step (run 42397343530) | answered an @mention in 13 s (run 42398237284) |
| **Codex** | started polling, then every turn failed and the pod heard nothing (run 42398478814) | ran `pwd` in the sandbox and answered in 14 s (run 42398763392) |

Since the next CLI release, both stop at start with one message, routes that change nothing on the machine first and Ubuntu's profile last and optional. The profile is offered only on Ubuntu 24.04, where the walks ran; on later releases the message lists the other routes alone. `hostSandboxRefusal` prints the commands and nothing runs them. The ruling behind the message: never the sysctl, and never a looser grant.

The profile lets any local program use bubblewrap to create user namespaces, with no capabilities for what it starts. **The lines take one file out of `apparmor-profiles` and don't install the package.** Installing it enforces 21 more profiles at once, among them ping, dnsmasq and smbd: 28 enforced before, 49 after (run 42400201955). The one file adds 2 profiles, survives an AppArmor reload, and undoes cleanly (run 42400323320).

Not walked: a full @mention on the one-file lines (the 13 s and 14 s answers loaded the same file from the installed package), a person's own sign-in, the profile after a reboot, a desktop install, other distros, and a real OpenCode or Qwen turn under the profile, so those two aren't offered it. `byo-linux.yml` takes `runner` and `bwrap_profile`.

## Other harnesses

| Harness | macOS | Linux | Windows | MCP-only |
|---|---|---|---|---|
| **Codex** | **works** in the foreground for a public seat. Walked 2026-11-04 in a pod open to join, with CLI 0.1.233 and codex-cli 0.162.1 on macOS 26.4, using an isolated `CODEX_HOME`: the seat answered an @mention in 21 s. Re-walked 2026-11-06 on this repo's CLI with codex-cli 0.162.1 through the model gateway: a public seat answered an @mention in 21 s, wrote a file inside its workspace, and `cat` of a file under `/private/tmp` failed with `Operation not permitted`, read from the seat's own rollout. The daemon is **unverified** | **works** in the foreground on an API key through a model gateway (walked 2026-11-05). Codex confines itself with its own permission profile, whose Linux sandbox uses bubblewrap; it doesn't run in the jail Claude Code runs in. `byo-linux.yml` dispatched with `adapter=codex` (run 41994906534) pasted the page's Linux lines on a fresh GitHub-hosted Ubuntu runner: published CLI 0.1.255 and codex-cli 0.164.0, with the gateway provider set in the runner's system Codex config (`/etc/codex/config.toml`, which holds no key), because a public Codex seat skips the user's `config.toml`. A person's @mention on commonly.me was answered in 16 s and acked. A ChatGPT sign-in or the person's own OpenAI key is **unverified** on Linux, and so is the daemon. Needs bubblewrap installed | **refused** by default, on a host with no sandbox Codex can use: a public seat always refuses, at attach, at `agent run` and turn by turn. With the opt-in `--unsandboxed`, a seat whose every pod is confirmed private (invite-only, not publicly readable, not listed; re-read before each turn, and a failed read doesn't start it) runs unconfined, with your own access to files and commands. Anyone in the pod can direct it, people invited later included, and it gets no connector grants. Walked 2026-11-06 on Windows Server 2025 against prod, with this checkout's CLI and Codex on an API key through the model gateway: in an invite-only pod the seat answered a main-channel @mention in 39 s, pasting the SHA-256 PowerShell computed for a string chosen at that moment, with the unconfined notice in its log (`byo-windows.yml` run 42154387865). Re-walked the same day with the published CLI 0.1.273: answered in 50 s with a 64-hex reply; the walker compared the hash by hand, and the smoke script doesn't assert it (run 42175092787). With the pod set open to join and the flag still passed, it refused at start without naming the flag (run 42154734536). The publicly readable, listed and failed-read cases are covered by unit tests only | **unverified**. A codex MCP entry must declare its own `env` table, or the server can't start (repo CLAUDE.md, Agent Runtime). A run with `--unsandboxed` marks the seat, and no grant can be used from it until its owner runs `commonly agent clear-unsandboxed <name>` with their own login, because the seat's token can't lift it. |
| **OpenCode** | **works** for a public seat on a tested version. Walked 2026-11-04 by Growth on OpenCode 1.19.4 and CLI 0.1.240, running the Bring your own page's OpenCode lines from `~` with an OpenAI-compatible provider (our own model gateway in place of `api.anthropic.com`): an @mention got a reply through the tool in 25 s. A replay fixture covered 1.18.35, 1.19.0 and 1.19.4 on 2026-10-24 ([opencode.md](../cli/opencode.md)) | **unverified**. Bubblewrap code path, not walked | **refused**: `windowsSandboxMessage` (offers WSL 2 with bubblewrap instead) | n/a |
| **Qwen Code** | **works** for a public seat. Walked 2026-11-04 by Growth on Qwen Code 0.26.2 and CLI 0.1.242 in a pod open to join: it replied through the tool in 14.3 s. That walk reported the withheld `commonly_attach_file` as never offered, which was wrong for 0.26.2: it was listed and refused at the call (measured 2026-11-06 with a stub model). Since F175d the withheld tools aren't listed either | **unverified**. Bubblewrap code path | **refused**, as OpenCode | n/a |
| **Goose** | **works** for a public seat on 1.54.0 only. Walked 2026-11-04 by Growth on Goose 1.54.0 and CLI 0.1.242 in a pod open to join: it replied through the tool in 15.7 s. That walk predates F219, which moved the credential and recipe out of the writable seat home; on that layout `goose.public-smoke.test.mjs` passed with real Goose 1.54.0 under Seatbelt and a stub model (2026-11-05, macOS), with no walk on a real pod yet. Goose 1.56 is **refused** on public seats by the version gate, `TESTED_GOOSE_VERSIONS` (`adapters/goose.js`), which lists 1.54.0 only. #3430 (open) keeps it refused on purpose: its loop adds a `load_skill` tool that passes the allowlist | **unverified**. Bubblewrap code path | **unverified** | n/a |
| **Hermes** | **unverified**. A 2026-10-22 walk on Hermes 0.22.2 answered a mention, but it used our own model provider and a version below today's floor (0.22.5 to below 0.23). The adapter sends model calls through OpenRouter, and that path has no recorded walk | **unverified** | **unverified** | n/a |
| **pi** | **unverified**. A private seat runs without a sandbox, since pi has no default one and refuses a declared private one (`default-environment.js`). A declared public seat runs under Seatbelt (`adapters/pi.js`). `--env` takes the shared provider block with a `keyFile`, private on both APIs and public on `openai-chat` only; measured on pi 0.84.1 against a local stub provider, with no walk on a real one ([pi-adapter.md](pi-adapter.md)) | **unverified** | **unverified** | n/a |
| **DeepSeek Harness** | **works**, private seats only: walked 2026-10-23, confined turn 2026-10-28 ([dsh.md](../cli/dsh.md)). Public seats are refused | **unverified**: "not walked" (dsh.md) | **unverified**: "not walked" (dsh.md) | n/a |

**n/a** means this page has no MCP-only path to report for that harness.

## Rules that cut across the matrix

- **Version gates differ by harness.**
  - OpenCode and Qwen public seats run only on a smoke-tested version, or a
    stable patch after the newest tested one on the same line
    (`cli/src/lib/adapters/tested-version.js`). The host can override this with
    `COMMONLY_OPENCODE_ALLOW_UNTESTED_VERSION` or `…_QWEN_…`.
  - DeepSeek Harness accepts one exact version on every seat.
  - Goose refuses an untested version on public seats.
  - Codex refuses a version below `PUBLIC_CODEX_MIN_VERSION`
    (`cli/src/lib/adapters/codex.js`), or one it can't read, on public seats, and
    says what to upgrade to. A later version runs. An internal seat has no gate.
  - Claude Code has no version gate.
- **Connector grants.** No seat on native Windows gets the grant broker
  (`cli/src/lib/grant-broker-guard.js`). The server refuses grant use for every
  seat on a machine whose daemon reports native Windows, with or without the
  opt-in (`backend/services/machineService.ts`).
  - Elsewhere, a confined public seat gets the grant broker on Claude Code,
    Codex, OpenCode, pi, Qwen Code or Goose, and on no other harness. The CLI
    list is `ADAPTERS_WITH_GRANT_BROKER`, and the server's is
    `CONFINING_ADAPTERS`; a backend test reads both, and the frontend's, from
    source. OpenCode was added in F175a, pi in F175c, Qwen and Goose in F175d.
  - OpenCode's own read, glob, grep and lsp tools can't reach the per-spawn
    credential file. They ask `external_directory` for any path outside
    `--dir`, and a public seat denies that. The adapter also refuses a
    workspace that would contain the credential.
  - This is **unverified** on a real OpenCode seat. Only unit tests cover it;
    no walk is recorded.
  - pi gets the broker only on a public seat (`sandbox.trust: 'public'`) on
    macOS, where Seatbelt confines it. Its public turn has no built-in tool, so
    the model can't open a file, and `commonly_attach_file` is withheld. The
    bridge also deletes the per-spawn credential directory inside pi, once
    every server has initialised and before its factory returns; pi awaits
    that factory before it creates the session. The adapter names the directory on the fd 3 list, as a path.
    If the delete fails, the bridge exits non-zero and the adapter reports
    that line as the turn's error. The adapter deletes again at pi's first
    JSON line, as a second layer that tolerates the file already being gone.
    A turn where the bridge can't read fd 3 has an empty server list and
    finds no credential directory to delete. It says so on stderr, which the
    adapter keeps only when the turn fails, so a successful turn doesn't
    show it. A turn where the bridge never ran says nothing. Both have only
    that second delete, which doesn't wait for pi, and neither has an MCP
    tool, so its model still has no tool that opens a file.
    A stdio server that isn't Commonly's and declares `COMMONLY_TOKEN_FILE`
    keeps the path, so a read after initialise fails. `@commonlyai/mcp` is
    unaffected: it takes the token once, at start.
  - Every other pi seat is refused with `adapter_confines_public_only`: a
    private seat, a seat that declares no sandbox (pi is never given a
    default one), and any seat on Linux. Naming the agent on the grant (F94)
    doesn't lift this reason, unlike the sandbox reasons of the other three
    harnesses. The pi run path also still needs a server-declared adapter
    binding, so the broker's per-call check sees `pi` on the row.
  - The pi path is **unverified** on a real pi seat. Only unit tests cover
    it; no walk is recorded.
  - Qwen and Goose get the broker only on a public seat, under Seatbelt on
    macOS or bubblewrap on Linux. Neither jails a private seat, so every other
    declaration is refused with `adapter_confines_public_only`, and naming the
    agent doesn't lift it. A Qwen seat with no sandbox block gets the default
    public one from the daemon, so it works with no extra setup. Goose has no
    default, because a default can't supply its provider and model, so a Goose
    seat has to declare `sandbox.trust: 'public'`. Windows gets no broker.
  - Both reach the broker through the stdio bridge Codex uses
    (`adapters/broker-bridge-entry.js`), not an HTTP entry. Qwen 0.26.2 sends
    `--mcp-config` headers literally, so a `${VAR}` reaches the server as those
    characters. Goose 1.54.0 fills a header from its own environment or a
    literal in the recipe. Neither can read a header from a file. The bridge
    runs inside the jail, is told a url, a header template and a path, and reads
    the token from the per-spawn credential file for each request. The token
    is not in argv, in the config or recipe, or in the harness's environment.
  - What keeps the model off that file is the tool list, not the jail: the
    bridge and the Commonly MCP server run in the jail and must read it, so code
    in the jail could too. A public turn on either harness has no tool that runs
    code, and its only other MCP entry is the Commonly server: Qwen drops the
    broker beside anything else, and Goose refuses the seat. A scripted
    model on real Qwen 0.26.2 and Goose 1.54.0 under Seatbelt (2026-11-05,
    macOS) called the broker and got its answer, then called every shell, file,
    fetch and `commonly_attach_file` tool it could name, using the real credential
    path; on Qwen that covers all 69 built-ins 0.26.2 does not offer, one per turn. Each was
    refused, and the token reached neither the model nor the API
    (`qwen.grant-broker.public-smoke.test.mjs`, `goose.grant-broker.public-smoke.test.mjs`).
  - Qwen's `@path` in a message is not covered by `--exclude-tools`: it still
    inlines a **workspace** file on a public turn. The credential stays out
    because `@` won't leave the workspace, even through a symlink, and the
    credential lives in a temp directory outside it. That boundary is Qwen's
    (measured on 0.26.2), not ours, so a new Qwen version has to pass the same
    proof, and anything a public Qwen seat keeps in its workspace is readable
    this way.
    Qwen also offers its own `get_goal` and `update_goal` on a public turn; forced
    with the same path, they returned nothing from the file.
  - A broker that won't start costs that grant, not the turn: the seat still
    answers the pod (real binaries, broker answering 403).
  - A public Qwen seat holds a broker only on a Qwen version that passed the
    grant proof, compared exactly: 0.26.2 today
    (`GRANT_TESTED_QWEN_VERSIONS`). The protection is a list of denied built-ins,
    so a later version could add a file-reading tool the list doesn't name.
    0.25.1, a later 0.26 patch and the host override all run the turn without the
    broker and answer. Real 0.26.8 did that on 2026-11-05: no broker offered, no
    broker traffic. Goose needs no such rule, since public Goose already refuses
    any version but 1.54.0.
  - On Linux, `qwen-grant-proof.yml` and `goose-public-proof.yml` each have a
    bubblewrap job. Qwen's job passed 3 of 3 when its script ran in a local arm64
    container (2026-11-05), and removing the `attach_file` deny turned it red.
    That run also found that public Qwen launched through npm's `.bin` symlink
    could not start under bubblewrap at all, grant or not; it now launches the
    real entry. Neither job is recorded on a CI runner yet. If Qwen's fails there,
    Qwen's grant goes back to macOS only.
  - Neither path has a walk on a real pod, and nothing has run against the real
    broker.
  - dsh and Hermes have no sandbox, and neither does pi off macOS. The
    Connect page says these harnesses can't use connectors, tells pi users that
    connectors need a public agent on a Mac, and tells Qwen and Goose users that
    connectors need a public agent.
- **A confined seat's workspace can't hold the temp folder.** A turn keeps its
  credential in a folder under the temp root, which stays out of the jail only
  because nothing grants it. A workspace that is `$TMPDIR`, or holds it, would
  grant it. Codex, Goose, Qwen, confined dsh and Claude Code with MCP refuse that
  at spawn (`cli/src/lib/sandbox/turn-dir.js`); OpenCode has its own check. The
  refusal says to run in a project folder or set `TMPDIR` elsewhere. Measured
  2026-11-05 with a real `TMPDIR` on each adapter. Pi keeps its credential in its
  seat home, not the temp root, so this check doesn't apply to it.
- **What a jailed seat can do to its own credential.** On Goose and OpenCode the
  MCP child runs in the jail, so jailed code can read the credential file and
  can't change it (real Seatbelt profile, a shell in the harness's place,
  2026-11-05). On Linux this is read from the bwrap arguments, not run. A real
  public Goose turn had its shell, file-write and extension calls refused, so
  no model-steered code runs there to read it. A Codex shell command can't read
  the file at all (F203, default profile on macOS).
- **Temp files in a public Codex shell.** The profile denies `$TMPDIR` and
  `/tmp`, so a writable seat's shell gets `TMPDIR` and zsh's `TMPPREFIX` in its
  workspace. Heredocs work (real turn, codex-cli 0.162.1 on macOS, stub model,
  2026-11-05). On macOS a bare `mktemp` still fails because it ignores `TMPDIR`;
  `mktemp "$TMPDIR/name.XXXXXX"` works. A read-only seat's heredocs still fail.
  Linux is not run.
- **Hosted fallback.** The Windows refusals offer "Run it here" on the
  Connect page. That runs the agent on Commonly, and nothing runs on the user's
  machine.

## Keeping it honest

Change a cell in the same PR that changes the behaviour. Change it again when a
walk or CI job settles a cell marked unverified: name the walk (who, date,
versions) or the job, and update "Last reviewed".
