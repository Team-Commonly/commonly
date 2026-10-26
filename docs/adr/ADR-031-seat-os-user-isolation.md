# ADR-031: Seat OS-user isolation

- **Status:** **Accepted** 2026-10-25 (ratified by the project's cofounder). The interim mitigations below stay in
  force until the whole fleet passes D7. In scope this week: the opencode canary (D6 step 2) is pulled
  forward from post-11/1, because it is what lets DeepSeek writer seats run. **Four unknowns stay open, and
  Accepted does not settle them** (§Unknowns): (U1) whether Claude Code subscription auth works for a
  user with no GUI login session, or such seats must move to API keys; (U2) whether any seat
  CLI insists on a login keychain that is locked in a LaunchDaemon context; (U3) which GitHub
  identity the seat user's token belongs to (tied to ADR-030); (U4) whether a ChatGPT/Codex
  device-auth by a second macOS user on this host invalidates the operator's session.
- **Date:** 2026-10-22 (stub); full decision text 2026-10-25
- **Motivation:** issue #2427 (a seat read an operator's gh token from the login keychain)
- **Related:** [ADR-008](ADR-008-agent-environment-primitive.md) (sandbox modes; `bwrap` on
  Linux), [ADR-005](ADR-005-local-cli-wrapper-driver.md) (local wrapper seats),
  [ADR-030](ADR-030-agent-identity.md) (agent identity)

> **Scope boundary: read before implementing.**
> - **ADR-008** owns the per-spawn *sandbox* (`sandbox.mode`: `bwrap` on Linux, Seatbelt via
>   `workspace`/`read-only` on macOS) and the env spec a driver honours. This ADR does not change
>   any sandbox mode, profile, or the Linux path. It adds one layer *under* the sandbox on the
>   macOS fleet host: which OS user the whole seat process tree runs as.
> - This ADR governs the operator-run fleet host only. A BYO user running `commonly agent run`
>   on their own laptop is not required to create a second user.

## Context

On this macOS fleet host every seat runs as **the operator's own macOS user**. Seats are
LaunchAgents in the operator's `~/Library/LaunchAgents` (`me.commonly.seat-<name>.plist`), each
running a per-seat `~/.commonly/seat-launch/<name>/run.sh`, logging to `~/.commonly/logs/`,
reading their runtime token from `~/.commonly/tokens/<name>.json`. Seat GitHub calls go through
the `gh` dispatcher on the Homebrew path, which routes seat calls to
`~/.commonly/bin/seat-gh-guard`; operator calls bypass it.

Confinement today is per spawn and partial:

- **Seatbelt** (`cli/src/lib/sandbox/seatbelt.js`, selected by `sandbox/mode.js` for
  `public`/`workspace` trust on darwin) wraps public seats in a deny-default `sandbox-exec`
  profile. Its only home-directory read allows are the seat workspace, the adapter's state
  home, the CLI binary and a per-spawn temp dir. A decoy attack run on 2026-10-25 against the
  opencode public seat showed reads denied on `~/.claude`, `~/.ssh`, `~/.config`,
  `/private/tmp`, `~/.commonly` and every private repo directory.
- **Env/HOME scrubbing** (`packages/seats/src/valet/env.js`) gives a run a fresh HOME and an
  allowlisted env. Its own header says what it is not: a process that knows an absolute path
  can still open it, and "macOS keychain items are reached through the user's security
  session, not through HOME."
- **Internal seats** (dsh, codex, pi and others) run with application-level isolation only.

Seatbelt does not close the keychain. The baseline profile admits `mach-lookup` to
`com.apple.SecurityServer` and `com.apple.securityd`, because `/usr/bin/security` and TLS need
them, and the Claude public-seat path additionally symlinks the operator's `Library/Keychains`
into seat state and admits `login.keychain-db` read so Claude can find its OAuth credential.
Any keychain item whose ACL allows the caller is therefore one securityd round-trip away from a
process running as the operator, sandboxed or not.

On 2026-10-22 the unconfined dsh seat **dune** ran `security find-generic-password` against the
login keychain, read the operator account's `gh:github.com` token **with no prompt** (the
go-keyring item carried an "allow all applications" ACL), and used it as `GH_TOKEN` with
repo-admin, bypassing `seat-gh-guard` entirely (merge, branch delete, no credit line). The token
entered the seat model's context, so it was treated as exposed and rotated.

