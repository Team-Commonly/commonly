# Private Codex seats: the `commonly_private` profile

A **private** Codex seat is one that doesn't declare `sandbox.trust: 'public'`:
your own agent, in pods you trust. It runs under a Codex permission profile,
`commonly_private`: on macOS since F387, and on Linux since F444, where Codex
enforces it with bubblewrap. A cloud-codex pod keeps its own policy.

## What the profile allows and denies

| | Private seat (`commonly_private`) | Public seat (`commonly_public`) |
|---|---|---|
| Read the disk | yes, all of it except the denied folders | only Codex's minimal set and the workspace |
| Write | the workspace; what a commit writes in `.git` (below); one temp folder of the turn's own | the workspace |
| Network | on | off |
| Shell environment | inherited, with Codex's secret-name filter on; `TMPDIR`, `TMPPREFIX` and `xcrun_db` point at the turn's temp folder | an allowlist (`PATH`, `HOME`, `LANG` …) |
| Denied | `~/.commonly` (every seat's tokens and state; the seat's own workspace stays open), `~/.claude`, the Codex home (`~/.codex`, and `$CODEX_HOME` when it is elsewhere; on Linux the seat runs from a home of its own instead, below), other seats' Codex homes, `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.kube`, `~/.docker`, `~/.netrc`, `~/.config/gcloud`, the temp roots (`$TMPDIR`, `/private/tmp`) | the same secret folders, plus `~/.config` and everything not admitted |
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

Anything that writes git config therefore doesn't stick, and some of it exits
0. `git push -u origin <branch>` pushes, prints `could not write config file`
and records no upstream, so a later bare `git push` or `git pull` fails with
"no upstream". `git remote add`, `git branch -u` and `git config` fail the same
way. Push with the remote and branch named, `git push origin <branch>` (measured
on codex-cli 0.162.1).

**On Linux.** Codex runs its sandbox helper from `<Codex home>/tmp/arg0-linux`
inside bubblewrap, so the home a seat runs from can't be denied whole: that stops
every turn at start (`bwrap: execvp codex-linux-sandbox: Permission denied`), and
a read key for `tmp` under a denied home doesn't lift it. So on Linux a private
seat runs with **a Codex home of its own** (F445), under
`~/.local/state/commonly/codex-private-homes/`, beside the public seats' homes:

- **It starts with no history.** Nothing is copied from the shared `~/.codex` (or
  your `$CODEX_HOME`), which holds your other Codex sessions' history, logs and
  databases: that is what the seat is kept away from. A thread the seat started
  in the shared home before F445 doesn't resume; its next turn starts a new
  one. What the agent is meant to remember lives in its Commonly memory, so
  nothing it was given to keep is lost.
- **Your own setup is carried over** as links Codex follows outside the sandbox:
  `auth.json` (your login), `config.toml` (a private seat keeps your config) and
  `AGENTS.md`. A file the seat's Codex writes in its own home is its own and is
  kept; a link to a login you removed is dropped. Not walked: whether Codex
  refreshes a ChatGPT login by writing through the link or by replacing the
  file. If it replaces it, the seat keeps that copy as its own, stops following
  your login, and your `~/.codex` keeps the token the refresh replaced.
- **What it can't read:** the shared home, the public seats' homes and every other
  private seat's home, denied whole, so another session writing there, under
  any name and at any moment, stays out of reach. In its own home everything is
  denied except the helper folder: each entry present when the turn starts, plus
  the names Codex writes (`auth.json`, `config.toml`, `sessions`,
  `history.jsonl`, its SQLite databases with their `-wal`, `-shm` and
  `-journal`) even while they are absent. There are no glob keys: Codex's `*`
  crosses `/`, and a glob that matched a file inside a folder already denied
  stopped every turn at start. What the own home holds that a key misses is the
  seat's own.
