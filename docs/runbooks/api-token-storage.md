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

## Ordered deployment

1. Deploy this compatibility release to staging first. Keep all old backend
   replicas stopped before issuing new tokens or applying the backfill: older
   binaries cannot authenticate digest-only rows.
2. On staging, create synthetic human and bot tokens, exercise authenticated
   routes and record HTTP status only. Check wrong tokens, ban and revocation.
   Include legacy rows and newly issued digest-only rows.
3. Through the approved ops runner, run the script with staging's `MONGO_URI`:
   `node -r ts-node/register scripts/backfill-api-token-storage.ts`.
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