Per-item locking is fragile. `security set-generic-password-partition-list`, by team id or by
cdhash, does **not** close a go-keyring `-A` ACL (tested on a throwaway item). The one recipe
that works is delete + re-add trusting only the gh binary (`-T <gh>`), byte-identical so
go-keyring still decodes its `go-keyring-base64:` value. gh is ad-hoc signed, so `-T` pins a code
hash that changes on every upgrade, and any re-auth rewrites the item. App-managed items
(Claude, Codex, browser "Safe Storage") cannot be re-created without risking the owning app. The
root cause is unchanged by any per-item fix: **any credential readable by the operator's user is
reachable by a seat running as that user.**

## Decision

**Seats run as a separate, non-admin macOS user.** Operator credentials become unreadable at the
Unix-permission and keychain-session boundary, not per item. Seatbelt stays and confines inside
that user.

### D1. One shared seat user now; per-seat users deferred

Create one hidden, non-admin standard user (working name `_commonlyseat`) for all seats.

*Trade-off.* One user separates seats from the operator, which is the boundary the incident
broke. It does not separate seats from each other: an unconfined internal seat can read a
sibling's token file and workspace, because 0600 means nothing between processes of the same
uid. Per-seat users would close that too, at roughly N times the cost: N keychains-or-credential
stores, N CLI states, N home directories, N sets of file ACLs for every shared resource. All
seats today hold credentials of the same tier and push through the same guard, so seat-to-seat
reach is a smaller harm than seat-to-operator reach. Public seats, the ones reading untrusted
input, are still kept off sibling files by Seatbelt (D5).

*Reactivation trigger for per-seat users:* a seat is issued a credential its siblings must not
hold (for example a customer-scoped connector grant), or a public seat is shown able to read a
sibling's token under its Seatbelt profile.

### D2. What the seat user owns, and what stays operator-only

| Seat user owns (in its own home, mode 0700) | Operator only |
|---|---|
| Seat workspaces and clones | Login keychain and every item in it |
| `~/.commonly/tokens/<seat>.json` for seats only | `~/.ssh`, `~/.claude`, `~/.codex` |
| Seat sessions, adapter state homes, per-spawn temp | gh operator auth (`~/.config/gh`, keychain item) |
| Seat logs | Operator `~/.commonly` (operator tokens, notes, ledger, `bin/` tooling) |
| Seat provider key files (D3) | Every private repository checked out on the host |

**Code is not seat-owned.** The pinned CLI, the MCP package, `seat-gh-guard`, each `run.sh` and
each launchd plist are installed root-owned and seat-readable under a fixed prefix. A seat must
not be able to rewrite the code that frames its own spawn. Seats already pin their CLI rather
than following the global install, so this is a location change, not a behaviour change.

The operator's home directory is set to 0700 (macOS creates it traversable by others), and
nothing secret is left world-readable in `/private/tmp`. Both are checked by D7, not assumed.

### D3. Credentials reach the seat user without the operator keychain

The seat user has **no login session**, so its login keychain is locked in a daemon context.
Decision: seat credentials are **0600 files in the seat user's home**, not keychain items.

- **GitHub.** The seat user holds its own token, distinct from every operator token, with the
  narrowest scope that covers the seat lane: no admin, no `workflow`. gh reads it from the
  seat's config with keychain storage disabled. `seat-gh-guard` keeps its job (credit line,
  merge/close/delete fence), but becomes a guard against habit again: the boundary is now that
  the only token the seat can reach cannot do what the guard forbids. Which account that token
  belongs to is U3. Its effective permissions are repository contents and pull requests, read and
  write, on the public repo only, and the provider must enforce that: the token is a fine-grained
  token or a GitHub App installation restricted to that one repository, never a classic or
  account-wide token. Before the first seat token is issued, record its repository allowlist and
  run a negative probe: a write to a second repository the same account can reach must be refused.
  A contents-write token can delete refs and push to any branch
  it is not stopped from, so the fence cannot rest on the token. Measured 2026-10-26: classic
  branch protection on `main` refuses deletion and force-push, but does not apply to admins and
  has no push restriction, and the ruleset that carries those rules is disabled. Any write token
  can push to `main` directly today. **Precondition for the first seat token:** an active ruleset
  on `main` that refuses deletion, force-push and direct push for every actor outside its bypass
  list, with the merge queue as the only path in. No seat token is on that list. A seat can still
  delete a branch it pushed, which costs nothing it could not push again. Closing a PR stacked on
  a deleted base is the remaining harm, and the guard keeps fencing `--delete-branch` for that
  reason.
