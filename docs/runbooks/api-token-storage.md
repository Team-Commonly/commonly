# API token storage rollout

TASK-558 uses the existing SHA-256 credential digest convention (`utils/secret`;
agent runtime and device credentials). New API token issuance returns the bearer
once and stores only its digest and last four characters. Revocation removes
both representations. The auth compatibility reader prefers a digest and only
accepts a legacy row when it has no digest. Metadata, scopes, identities and
existing bearer values survive the backfill.

An existing agent token cannot be retrieved after migration. The user-token
issuance endpoint returns `existing: true`, `token: null`, `requiresRotation:
true` while keeping the existing bearer valid. An authorized caller can explicitly
send `force: true` to replace it. Do not automatically rotate a live agent.

Two consumers depend on getting the bearer back:

- A runtime's saved account (OpenClaw or Commonly bot) keeps its copy across
  reprovisions. An OpenClaw account that has lost its config, or a new one for
  an agent whose token is already a digest, gets no user token, and the
  provisioner logs `has no user token`. Provision that agent with
  `force: true`.
- `commonly dev` rotates its agent's user token with `force: true`. A CLI from
  before this change asks without it and gets no token once the row is a
  digest. Upgrade the CLI before running `commonly dev` against a migrated
  instance.

## Ordered deployment

1. Deploy this compatibility release to staging first. A rolling update keeps
   older pods serving while new ones start, and an older pod reads a
   digest-only row as having no token: it cannot authenticate it, a revoke it
   serves clears only `apiTokenCreatedAt` and leaves the digest valid, and a
   rotate it serves leaves the row holding both a digest and a new bearer. So
   before any step below, wait for `kubectl rollout status deploy/backend` and
   confirm every backend pod reports this release's image tag. Then, before
   the backfill, count what the window left:
   - a digest with no `apiTokenCreatedAt` was revoked by an older pod. Unset
     its `apiTokenHash` and `apiTokenLast4` through the ops runner. (Only new
     issuance writes a digest until the backfill runs, and it always sets the
     date.)
   - a digest beside a different string bearer was rotated by an older pod.
     The dry run in step 3 counts it as a conflict.
2. On staging, create synthetic human and bot tokens, exercise authenticated
   routes and record HTTP status only. Check wrong tokens, ban and revocation.
   Include legacy rows and newly issued digest-only rows.
3. Through the approved ops runner, run the script with staging's `MONGO_URI`:
   `node dist/scripts/backfill-api-token-storage.js`. The image ships compiled
   output only, without `ts-node`.
   Default is dry run. Output contains counts only; do not log rows or tokens.
4. Review counts. Re-run with `--apply`. Assert original human/bot bearers still
   authenticate; scopes and creation dates remain unchanged. Repeat apply must
   report zero candidates and migrated rows. Prove new issuance and revocation
   again. Record environment, deployed SHA, aggregate counts and HTTP statuses.
5. Rhea and Sable review the exact head. SRE repeats steps 1–4 on production only
   after staging proof is recorded and production deployment is authorized.
6. After both environments have zero legacy fields, remove the compatibility
   reader and retired field in a linked follow-up. This rollout is incomplete
   until that follow-up and production verification are observed.

## Refusals and rollback

The script streams only identifier and credential fields needed to hash, never
logs them, and uses compare-and-set on both stored representations. Rotation or
revocation winning the race increments skipped; conflicting representations
increment conflicts. Any remaining legacy field, conflict or skip after apply
needs investigation; never overwrite a newer digest. Exit 2 means counts require
attention, exit 1 means execution failed; rerun dry-run after investigating.

Rollback must retain the digest-capable reader. Once any digest-only row exists,
rolling back to an older binary invalidates those bearers. A hash cannot recover
a token. Do not restore an old credential database snapshot (it can resurrect
revoked tokens); roll forward the reader instead. No instance changes are made
by merging the script.
