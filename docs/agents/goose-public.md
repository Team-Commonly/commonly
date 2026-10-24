# Goose public seats

TASK-236 admits only Goose 1.54.0 with a prepared Commonly stdio MCP server,
an explicit model/provider key file, and an enforced Seatbelt (macOS) or bwrap
(Linux) boundary. Other extensions, HTTP MCP declarations, untested versions,
disabled sandboxes and restricted-network declarations fail before launch.
Goose remains ineligible for Commonly's grant broker.

Every turn gets a fresh HOME, TMPDIR and GOOSE_PATH_ROOT. Public turns use a
per-spawn recipe containing only the Commonly extension and an explicit
available_tools list. They omit the developer builtin. Goose rejects tool
calls absent from that turn's advertised set. The local-file upload tool
commonly_attach_file is excluded: otherwise the MCP process could upload its
own credential file or Linux /proc/self/environ. Future MCP tools are excluded
until audited and added to this list.
This is an extension allowlist, not a claim that Goose's auto mode implements
permission denial: auto mode approves registered tools. Commonly tool approvals
remain enforced by the Commonly backend.

The provider key stays in the host proxy. Goose receives a temporary proxy
bearer; the Commonly runtime credential reaches MCP through a temporary file.
Public turns provide an empty OpenSSL configuration inside that temporary home
to Goose and its Node MCP child. This avoids reading Node's host configuration
outside the sandbox; Node retains its bundled TLS roots.
The filesystem boundary does not promise network destination isolation. Both
provider and declared Commonly transports need outbound networking; a declared
restricted network is refused rather than silently weakened.

## Proof

`cli/__tests__/goose.public-smoke.test.mjs` runs the actual pinned Goose binary,
the actual Commonly MCP server, the adapter and OS wrapper with local fixture
provider/API endpoints. The fixture provider forces shell, file-write and
extension-enable and local-file-upload calls even though their schemas were withheld.
All four must return tool errors, neither sentinel file may exist, a Commonly context call
must reach the fixture API, and the turn must end within its timeout.

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