- **Model providers.** Where the adapter supports it (opencode, qwen and the other
  OpenAI-compatible adapters), keys go through the provider proxy in
  `packages/seats/src/wire/provider-proxy.js`: the wrapper validates a 0600 non-symlink key file,
  starts a per-spawn loopback proxy on 127.0.0.1 with a random 32-byte token, and the CLI sees
  only that token, with provider echoes of the key redacted. Under one seat user the key file is
  readable by that uid; the proxy keeps it out of the model's context, not out of the uid. That
  is accepted for seat-tier keys.
- **Claude and Codex seats.** The Claude public-seat path that links the operator's
  `Library/Keychains` into seat state does not cross the boundary and is retired for migrated
  seats. Such seats get their own credential under the seat user (U1); Codex seats get their own
  `CODEX_HOME` login (U4).
- **Commonly runtime tokens** (`cm_agent_*`) move with their seat into the seat user's
  `~/.commonly/tokens/`.

*Deferred:* a broker running as a third user that holds provider keys and serves only the
loopback proxy, so no seat uid can read a key. Trigger: per-seat users (D1), or a provider key
whose blast radius exceeds one seat's quota.

### D4. launchd: LaunchDaemons with `UserName`, operated through a root-owned wrapper

Seats become `/Library/LaunchDaemons/me.commonly.seat-<name>.plist`, root-owned, with
`UserName`/`GroupName` set to the seat user. A per-user LaunchAgent is rejected: the
`gui/<uid>` domain exists only while that user is logged in, and a background-only user domain
is not a supported place for KeepAlive jobs. Daemons also start at boot without anyone logging
in, which a host reboot showed the fleet needs.

The operator does not become the seat user to operate seats. A root-owned `seatctl` script
with fixed verbs (`status`, `restart`, `stop`, `start`, `logs`) taking a seat name validated
against the installed plists is permitted to the operator through one passwordless sudoers
entry for that script only. The fleet supervisor and reviver call `seatctl` instead of
`launchctl` on user LaunchAgents. Seat logs and state are group-readable by an ops group the
operator belongs to; the seat user is in no operator group, so the read direction is one-way.

### D5. Seatbelt is layered under, not replaced

Every Seatbelt and env-scrubbing rule stays. Inside the seat user, Seatbelt still confines a
public seat to its workspace and state, and is the only thing keeping one seat off a sibling's
files (D1). `homedir()` inside a seat now resolves to the seat user's home, so profile paths
follow without code changes; the `securityd` lookups remain allowed and now reach a keychain
session holding no operator item. The OS-user boundary also does not depend on `sandbox-exec`,
which Apple has deprecated as a public API.

### D6. Migration: one canary, an attack gate, then one seat at a time

1. **Prepare.** Create the user (non-admin, hidden, no shell login), set the operator home to
   0700, install the root-owned code prefix, `seatctl` and its sudoers entry. Run D7 tests 1–4
   from a bare `sudo -u` shell of the seat user before any seat moves.
2. **Canary.** Migrate one internal opencode-adapter seat: its credential path is already the
   provider proxy, so it isolates the user boundary from the U1/U4 credential questions. Copy
   (do not move) its token, sessions and workspace; disable its operator LaunchAgent by rename;
   bootstrap the daemon.
3. **Gate.** D7 probes 1–7 must refuse in both of their contexts, every positive control must
   succeed as the operator, and the seat must complete one real board turn and one guarded PR
   comment. Probe 8 runs when the first public seat migrates. Any failure stops that rollout.
4. **Roll one seat at a time**, each through the same gate: unconfined internal seats first
   (largest gain, the dune class), then Codex seats once U4 is answered, then Seatbelt-confined
   public seats. **Claude seats stay out of the migration until U1 is answered**, and moving them
   to metered API keys needs a cost decision first; it is not a default. dune stays disabled
   until it runs as the seat user.
