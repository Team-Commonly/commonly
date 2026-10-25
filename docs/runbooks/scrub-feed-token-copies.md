# Scrub legacy feed token copies (TASK-537)

Run after deploying #2692's feed credential writers/readers and response redactor.
SRE executes this through the ops-runner against the intended instance. Do not
run it while an older backend can still write the legacy fields.

This migration **redacts**, rather than imports, `config.accessToken` and
`config.refreshToken` on X and Instagram Integration rows, including disabled
rows and blank/null residue. Existing encrypted feed refs remain authoritative
and unchanged. Other connector types (including GroupMe) are untouched.
A feed with only legacy plaintext already has no usable credential under #2692;
reconnect it to supply a fresh token. Do not reuse an older plaintext copy over a
newer encrypted credential.

From the deployed backend directory, with `MONGO_URI` supplied by the existing
ops-runner secret environment (never paste it into a command):

```sh
npx ts-node scripts/scrub-feed-token-copies.ts
# Review DRY-RUN counts by type, then explicitly apply:
npx ts-node scripts/scrub-feed-token-copies.ts --apply
npx ts-node scripts/scrub-feed-token-copies.ts
```

The final dry run should report zero candidates for both types. Reports contain
only type and counts: candidate rows, access/refresh fields, changed rows and
remaining rows. No credential values, digests, refs or row IDs are fetched or
printed. Apply uses only `$unset` on those two fields; it does not change row
status, identity, encrypted secrets, or other config. Concurrent new writers
preserve encrypted refs; the final count catches any remaining legacy writes.

There is no plaintext rollback. Reconnect a legacy-only feed if needed. If the
command fails, it exits nonzero with a fixed message rather than a database error
that could contain sensitive values. A partial apply is safe to rerun: applied
rows no longer match, and the next dry run counts the remaining rows. Record the
instance, deployed SHA, dry-run/apply/final counts and exit status in the ops
record without secret material. This PR supplies the tool; it does not certify
that an operator has run the scrub on any instance or cleaned older backups.
