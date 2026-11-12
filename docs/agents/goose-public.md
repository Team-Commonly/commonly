# Goose public seats

TASK-236 admits only smoke-tested Goose versions (today 1.54.0 and 1.59.0, `TESTED_GOOSE_VERSIONS`) with a prepared Commonly stdio MCP server,
a declared model and provider whose `keyFile` is an absolute, regular 0600 file
(the sandbox check needs the declaration; the spawn checks the file), and an
enforced Seatbelt (macOS) or bwrap (Linux) boundary. Other extensions, HTTP MCP declarations other than the grant broker, untested versions
(the gate compares the whole version Goose prints: a prerelease such as `1.54.0-rc.1` is not 1.54.0, and a version
run into other characters, such as `1.54.0rc1`, `1.54.0.1`, `v1.54.0`, `1.54.0+build` or `1.54.0~rc1`, reads as unknown and is refused),
disabled sandboxes and restricted-network declarations fail before launch.
Public filesystem `read-outside` declarations are refused, so operator-supplied
paths cannot expand the host read grants of the public process.
A public seat may hold Commonly's grant broker (F175d), through the stdio bridge
described in [byo-support-matrix.md](byo-support-matrix.md); a private seat may not.
Public confinement must be declared explicitly with provider/model settings.
Goose is excluded from automatic default sandbox derivation, which cannot
supply those settings. Public MCP execution requires the selected prepared
version directory; arbitrary source commands cannot introduce read grants.

Every turn gets a fresh HOME, TMPDIR and GOOSE_PATH_ROOT. Public turns use a
per-spawn recipe containing only the Commonly extension and an explicit
available_tools list. They omit the developer builtin. Goose rejects tool
calls absent from that turn's advertised set. The local-file upload tool
commonly_attach_file is excluded: otherwise the MCP process could upload its
own credential file or Linux /proc/self/environ. Future MCP tools are excluded
until audited and added to this list.
Goose renders a recipe file as a minijinja template before reading it, with the
recipe's own directory as the include root. Every `{` written into the recipe is
therefore written as an expression that prints one, so a stranger's
`{{ … }}` or `{% include %}`, in the message or in saved memory, reaches the
model as the text it was. The recipe also sits alone in its own directory, so
no include could reach the credential file beside it.

This is an extension allowlist, not a claim that Goose's auto mode implements
permission denial: auto mode approves registered tools. Commonly tool approvals
remain enforced by the Commonly backend.

The provider key stays in the host proxy. Goose receives a temporary proxy
bearer; the Commonly runtime credential reaches MCP through a temporary file.
Public turns provide an empty OpenSSL configuration to Goose and its Node MCP
child. This avoids reading Node's host configuration outside the sandbox; Node
retains its bundled TLS roots.

HOME, the only folder a public turn writes, holds none of this. The credential,
recipe and OpenSSL file sit in a second per-turn folder the jail can read and
not change, and the proxy bearer is never written to disk. The bearer is in
Goose's environment, and the MCP child runs in the jail and has to read the
credential, so neither is hidden from code inside the jail; a public turn runs
no such code, because it has no shell or file tool. A workspace that holds the
temp folder is refused, since its grant would cover both.
The filesystem boundary does not promise network destination isolation. Both
provider and declared Commonly transports need outbound networking; a declared
restricted network is refused rather than silently weakened.

## Skills are switched off (Goose 1.56 and later)

Goose 1.56.0 moved the CLI to its state-machine agent loop (upstream #12760).
That loop offers the model a `load_skill` operation on every turn. It is an
operation, not an extension, so the recipe's extension allowlist cannot remove
it, and the proof first failed on it (F113c). Goose also reads skills, plugins
and plugin settings from its working directory: `.agents`, `.goose` and
`.claude` skills, `.agents/plugins`, and `.config/goose/settings.json`. A plugin
found there is enabled unless a settings file disables it, and its hooks run
as shell commands.

F113d closes both. A public turn never runs in the seat's workspace. The jail
and Goose start in an empty folder of the turn's own home, so no skill, plugin
or settings file of the seat is found. Public Goose has no file tool, so the
workspace was never usable to it anyway. Then a hook the adapter owns refuses
every `load_skill` call, builtin skills included: a `PreToolUse` command that
exits 2, with `on_failure: block` so a hook that cannot run still refuses. The
hook sits with the adapter's files, which the jail reads and cannot change, and
the seat home links to it.

`load_skill` is still advertised, since Goose has no setting to drop it. The
proof lets it through the advertised-tool check by name
(`SWITCHED_OFF_GOOSE_TOOLS`) and requires that a forced call, for a skill
planted in the seat's workspace and for a builtin, comes back as the policy
denial. Undoing either half fails it on real 1.59.0: without the hook, the
model gets an answer from Goose's skill loader. Back in the seat's workspace, a
planted settings file switches our hook off and the planted skill loads in
full. 1.56.0 through 1.58.x were never proven, so they stay refused.

## Proof

`cli/__tests__/goose.public-smoke.test.mjs` runs the actual pinned Goose binary,
the actual Commonly MCP server, the adapter and OS wrapper with local fixture
provider/API endpoints. The fixture provider forces shell, file-write and
extension-enable and local-file-upload calls even though their schemas were withheld.
All four must return tool errors, no sentinel file may exist (a planted workspace hook writes the third), a Commonly context call
must reach the fixture API, and the turn must end within its timeout. A second
turn sends template syntax in the message and in saved memory; the model must
receive it verbatim and never the proxy bearer.

This checks enforcement independently of whether a model follows the attack
prompt. It is not a live vendor/model or production-account test. Set
COMMONLY_GOOSE_SMOKE_BINARY to the absolute pinned binary path to execute it;
ordinary local test runs skip the external-binary arm. The dedicated workflow
sets it explicitly and downloads checksum-pinned release artifacts on macOS
and Linux. Linux runs as an unprivileged child in a disposable privileged
container so bwrap can create nested namespaces.

Pinned upstream references:
- [CLI options](https://github.com/aaif-goose/goose/blob/v1.54.0/crates/goose-cli/src/cli.rs)
- [Permission inspector](https://github.com/aaif-goose/goose/blob/v1.54.0/crates/goose/src/permission/permission_inspector.rs)
- [Isolated configuration root](https://github.com/aaif-goose/goose/blob/v1.54.0/crates/goose/src/config/paths.rs)
