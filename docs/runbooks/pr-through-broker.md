# Opening a GitHub pull request through the grant broker

TASK-783 (F163, D14). A hosted ("Run it here") agent, or a BYO seat a grant
names (F94), opens a pull request on the connected repository through the
grant broker. It never holds git or a GitHub token. The connection owner
approves every call.

## What the owner grants

A pod grant on a **GitHub App** connection with:

- `writeMode: "write-with-confirm"`;
- `prWrite: true`. It is off unless the body says exactly `true`;
- `tools` that include `github.create_pull_request`, and optionally
  `github.commit_files` (needed by hosted agents, which have no git) and
  `github.push_branch` (for a BYO seat that pushes with git). Read tools may
  ride along. **No other write may be named**: the mint refuses
  `pr_write_other_writes`.

The mint also refuses `pr_write_requires_confirm`, `pr_write_github_only`,
`pr_write_requires_create_pull_request` and `invalid_pr_write`. Naming a BYO
seat (`byoAgents` plus `byoConsent: true`) on a **write** grant needs `prWrite`;
a write grant without it still refuses with `byo_read_only`. A `read` grant
names seats as before, with no `prWrite`. A child grant can drop `prWrite` and
never add it, and a `read` child holds none.

**Behaviour change for existing grants.** A grant minted before this change
that names `github.create_pull_request` or `github.push_branch` holds no
`prWrite`, so those calls now refuse `pr_write_not_granted`. Re-mint the grant
with `prWrite: true`.

The grant form in the app does not offer `prWrite` yet. Until it does, a grant
is minted with `POST /api/grants` under the owner's session.

## What the agent does

1. Reads the issue (`github.get_issue`).
2. `github.commit_files({ branch, base, message, files: [{ path, content }] })`.
   `branch` must be `seat/<its own user id>/...`. A new branch's `base` must be
   the repository's default branch (`base_not_default`). The call parks. At park
   time the server records the commit it will sit on: the branch tip if the
   branch exists, otherwise the default branch's tip.
3. On approval it receives an `approval.resolved` event, with `ending: ran`.
4. `github.create_pull_request({ title, head: <that branch>, base, body })`. This
   call also parks. The approval event's receipt carries the PR `number`.

Every parked call answers `{ status: "pending_approval", approvalId, message }`,
and the message tells the agent the decision arrives as an event. The seat's
`/push` route answers `202` with `error: "pending_owner_approval"`, which the
shipped git remote helper prints.

## The rules the server holds

- **Every PR-write call parks.** The `requiresApproval` flag on the tool
  definition sets this, so a grant's mode cannot unpark a call. The owner's
  approval runs the stored envelope, digest-checked, once. A second decision
  answers 409. A decline and an expiry (24 h, or the grant's expiry if sooner)
  close the call without running it.
- **Heads are `seat/<agentUserId>/` only.** The check runs before parking and
  again at execution, against the seat the call was parked for. `base` is read
  and never written.
- **`commit_files`** writes only text files (mode 100644), at most 50 files and
  512 KiB per call. It refuses `.github/workflows`, `.github/actions` and
  `CODEOWNERS` (the same predicate as the bundle push), `.git` segments,
  traversal and absolute paths. A path with a bidi control, a zero-width
  character or any other format (Cf) character refuses `invalid_path`, so the
  path the owner reads is the path that lands. Content with a NUL byte refuses
  `invalid_content`. A message line that attributes anyone (`Co-authored-by:`,
  `Signed-off-by:`, any `<Word>-by:`, any case) refuses
  `commit_attribution_trailer`. If the branch moved after the call parked, it
  refuses `stale_branch`, and a ref update is never forced.
- **The parent carries the default branch's protected files.** At execution,
  before any object is written, the parent's `.github/workflows`,
  `.github/actions` and every `CODEOWNERS` entry (path, mode and blob or tree
  id, read with `git/trees?recursive=1`) must equal the default tip's. Any
  difference refuses `protected_path_behind_default`; a listing GitHub
  truncates refuses `protected_path_unverifiable`. A new branch is held to the
  default base again at execution, in case it was renamed.
- **No other GitHub write.** A grant that holds `prWrite` or names a BYO seat
  refuses every other write with `write_tool_not_permitted`, and so does a seat
  that uses the grant only because it is named.
- Seat confinement (`judgeSeatConfinement`) is judged on every call. Naming
  never lifts `adapter_cannot_confine` or an unconfined host.
- **The approved call is judged again before it runs.** The grant must still be
  live (otherwise `grant_revoked`, `grant_expired` or `not_in_audience`), and
  `prWrite` must still be on its lineage (`pr_write_not_granted`). The park
  record (`callerConfinement` on the envelope) decides which judgement applies,
  and the agent is then judged live:
  - parked as `hosted`: Commonly must still run the agent. Every active
    installation of it must be on a Commonly-run runtime (`runsOnCommonly`),
    with no machine bound;
  - parked as a seat: the seat must be confinable now, or named now with a
    naming that lifts its refusal.

  Anything else, including a missing record, fails closed with
  `confinement_changed`. Nothing reaches GitHub.
- **The owner's card shows a summary, not the envelope.**
  - A push: repo, head, the base and new commit ids, and the bundle's size.
  - A commit: repo, head, where it lands (`new branch <head> from <base> at
    <sha>`, or `adds to existing branch <head> at <sha>` with no base), the full
    commit message (labelled, cut with a marker past 4,096 characters), and each
    file's text, up to 64 KiB across the commit, with a truncation marker.
  - A pull request: repo, base, head, title, and a 2,000-character preview of
    the body.

  The file text appears only in the connection owner's own pending read. The
  pod card, socket emits and every other member's read carry none of it. The
  bundle stays on the approval row, where only the winning approval reads it.
  The row is scrubbed when the call is decided. The bundle is bounded (about
  6 MiB) before anything parks.
- The trail records each call (`tool_calls`): parked (`pending_approval`), then
  `ok`/`failed`/`refused` with the `approvalId`, or `approval_declined` /
  `approval_expired`.

## What the owner should know

- **Keep secrets-bearing CI off `seat/**` branches.** A seat writes code that
  CI runs on push. Scope workflows that hold deploy keys or tokens to protected
  branches, or skip `seat/**`.
- **An unconfined named BYO seat runs as you on your machine.** Naming lifts a
  missing sandbox; what the seat does there, it does with your account and
  files. The approval card is the only gate on the GitHub write.

## Prod prerequisites

- **GitHub App permissions.** Only an App owner can change these in GitHub,
  and each installation must accept the new permissions:
  - **Contents: Read and write**, for `git/refs`, `git/trees`, `git/commits`
    and the bundle push;
  - **Pull requests: Read and write**, for `POST /pulls`.
- `SEAT_GITHUB_PUSH_ENABLED=true` turns on `github.push_branch`. It is off by
  default. `commit_files` and `create_pull_request` do not need it.
- The builtin tool Installable reseeds on boot (`seed-builtin-tools`), so
  `github.commit_files` becomes grantable after the deploy.

Code: `services/prWriteScope.ts`, `services/seatGithubCommit.ts`,
`services/toolBrokerService.ts` (`prWriteRefusal`, `requiresApproval`), and
`services/grantBrokerProjectionService.ts` (`HOSTED_PR_WRITE_TOOLS`).
