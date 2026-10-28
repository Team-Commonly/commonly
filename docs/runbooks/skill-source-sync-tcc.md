# Background LaunchAgents can't read `~/Documents` (macOS TCC)

**Trap:** a macOS background LaunchAgent (`me.commonly.*`) cannot read **file
contents** under `~/Documents`, even as the owning user. The denial surfaces as
`fatal: Unable to read current working directory: Interrupted system call`
(EINTR) — which reads like a transient glitch, not a permission wall — so a job
that reads a repo there fails **silently** and keeps serving stale data.

Earned 2026-10-28: `me.commonly.skill-source-sync` had been skipping every
shared skill-source checkout (all under `~/Documents/workspace`) as
`"on '', not main"` and serving the fleet skills **18 commits stale**, because
`git rev-parse` couldn't read the repo and returned empty.

## Why it happens

`~/Documents` (like `~/Desktop` and `~/Downloads`) is TCC-protected
("Files & Folders"). A process that touches it must either hold the grant or be
able to prompt the user for it. A **background LaunchAgent has no GUI session**,
so the consent prompt can't be shown and the read is denied. Interactive
Terminal / operator sessions already carry the grant, so **the same command
works by hand and fails under launchd** — the confusing part.

The denial is on **reading contents**, not metadata:

| operation under the agent | result |
|---|---|
| `/bin/pwd` | ✅ returns the cwd |
| `ls -lad ~/Documents` and `…/<repo>/.git` | ✅ stat/list allowed |
| `cat …/<repo>/.git/HEAD` | ❌ `Interrupted system call` |
| anything under `~/.commonly`, `/tmp`, `/opt` | ✅ fine |

It is **not** a cwd bug: a shell `cd "$HOME"` and a plist `WorkingDirectory`
both leave it failing (both tried and ruled out). `getcwd()` itself works
(`/bin/pwd` succeeds); it's the file read under `~/Documents` that's blocked.

## Diagnose it

From the agent's context (reproduce under launchd, not your shell):

```sh
launchctl kickstart -k gui/$(id -u)/me.commonly.<job>
# then, decisively — a background agent will fail the second line:
/bin/pwd                              # succeeds
cat ~/Documents/workspace/<repo>/.git/HEAD   # "Interrupted system call" => TCC-blocked
cat ~/.commonly/<any-file>            # succeeds => confirms it's Documents-specific
```

If `cat` under `~/Documents` fails with EINTR while a non-Documents read
succeeds, it's this. `ls` succeeding is **not** evidence of access — it only
stats; you must read file *contents* to see the wall.

## Known-affected jobs (audit 2026-10-28)

- `me.commonly.skill-source-sync` — **was** fully silent; now logs a loud
  `BLOCKED … SKILLS ARE STALE` line and names this runbook.
- `me.commonly.sre-gate-drift` — reads `~/Documents/workspace/commonly`;
  degraded, but self-alerts after 3 failed fetches (its message blames the
  network, not TCC).
- `me.commonly.linkedin-send` — **not** affected: it resolves its repo to its
  own `~/.commonly/repos/commonly-gtm` location and only falls back to
  `~/Documents` as a last resort it never reaches. **This is the pattern to
  copy.**

Every other `me.commonly.*` job's launchd script is clean (no `~/Documents`
reads). A seat whose runtime workspace were set under `~/Documents` would hit
the same wall; none are.

## Fix

**Preferred — relocate (no security setting, no GUI):** keep the script and the
repo it reads under `~/.commonly/repos/` (not TCC-protected), and resolve the
repo path from the cwd's git top-level rather than hardcoding `~/Documents`, the
way `linkedin-send` does:

```sh
if   [ -n "$MY_REPO" ]; then REPO="$MY_REPO"
elif top=$(git rev-parse --show-toplevel 2>/dev/null) \
     && git -C "$top" remote get-url origin 2>/dev/null | grep -q '<repo>'; then
     REPO="$top"
else REPO="$HOME/.commonly/repos/<repo>"; fi
```

Consumers that load from the old path (skill symlinks, operator sessions) move
with it — one coordinated change.

**Not preferred — grant access:** granting Full Disk Access (or a
Files-and-Folders → Documents grant) to the agent is a System Settings action
(**operator's hands, GUI**) and widening it host-wide to `/bin/zsh` is the wrong
default. Don't reach for this unless relocation is impossible.

## Stopgap

Until a degraded job is relocated, run its logic from an **operator session**
(which holds the Documents grant) at each checkpoint — e.g.
`zsh ~/.commonly/bin/skill-source-sync.sh`. The launchd copy keeps logging
`BLOCKED` so the degradation stays visible.
