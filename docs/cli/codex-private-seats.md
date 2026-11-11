# Private Codex seats: the `commonly_private` profile

A **private** Codex seat is one that doesn't declare `sandbox.trust: 'public'`:
your own agent, in pods you trust. Since F387 it runs under a Codex permission
profile, `commonly_private`, everywhere except a cloud-codex pod.

## What the profile allows and denies

| | Private seat (`commonly_private`) | Public seat (`commonly_public`) |
|---|---|---|
| Read the disk | yes, all of it except the denied folders | only Codex's minimal set and the workspace |
| Write | the workspace; what a commit writes in `.git` (below); one temp folder of the turn's own | the workspace |
| Network | on | off |
| Shell environment | inherited, with Codex's secret-name filter on; `TMPDIR`, `TMPPREFIX` and `xcrun_db` point at the turn's temp folder | an allowlist (`PATH`, `HOME`, `LANG` …) |
| Denied | `~/.commonly` (every seat's tokens and state; the seat's own workspace stays open), `~/.claude`, `~/.codex`, `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.kube`, `~/.docker`, `~/.netrc`, `~/.config/gcloud`, the temp roots (`$TMPDIR`, `/private/tmp`) | the same secret folders, plus `~/.config` and everything not admitted |
| Approvals | never asked; a denied action goes back to the model | the same |
| Its own `config.toml` | kept (the profile's `-c` keys still win over it) | ignored |

**This is not a sandbox for untrusted input.** A private seat can read most of
the disk and reach the network, so anyone who can direct it can have it read
and send what it can see. It removes the host secrets the seat doesn't use
itself. Public seats keep the strict profile.

A credential the seat uses itself stays readable to its tools. On macOS `gh`
keeps its login in the keychain, and a shell command the seat runs can reach
it, so `gh` works under the profile. `~/.config/gh` is readable on purpose: on
Linux without a keyring its `hosts.yml` holds the gh token in plain text. So
are `~/.git-credentials` and `~/.npmrc`, which git and npm use, and everything
else the denies don't name: `~/.pypirc`, other tools' tokens under `~/.config`,
shell history, browser profiles. That is what "readable disk" means.

**The temp roots.** Every seat's per-turn folder sits in the user temp root:
its runtime token and the reply file Codex posts from. So the temp roots are
denied whole, and the shell gets one folder inside its own turn's, as `TMPDIR`
(and `TMPPREFIX`, which zsh takes heredoc files from). Codex itself, and the
MCP server that reads the token, run outside the profile. macOS's `/usr/bin`
tools are xcrun shims that keep a cache in the user temp root and print an
error on every call when they can't, so `xcrun_db` points the cache into the
turn's folder too.

**`.git`.** Codex keeps a workspace's `.git` read-only even inside a writable
root, and only an explicit absolute key opens it. The profile opens what a
commit writes and nothing that runs code: `.git` is writable, but its `config`,
`config.worktree` and `hooks` stay read-only. A hook or a config-defined
program (`core.fsmonitor`, a filter) would run as you in every later git
command there, outside any sandbox. Renaming over them is refused too. In a git
worktree the seat writes its own admin folder and the shared repository's
`objects`, `refs`, `logs` and `packed-refs`, never that repository's `config` or
`hooks`. A worktree whose repository lies under `~/.commonly` can't commit:
git can't resolve the path through the denied folder.

## Where it doesn't apply

- **A cloud-codex pod.** bwrap can't run in a standard k8s container, and the
  pod is the boundary there, so the deployment sets
  `COMMONLY_CODEX_TRUSTED_PERIMETER=1` and the seat keeps the pod's own policy.
  Only the exact value `1` counts (`cli/src/lib/sandbox/codex-perimeter.js`).
- **Native Windows with `--unsandboxed`.** Codex can't enforce a profile's read
  denies there, so a private Codex seat runs on native Windows only by your own
  opt-in, and then without an OS sandbox (D245; [byo-support-matrix.md](../agents/byo-support-matrix.md)).

## What it needs

- **Codex `PUBLIC_CODEX_MIN_VERSION` or newer**, the same floor as a public seat:
  older versions aren't tested with these keys, so the turn is refused with
  "private seat refused this turn … Upgrade Codex".
- **Bubblewrap on Linux.** Codex enforces the profile with it. A private seat on
  Linux without it is refused at start, with the install step
  (`sudo apt install bubblewrap`) and the hosted option. It never falls back to
  running without a sandbox.

## How it was checked

On macOS, codex-cli 0.162.1, with the adapter's own flags applied through
`codex sandbox` (no model call), from a workspace under
`~/.commonly/workspaces/`: workspace writes worked, Homebrew git ran,
`gh api user` answered from the keychain login, the network was reachable;
`~/.ssh`, `~/.commonly/tokens` and another seat's workspace were denied. A
user `config.toml` setting `sandbox_mode = "danger-full-access"`,
`default_permissions = ":danger-no-sandbox"` or its own
`[permissions.commonly_public]` table did not override the profile.

With the same tool: another turn's token and reply file in the temp root were
refused, the turn's own `TMPDIR` and a heredoc worked, a commit worked in a
plain repo and in a worktree, and writing a hook, `git config`, or renaming
over `config` or `hooks` were refused, in the workspace's repository and in a
worktree's shared one.

Then one real turn, 2026-11-11, same Codex, through the adapter with an isolated
`CODEX_HOME` (not `HOME`, which would lose the keychain `gh` login): the seat
committed in its workspace and `gh api user` answered. A script it ran was
refused `~/.ssh`, another seat's file under `~/.commonly`, and another turn's
token and reply file in the temp root ("Operation not permitted"), and wrote its
own `TMPDIR`. No xcrun cache errors.

**A model asked to read a denied path may decline instead of trying**, because
Codex lists the denied paths to it, so a check that a path is refused has to run
the read from a script. The first live commit failed on `.git/index.lock`,
which is how the `.git` key was found.

Not walked: Linux. There Codex enforces the same keys with bubblewrap, and the
denied temp root is `/tmp`.

Code: `privatePermissionProfileFlags` in `cli/src/lib/adapters/codex.js`; the
Linux refusal in `hostSandboxRefusal` (`cli/src/lib/sandbox/host-check.js`).
