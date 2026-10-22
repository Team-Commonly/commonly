# One active Commonly connection per Slack DM

The installable Slack Events API resolves inbound messages by Slack workspace
and DM channel. If two active Commonly integrations share that pair, inbound
attribution is ambiguous. TASK-262 adds a partial unique index named
`unique_active_slack_dm` and refuses a second confirmation with the existing
Commonly account name. An inactive connection releases the pair.

## Rollout

1. From a trusted operator shell with `MONGO_URI` set, run
   `node backend/scripts/ensure-unique-slack-dm.js`. This is read-only and lists
   duplicate active Slack DM pairs with integration, owner, pod, and installation
   IDs. Keep the output in the private task record because it names users and
   pods.
2. Ask the affected owners which Commonly connection should remain active.
   Record the choice before deactivating or disconnecting any row. Existing
   outbound delivery may reach the same Slack DM from both connections until
   this is resolved.
3. Re-run the read-only command and require `duplicates: []`. Then run
   `node backend/scripts/ensure-unique-slack-dm.js --apply` to create the
   declared index. The script refuses to create it while duplicates remain.
4. Deploy the backend. Confirmation returns `slack_bind_unavailable` if the
   index is absent, so a second bind cannot race past a lookup. Verify the
   index exists, confirm a second account gets `slack_dm_already_bound`, and
   send one inbound Slack DM message to confirm it reaches only the retained
   Commonly pod.

The webhook also drops an inbound message if it encounters two matching active
rows during rollout. It logs the workspace/channel pair for operator repair;
it does not guess which account owns the message.
