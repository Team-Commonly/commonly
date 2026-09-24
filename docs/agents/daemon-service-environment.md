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
half-written unit; systemd reloads unit files on change, so an in-place write can
be parsed mid-flight and fail.

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
