# Opening a GitHub pull request through the grant broker

TASK-783 (F163, D14). A hosted ("Run it here") agent, or a BYO seat a grant
names (F94), opens a pull request on the connected repository through the
grant broker. It never holds git or a GitHub token. The connection owner
approves every call.

## The two GitHub Apps (F172)

A `github-app` connection is one repository on one installation of one App.
The row's `config.app` names the App, and the broker signs that installation's
token with that App's id and key only:

| `config.app` | App | Who can install it | Key (env) | How the connection is made |
|---|---|---|---|---|
| `tools`, or absent | commonly-tools (private) | our own org only | `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` | admin route `POST /api/integrations/github-app` |
| `connect` | Commonly Connect (public, slug `GITHUB_MCP_APP_SLUG`) | anyone | `GITHUB_CONNECT_APP_ID`, `GITHUB_CONNECT_APP_PRIVATE_KEY` | self-serve `POST /api/integrations/github-app/repositories` |

- A row with no `app` was written before F172 and is a tools row.
- A Connect row is never signed with the tools key. Without the Connect key,
  the self-serve route answers `503 github_app_not_configured` and creates
  nothing, `POST /api/grants` refuses `503 github_app_not_configured` on a
  Connect row (so an owner never holds a grant that cannot run), and a call on
  an existing Connect grant refuses `github_app_not_configured` before it
  parks. A row whose `app` names neither
  App refuses `connection_mismatch`, at the mint and at the call.
- Installation tokens are cached per (App, installation, narrowed repository)
  and reused only while they have more than 10 minutes left. A bundle push
  never uses the cache: it mints a fresh token at its start and again right
  before the write.
- Uniqueness is per (App, installation, repository), so one installation can
  back many connections. Rows written since F172 keep the installation in
  `config.installationId` only and leave the top-level `installationId` unset,
  because that field is unique per installation and still holds the older rows.
  A partial unique index (`unique_github_app_repository`) enforces it, and the
  routes check the older rows by query. Grants on these rows name the row
  `_id`: the Tools catalogue offers that `_id` as the row's `connectionId`, and
  `POST /api/grants` with the bare installation id answers
  `connection_not_found` (there is deliberately no installation-only fallback,
  since one installation now backs several repositories). Removing one row revokes only its own grants, not a
  sibling repository's.
- The admin route binds tools installations only. It takes an optional
  `ownerUserId`, which must name an existing human account; the default owner
  is the admin. The same repository twice answers `409 connection_exists`;
  before F172 a repeated POST for the same repository answered `200` with the
  existing row, so a script that re-POSTs must treat 409 as "already there".
