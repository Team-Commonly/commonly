# The daemon's service environment

**Written 2026-09-24 on the branch of PR #1859, cut from main `116ac7cb`.** Everything
below is a read of `cli/src/lib/daemon-service.js`, `cli/src/commands/daemon.js`
and `cli/src/lib/adapters/`, plus the unit tests that pin them. It is the doc
TASK-049 asked for: the daemon's login service does **not** inherit the shell
that installed it, and that has cost a fleet of seats at least once.

## What the service is

`commonly daemon install` registers the resident daemon so it survives reboots:

| platform | file | manager |
|---|---|---|
| macOS | `~/Library/LaunchAgents/me.commonly.daemon.plist` | `launchctl`, `KeepAlive` |
| Linux | `~/.config/systemd/user/commonly-daemon.service` | `systemctl --user`, `Restart=always` |

Both run the exact interpreter and CLI entry that performed the install
(resolved at install time), then `daemon run --foreground`.

## The environment it carries

launchd and systemd start a process from a **clean environment**. Nothing from
your interactive shell — not your `export`s, not your `.zshrc` — reaches the
daemon. So the service file must carry explicitly everything the daemon and the
seats it spawns need, and it carries three things:

| variable | who needs it | why |
|---|---|---|
| `PATH` | the children | the daemon spawns `commonly agent run`, which spawns your `claude`/`codex`/`pi` binary **by name**. launchd's default `PATH` has no `/opt/homebrew/bin`, so without this every seat dies at adapter detection |
| `HOME` | the children | seat state, tokens and pi homes live under `~/.commonly` |
| provider keys | the seats' adapters | the pi adapter authenticates to LiteLLM with `COMMONLY_LITELLM_KEY`; the daemon does not read seat credentials, but the adapter it spawns does |

The provider keys are captured **at install time** from the shell that runs
`commonly daemon install`, because that is the only moment the operator's
environment is in reach. An adapter declares which variable it needs
(`adapters/pi.js` → `providerKeyEnv`, collected by `adapters/index.js`), so
adding a provider to an adapter is a one-file change and the daemon does not
need to know which adapter a given seat uses.

## When a key is missing

Three surfaces now say so, in this order:

1. **At install** — a key an adapter declares but the shell does not have is
   named on stdout, and is *not* written into the file (absent is stated, never
   invented):
   `COMMONLY_LITELLM_KEY is not set in this shell, so it is NOT in the service file…`
2. **At bind** — `commonly daemon run` logs one line naming the variable before
   it starts supervising. Not fatal: one missing key must not become a
   whole-machine outage, and the daemon's other seats are unaffected.
3. **At the adapter** — if it still reaches a spawn, the adapter throws
   (`pi adapter: COMMONLY_LITELLM_KEY is not set — the seat's environment must
   carry the provider key`).

## The symptom class, by what you see

| symptom | cause |
|---|---|
| every seat dies "at adapter detection", daemon itself is up | `PATH` — a seat's CLI is not on the service's `PATH` |
| one seat crashes with `… is not set`, other seats fine | that seat's adapter provider key is not in the service environment |
| seats work from a terminal but die when the service starts them | the clean-environment class: anything the interactive shell `export`s |
| seats fine until a key was rotated | the service file holds the **install-time** value; re-run `commonly daemon install` after rotating |

## Adding or rotating a key

```bash
export COMMONLY_LITELLM_KEY=...      # the shell matters: install reads THIS one
commonly daemon install              # rewrites the unit/plist with the key
commonly daemon restart              # the running daemon still holds the old env
```

Read back what the installed service actually carries rather than assuming:

```bash
# macOS
plutil -p ~/Library/LaunchAgents/me.commonly.daemon.plist | grep -A5 EnvironmentVariables
# Linux
systemctl --user show -p Environment commonly-daemon.service
```

## Permissions

The service file is written `0600` (TASK-049). It used to keep the umask
default, which was fine while it held only `PATH` and `HOME`; it can now hold a
provider key, and a key readable by every local user is a key handed to every
local user. This matches the daemon's own credential, which is a `0600` file
under `~/.commonly/daemon/`.

The mode is held by construction, not by the order of two calls: the content is
written to a sibling temp file **created `0600`** and `rename`d over the target.
Two windows make the obvious alternatives insufficient. A write straight to the
target cannot narrow a file an *earlier* install left at `0644` — `writeFileSync`'s
mode applies only at creation, and the old file's mode survives the write — which
is exactly the case every upgrade meets. A `chmod` after the write narrows the
file once the key is already in it. The rename also means a reader never sees a
half-written unit — but note what the reader actually is, because the obvious
version of that claim is false. systemd does **not** re-read a changed unit by
itself: it reports the file as changed on disk and keeps the loaded copy until a
`systemctl --user daemon-reload`. The exposure is a reader *concurrent* with the
write, which is ordinary on a developer box — an install ends by running
`daemon-reload`, any other install on the machine can run one at that same moment,
and `systemctl --user show` reads the file.

The temp is created with `O_EXCL` (`flag: 'wx'`) under a **random** suffix, and
both halves are load-bearing. A predictable name — `<file>.tmp-<pid>` was the
first version — lets a process running as this user, which is every seat this
repo spawns, pre-plant a symlink at that path; the write then follows the link
and the key lands at a path and a mode the writer did not choose (the target's
existing mode is kept, since `mode` applies only at creation). `O_EXCL` refuses
a symlink at the final path component outright, so the race has nothing to win;
the random suffix removes the easy target, and the cleanup removes only a temp
this call created — never a planted path. A failed install therefore unlinks its
own `0600` temp. Note that systemd exposes `Environment=` to
`systemctl --user show`, so a key in the unit is readable by anything running as
that user — putting it in the unit is not a way to hide it from the account.

