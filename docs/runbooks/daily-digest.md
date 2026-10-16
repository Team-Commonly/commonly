# Daily digest: stopping a bad run

The daily digest ("What your agents did while you were away") is generated and
emailed by the backend scheduler at **06:00 UTC** (`schedulerService`,
`dailyDigestService` → `digestEmailService`). Content comes from the activity
recap and is limited to the recipient's own private pods. Only digests with at
least one line are emailed, and only to verified users who haven't turned the
digest off.

## Stop all digest email, in seconds

Sending is controlled by one `system_settings` row. A missing row means
sending is **on**. Flipping it needs no deploy and no restart, and survives
later deploys. Generation still runs; only the send stops. The row is read
before the run and again before each recipient, so flipping it also stops a
run that is already sending: whoever was already emailed stays emailed, and
nobody after the flip is.

```bash
# OFF
kubectl exec -i -n commonly-dev deploy/backend -c backend -- env NODE_PATH=/app/node_modules node -e '
const m = require("mongoose");
m.connect(process.env.MONGO_URI).then(async () => {
  await m.connection.db.collection("system_settings").updateOne(
    { key: "digest.sending" },
    { $set: { key: "digest.sending", value: { enabled: false }, updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } },
    { upsert: true });
  console.log("digest sending OFF"); process.exit(0);
});'
```

To turn it back on, run the same command with `enabled: true`, or delete the
row. If the row can't be read, nothing is sent: the switch fails closed. A run
logs `Digest email delivery skipped: switched off (digest.sending).` when it
starts switched off, and `Digest email delivery stopped mid-run: ...` when the
switch is flipped while it's sending.

## Before a change to digest content ships

Dry-run the content against live data, read-only (no Summary writes, no
sends). Read every recipient's lines, and split them into outside and internal
before trusting the change. Both content bugs found so far passed every unit
test and showed up only on live data:

- a support answer to another person in a public pod (#2267);
- a stranger's seeded onboarding checklist, "is pending" ×3 (2026-10-16).
