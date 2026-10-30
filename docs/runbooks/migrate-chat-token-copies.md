# Move GroupMe tokens and scrub GroupMe/Slack token copies (TASK-539)

This is the GroupMe and Slack follow-up to
[scrub-feed-token-copies](scrub-feed-token-copies.md), which covers X and
Instagram only. SRE runs it through the ops-runner, on the intended instance,
after the build that carries `services/chatConnectorTokens` is live. Don't run
it while an older backend can still write the legacy fields.

**What it changes, by type:**

- **GroupMe.** `config.accessToken` is a live credential. An agent that reads a
  group's history (`GET /api/agents/runtime/pods/:podId/integrations/:id/messages`)
  calls the GroupMe API with it. That reader now takes `config.accessTokenRef`
  only. So the migration **imports**:
  - A row with a plaintext token and no ref has the token encrypted under its id
    (kind `groupme-access-token`). In the same update, the ref is set and the
    plaintext is unset.
  - A row that already has a ref keeps it. The older plaintext copy is dropped
    and is never written over the ref.
  - The import is insert-only. If someone edits the connector while the script
    runs, the edit stores its token between the script's read and its write.
    That newer token wins, and the older copy is dropped. So `--apply` needs no
    write freeze, and `moved` counts only the secrets the script created.
  - `refreshToken` has no reader, because GroupMe issues none. It is unset.
- **Slack.** The bot token is `config.botTokenRef`, written by the OAuth bind.
  Nothing reads a row's own `accessToken` or `refreshToken`, so both are
  **redacted**, not imported.

Between the deploy and `--apply`, a GroupMe row that carries only plaintext
answers the agent read with 400 ("missing accessToken"). Its bot posts and
`!summary` commands are unaffected, because they use `botId`. To keep that
window short, apply soon after the deploy.

From the deployed backend directory, with `MONGO_URI` and the connector secret
key ring (`CONNECTOR_SECRET_KEYS`, `CONNECTOR_SECRET_ACTIVE_KEY`) supplied by the
existing ops-runner secret environment (never paste them into a command):

```sh
npx ts-node scripts/migrate-chat-token-copies.ts
# Review the DRY-RUN counts by type, then explicitly apply:
npx ts-node scripts/migrate-chat-token-copies.ts --apply
npx ts-node scripts/migrate-chat-token-copies.ts
```

**What the counts mean.** The final dry run should report zero candidates and
`toMove=0` for both types. Each line is counts only:

- the candidate rows;
- the access and refresh fields;
- `toMove`, the GroupMe tokens that will be encrypted;
- `moved` and `cleared`;
- `remaining`;
- after `| not written:`, how many rows still carry `botToken`, `signingSecret`
  or `appToken`. Those fields are inventory only and this script never writes
  them. Slack's `botToken` is still a legacy fallback in
  `providers/slackProvider`'s `tokenFor`.

No credential value, ref or row id is printed.

**Failure and reruns.** If the key ring is missing, the GroupMe encrypt throws
before that row is updated, so no row loses its only copy. The command exits
non-zero with a fixed message and never echoes the database error. A partial
apply is safe to rerun: applied rows no longer match, and a moved row's secret is
an upsert on `(integrationId, kind)`.

**Recording and scope.** Record these in the ops record, without secret
material:

- the instance and the deployed SHA;
- the dry-run, apply and final counts;
- the exit status.

The PR that adds this script supplies the tool. It doesn't certify that any
instance has been migrated or that older backups are clean.
