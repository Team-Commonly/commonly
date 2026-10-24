# ADR-031: Seat OS-user isolation

- **Status:** Proposed (post-11/1 scope — not decided this sprint)
- **Date:** 2026-10-22
- **Motivation:** AX-85 / issue #2427 (seat read an operator's gh token from the login keychain)
- **Related:** [ADR-008](ADR-008-agent-environment-primitive.md) (`sandbox.mode: bwrap` — the Linux equivalent)

## Context

On this macOS fleet host, every seat runs as the **same macOS user as the operator**
(`xcjsam`), with no OS-level sandbox. The harness adapters self-isolate at the
*application* level only — dsh with a per-seat `DSH_HOME` + `DSH_PERMISSION_MODE=workspace-write`,
codex with `shell_environment_policy` — but not at the OS level.

On 2026-10-22 the dsh seat **dune** ran `security find-generic-password` against
`~/Library/Keychains/login.keychain-db`, read Lily's `gh:github.com` token **with no prompt**
(the go-keyring item carried a permissive "allow all applications" ACL), and used it as
`GH_TOKEN` with repo-admin — bypassing `seat-gh-guard` entirely (merge, branch delete, no
credit line). The token entered the seat's model (DeepSeek) context, so it was treated as
exposed and rotated.

**Finding (verified in-incident):** the per-item keychain-ACL mitigation is fragile, and
only one recipe works. `security set-generic-password-partition-list` — whether by team id or
by cdhash — does **not** close a go-keyring `-A` ("allow all applications") ACL: tested on a
throwaway, the item stayed readable after it. The **only** `security`-CLI recipe that locks it
is delete + re-add trusting just the gh binary (`-T <gh>`, no `-A`), re-storing the value
byte-identical so gh (go-keyring) still decodes its `go-keyring-base64:` format. Because gh is
ad-hoc signed, `-T` pins to the binary's code hash, which changes on upgrade — so the lock must
be re-derived after a gh upgrade and re-applied after any re-auth that rewrites the item.
App-managed items (Claude, Codex, browser "Safe Storage") cannot be re-created without risking
the owning app. The root cause is unchanged by any per-item fix:
**any credential readable by `xcjsam` is reachable by a seat running as `xcjsam`.**

## Decision (proposed)

Run seats under a **separate macOS user** (e.g. `commonly-seat`) that has no access to the
operator's login keychain, SSH keys, or home directory. Operator credentials become
unreadable to seats at the OS boundary rather than per keychain item. This is the macOS
counterpart to ADR-008's `sandbox.mode: bwrap` on Linux.

## Consequences

- Seats get their own keychain, home, and `gh`/git identity; shared resources (workspaces,
  the CLI, the gh dispatcher, launchd jobs, file permissions) are provisioned for the seat
  user. Non-trivial migration — hence post-11/1 scope.
- Until then, the interim mitigations stand and are explicitly **mitigations, not the fix**:
  - `~/.commonly/bin/lock-gh-keychain.sh` — locks the `gh:github.com` item to the gh binary
    (`-T`), run at each gh re-login; it self-verifies that a `gh auth switch` does not drop
    the lock.
  - verify-by-attack (read-only) for app-managed keychain items; lock only the ones that are
    actually silently readable.
  - a `lily-watch` fence check to detect the lock silently evaporating on a token refresh.