- **What's left:** another private seat's home that is created during the turn
  is denied from the next one. Until then, what that seat's first turn writes
  there (its new thread, its logs) is readable to this turn's commands. Two
  instances of one agent (`name` and `name@instance`) share one home, as
  they share a public one.

Everything else is the macOS key set: on Linux a write key inside a denied
folder works, so the workspace under `~/.commonly` and the shell's temp folder
under `/tmp` stay where they are. A denied folder there reads as missing ("No
such file or directory"), not "Permission denied". macOS keeps running a private
seat from the shared home, denied whole by Seatbelt, which also hides what
appears there later.

## Where it doesn't apply

- **A cloud-codex pod.** bwrap can't run in a standard k8s container, and the
  pod is the boundary there, so the deployment sets
  `COMMONLY_CODEX_TRUSTED_PERIMETER=1` and the seat keeps the pod's own policy.
  Only the exact value `1` counts (`cli/src/lib/sandbox/codex-perimeter.js`).
- **Linux where bubblewrap can't start.** Not installed, or refused a
  namespace (Ubuntu 24.04's AppArmor, as for a public seat): `agent run`
  refuses a private Codex seat before its first poll, with the fix for that
  host (install bubblewrap, or the 24.04 AppArmor profile), the hosted route,
  and `commonly agent run <name> --unsandboxed`. That is the same opt-in as
  Windows (D245): it runs unconfined by your own choice, only while every pod
  is confirmed private (re-read before each turn), with no connector grants.
  It works in the foreground; the daemon's `--unsandboxed` stays
  Windows-only. With bubblewrap working, the flag still runs it unconfined when
  every pod is private, and when one isn't, the run says the flag was not
  applied and stays in the sandbox. Before F387 a private Codex seat on Linux
  ran with no sandbox, without being asked.
- **Native Windows with `--unsandboxed`.** Codex can't enforce a profile's read
  denies there, so a private Codex seat runs on native Windows only by your own
  opt-in, and then without an OS sandbox (D245; [byo-support-matrix.md](../agents/byo-support-matrix.md)).

## What it needs

- **Codex `PUBLIC_CODEX_MIN_VERSION` or newer**, the same floor as a public seat:
  older versions aren't tested with these keys, so the turn is refused with
  "private seat refused this turn … Upgrade Codex".
- **Bubblewrap that starts a sandbox, on Linux** (above).

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

**Linux** (F444, 2026-11-11), with `byo-linux.yml` dispatched with
`walk=private-codex`: this checkout's CLI, codex-cli 0.164.0 and bubblewrap, on
ubuntu-22.04 as it comes and on ubuntu-24.04 with Ubuntu's bwrap AppArmor profile
loaded. No model and no secrets: `cli/scripts/codex-private-linux-probe.mjs`
builds a home with a marker in every place the seat must not reach, then runs the
adapter's own keys through `codex sandbox`, and one real turn through the adapter
with a stub model that runs the same script through Codex's shell tool. Both
passed on both runners: a workspace write, a heredoc, the turn's `TMPDIR` and a
commit worked, and `~/.config/gh` read; another seat's token and workspace,
Commonly state, the Codex login and sessions, `~/.ssh` and another turn's token
in `/tmp` gave back no marker; another turn's reply file, a hook and
`git config` were refused. The same probe passes on macOS. The keys the macOS
profile used stopped that turn at start, which is what the probe's `rules` phase
records, with the Linux behaviour of each kind of key.

Not walked on Linux: a real model, a person's own Codex login (through the
linked `auth.json`, including a ChatGPT login refreshing itself), the daemon, and
a git worktree.

Code: `privatePermissionProfileFlags`, `privateCodexHomeDenies` and
`preparePrivateCodexHome` in
`cli/src/lib/adapters/codex.js`; the bubblewrap check in `hostSandboxRefusal`
(`cli/src/lib/sandbox/host-check.js`); the opt-in in `codexUnconfinedForRun`
(`cli/src/lib/sandbox/windows-unsandboxed.js`).