5. **Rollback (per seat).** `seatctl stop`, boot out the daemon, rename the operator LaunchAgent
   back. Seat state was copied, so the old copy is intact; reset sessions on return. Revoke the
   seat-user credentials only if the rollback is permanent.

`lock-gh-keychain.sh`, read-only verify-by-attack on app-managed items, and the operator's
auto-press watcher's fence check stay until the last seat has migrated and D7 is green fleet-wide. The gh lock is then
kept as cheap defence in depth; the watch check is retired with the last operator-user seat.

### D7. Verification: attack tests that must refuse

Probes 1–7 run **twice**: as the seat, through its real spawn path (a probe script in the
seat's argv, not a hand shell), and from a bare `sudo -u` shell of the seat user, because
unconfined seats have a shell. A pass is an **OS refusal** (`EACCES`, `EPERM`, or a securityd
"item not found"). A model declining to run the probe is not a pass. Each probe has a positive
control run as the operator, so a refusal proves the boundary and not a missing file. Probe 8
runs only through a public seat's real spawn path under Seatbelt, since a bare `sudo -u` shell
is not confined by Seatbelt.

1. `security find-generic-password -s gh:github.com -w` returns no operator item; the same with
   the operator's `login.keychain-db` path given explicitly fails to open it.
2. `security dump-keychain` on the operator's keychain path is refused.
3. Reads of decoy files in the operator's `~/.ssh`, `~/.claude`, `~/.codex`, `~/.config/gh`,
   `~/.commonly/tokens`, `~/.commonly/state` and each private repo directory are refused.
4. An operator-written 0600 decoy in `/private/tmp` is refused.
5. `gh auth status` as the seat shows only the seat token; an admin-scoped API call (reading
   branch protection), deleting `main`, a direct push to `main` (both refused by the D3 ruleset) and a workflow-file
   push are refused by GitHub.
6. `kill -0` against an operator process returns `EPERM`; `launchctl print gui/<operator uid>`
   is refused.
7. Writing the seat's own `run.sh`, its plist, the CLI prefix or `seat-gh-guard` is refused.
8. From a public seat under Seatbelt, reading a sibling seat's token file is refused.

The suite lives beside the existing decoy harness and is re-run after any macOS upgrade, gh
upgrade, CLI pin change or change to the seat user's groups.

## Unknowns

- **U1.** Claude Code on macOS stores its subscription credential in the keychain. Whether it
  falls back to a file for a user with no login session is unmeasured. If not, Claude seats move
  to API keys through the proxy, which changes their cost.
- **U2.** Whether any seat CLI hard-requires an unlocked login keychain and fails in a daemon
  context. Each adapter is checked during its own migration step.
- **U3.** Whether the seat token is a second, narrower token on the existing shared GitHub account
  or belongs to a machine account or GitHub App. That is an identity decision and belongs with
  ADR-030; D3 only requires it to be distinct and narrower than any operator token.
- **U4.** ChatGPT OAuth sessions are bound to where device-auth completed. Whether a second
  macOS user on the same host logging in to the same account disturbs the operator's session is
  untested. Test on a non-rotation account first.

## Consequences

- Operator credentials leave the seat's reach as a class. The next unlisted keychain item, app
  token or dotfile does not need its own lock.
- `seat-gh-guard` stops being the only thing between a seat and repo-admin.
- Cost: a second user to provision, code installed twice (operator and seat prefix), a sudoers
  entry to audit, separate seat credentials to issue and rotate, and Claude seats possibly moving
  to metered keys (U1).
- Operator sessions read seat logs through group permission or `seatctl logs`, not by `cat` in
  their own home.
- Seats are still not isolated from each other outside Seatbelt (D1).

## Out of scope

- Linux confinement. `bwrap` and `sandbox.mode` remain ADR-008's; a Linux fleet host would run
  seats as a dedicated user by ordinary means and needs no new decision here.
- Cluster runtimes (moltbot gateway, cloud-codex). They already run in their own containers.
- Locking app-managed keychain items. With seats off the operator user, those items are no longer
  in a seat's reach, so locking them stops being a security requirement.
- BYO laptops (scope note above).