The launchd half is the same exposure with different instruments, and only the
systemd one was documented above: on macOS the plist's `EnvironmentVariables`
dict is readable with `plutil -p` or `defaults read`, and by any process running
as the same user. `0600` is what keeps that read away from *other* local users;
it does not hide the key from your own account, and no mode can.

Generalised past this file, the rule is a **mode invariant, not a credential-name
check**: any generator that writes a unit carrying an environment dict writes it
`0600` by construction. In this repo that generator is `writeServiceFile`, and a
second one must call it rather than open its own file — otherwise the mode has to
be argued again from scratch, which is how the first version got it wrong. The
rule this replaces is worth naming because it looks equivalent and is not: a grep
for `*_KEY|*_TOKEN|*_SECRET|*_PASSWORD` is a result about variable *names*, not a
measurement of exposure. `*_DSN`, `*_URL` and `*_PROXY` routinely carry
`user:pass@` and match none of those four suffixes, so zero hits says nothing
about whether a secret is in the file.

## Units this repo does not write

This repo generates **two** units, both through `writeServiceFile`:
`me.commonly.daemon.plist` (launchd) and `commonly-daemon.service` (systemd,
`SYSTEMD_UNIT` in `cli/src/lib/daemon-service.js`). A machine running the fleet
also carries units written by tooling outside this repository — same
`EnvironmentVariables` shape, same `0600` question, and no CI here can guard
them, so a grep in this repo would report a clean result about files it cannot
see. They are operator tooling, and the part of this that *is* enforceable in
repo is one line: a second writer of a unit file imports `writeServiceFile`
(which owns the mode) instead of writing the file itself, asserted as a test on
the import rather than a grep for a variable name (wren 72719: no board row for
the units outside the repo, so the import rule is the guard that can exist).

What an operator can run on the machine in question is a locator. It tests the
mode rather than a name, so it stays true for a credential carried in a variable
nobody thought of:

```bash
# macOS — units that are group- or other-readable AND carry an env dict
command find ~/Library/LaunchAgents -name '*.plist' \( -perm -004 -o -perm -040 \) \
  -exec grep -l EnvironmentVariables {} +

# Linux
command find ~/.config/systemd/user -name '*.service' \
  \( -perm -004 -o -perm -040 \) -exec grep -l '^Environment[[:space:]]*=' {} +

# what is actually answering as `find`, before trusting either result
type -a find
```

Five details, each of which cost a measurement to learn:

- **`-perm -004` alone misses group-readable `0640`** — the same exposure with a
  narrower audience, and the plausible mistake of a generator trying to be
  careful. `\( -perm -004 -o -perm -040 \)` finds both and still excludes `0600`.
- **`-perm /044` is not portable:** stock BSD `find` rejects it outright
  (`illegal mode string`). Some environments resolve `find` to a GNU-compatible
  reimplementation (`bfs`) where `/044` *does* work, which is why the OR form is
  the one to ship — it answers the same on both, and the command is meant to run
  on whichever machine the operator has.
- **`grep '^Environment='` misses `Environment =foo`** (vera 73011):
  systemd.syntax ignores whitespace around `=`, so that spelling is legal and a
  tighter anchor skips it — the file carries an env dict while the locator reports
  nothing. `'^Environment[[:space:]]*='` closes that form. Same lesson as
  `-perm -004` above, one line down: an anchor that is *nearly* right returns a
  clean answer about the shape it did not anticipate.
- **`command find`, not `find`:** a shell function named `find` wins over the
  binary, so a bare `find` measures your shell instead of your system. `command`
  bypasses functions and aliases both; a leading backslash does **not** — that
  suppresses aliases only, which is the intuitive repair and the wrong one.
- **`type -a find` is the diagnostic.** `command -v` prints a bare name with no
  path for a function, which is only a signal if you already know to read it that
  way; `type -a` names the function and its source file, and then the binary.
  `-a` is a bash/ksh/zsh feature rather than POSIX, so in a shell that refuses it
  (`dash`, Debian's `/bin/sh`) fall back to `command -v find` — the weaker read
  this bullet warns about, which is the reason to run the locator from bash when
  you can choose.

It is a **locator, not a verdict**: `grep -l EnvironmentVariables` cannot see a
secret carried outside the env dict — a `ProgramArguments` array holding
`--token=…` is a real plist shape — so zero hits is a statement about this
predicate, never about secrets. Group- or other-readable *and* carrying an env
dict is the question worth asking; a clean answer to it is not a clean bill of
health.

## What this does NOT cover

- **A seat that overrides its provider.** `resolveProvider(environment)` honours
  a seat-declared `apiKeyEnv` (`adapters/pi.js`), and the service file carries
  only the registry's declared defaults. Such a seat gets the adapter's own
  error, not the install/bind warning. Named here so the next reader does not
  read the warnings as exhaustive.
- **Other credentials.** The daemon's machine bearer lives in
  `~/.commonly/daemon/` and is loaded from disk, not from the environment; the
  seat token is written per seat by `agent run`. Neither belongs in the service
  file.
- **The `~/.commonly/bin/daemon-run.sh` launcher workaround.** It was the fix
  the original incident needed; with the key carried at install it is no longer
  required. Remove it if you still have one, or the next reader will treat a
  workaround as the supported path.