- **Access is proved again on every Connect write.** Before a write parks, and
  again (never from cache) before an approved write runs, the broker re-runs
  the create-time proof with the owner's CURRENT user token: the installation
  is visible and is Connect's, not suspended, the repository is listed with
  the same GitHub repository id recorded at create (so a rename, transfer or
  delete-and-recreate does not carry over), and the owner can push. A passing
  park proof is cached for 60 s per row. Any failure refuses
  `connection_unproven` (the proof's code in `details.reason`) and nothing is
  written to GitHub. Tools rows are not re-proved.
- **Removing the owner's GitHub connection** (the hosted-MCP `github-mcp` row)
  disconnects every Connect row they own and revokes those rows' grants,
  before any provider step. A retry after a failed revoke still reaches rows
  the first attempt already disconnected. The rows are kept, so the owner sees them; posting
  the same repository again with a fresh proof reconnects their own row (its
  old grants stay revoked).
- **Connect tokens are narrowed** to the connection's repository
  (`repository_ids` on the token request). A Connect token request with no
  valid repository id (absent, not plain digits, zero, or past the safe-integer
  range) refuses `github_repository_required`; it never mints an
  installation-wide token. Tools tokens are unchanged.
- Removing an older row (one with a top-level `installationId`) revokes only
  grants bound to no row or to that row, never a newer per-repository row's
  grants on the same installation.

### What an outside team does

1. **Connect GitHub** on the Tools page (the hosted-MCP GitHub entry, D248).
   This stores the person's Commonly Connect user token.
2. **Install Commonly Connect** on their account or org, and pick the
   repositories (the install page is `github.com/apps/<slug>/installations/new`).
3. **Connect a repository:** `POST /api/integrations/github-app/repositories`
   with `{ installationId, owner, repo }`. The server reads
   `GET /user/installations` and `GET /user/installations/{id}/repositories`
   with the person's own user token, and creates the connection only when the
   installation belongs to the Connect App (`app_id` equals
   `GITHUB_CONNECT_APP_ID`), is not suspended, lists the repository, and the
   person can push to it. The body's installation id and repository are never
   trusted on their own. Refusals: `github_connect_required` (no or expired
   user token; the body carries the connect path), `installation_not_visible`,
   `installation_suspended`, `repository_not_visible`,
   `repository_write_required`, and `connection_exists` (409). The person is the
   connection's owner, and `DELETE /api/integrations/:id` removes it.
4. **Grant `prWrite`** on that connection as below. Every rule in this runbook
   applies to a Connect connection unchanged.

### What ops sets

- On the Commonly Connect App: **Contents: Read and write** and **Pull
  requests: Read and write**, and generate a private key.
- Two Secret Manager keys with an enabled version:
  `<prefix>github-connect-app-id` and `<prefix>github-connect-app-private-key`.
  Then set `githubConnectApp.enabled: true` in the environment's values. The
  ExternalSecret maps them to `GITHUB_CONNECT_APP_ID` and
  `GITHUB_CONNECT_APP_PRIVATE_KEY` in `api-keys`, and the backend and ops-runner refs are
  optional. Enabling the flag before both keys exist stalls `api-keys`.
- No migration is needed. The old unique index on `installationId` stays and
  blocks nothing new; Mongoose builds `unique_github_app_repository` at boot
  (`autoIndex`), and no existing row carries `config.repoKey`.

## What the owner grants

A pod grant on a **GitHub App** connection (tools or Connect) with:

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

- **GitHub App permissions**, on commonly-tools and on Commonly Connect. Only
  an App owner can change these in GitHub, and each installation must accept
  the new permissions:
  - **Contents: Read and write**, for `git/refs`, `git/trees`, `git/commits`
    and the bundle push;
  - **Pull requests: Read and write**, for `POST /pulls`.
- `SEAT_GITHUB_PUSH_ENABLED=true` turns on `github.push_branch`. It is off by
  default. `commit_files` and `create_pull_request` do not need it.
- The builtin tool Installable reseeds on boot (`seed-builtin-tools`), so
  `github.commit_files` becomes grantable after the deploy.

Code: `services/githubAppNames.ts` and `services/githubAppService.ts` (per-App
signing), `services/githubConnectProof.ts` (self-serve proof),
`services/prWriteScope.ts`, `services/seatGithubCommit.ts`,
`services/toolBrokerService.ts` (`prWriteRefusal`, `requiresApproval`), and
`services/grantBrokerProjectionService.ts` (`HOSTED_PR_WRITE_TOOLS`).

## Walking it (D14)

`scripts/d14-pr-walk.mjs`, dispatched as the **D14 PR walk** workflow
(`.github/workflows/d14-pr-walk.yml`), walks both halves on a throwaway test
repo after a deploy:

Each half runs in its own invite-only pod. A grant pod must be invite-only
(`outsider_grant_pod_joinable`), and its check counts every installed agent, so
a webhook seat beside the hosted agent would refuse the hosted grant
(`non_native_agent`). The hosted half needs prod on the native engine.

- **BYO.** A webhook seat is installed, and naming it without consent must
  refuse `byo_consent_required`. Then a grant names it with consent. The seat
  claims a board task (`continueAnyway`, since it reads nothing else in the
  pod), reads the issue, and is refused a head on the default branch for both
  `create_pull_request` and `commit_files` with exactly
  `branch_not_owned_by_seat`, with no card left behind. Its commit parks, and the branch must not exist until the owner
  approves. One pull request call is declined and must never open. The next is
  approved and must open on `seat/<seatId>/`.
- **Hosted.** A hosted agent is @mentioned with the task, the issue and the
  exact seat branch. The walk waits for its parked commit and checks the head.
  It approves, waits for the parked pull request, checks GitHub is unchanged,
  approves, and checks the PR head and that the agent claimed the task. The
  default-branch refusal is the broker's, so the BYO half covers it for both.

It needs a GitHub App connection on the test repo with the permissions under
*Prod prerequisites*, the owner's Commonly session as `D14_OWNER_TOKEN`, and a
GitHub token limited to the test repo as `D14_GITHUB_TOKEN`. The same script
runs from a shell with those three variables set. Cleanup runs on every outcome:
grants (by `grantId`; a 404 counts as left behind), agents, pods with their
board tasks, pull requests (closed), seat branches and the issue. A
`cleanup` step lists anything left behind.
