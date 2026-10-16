# Ref links: counting where signups come from

A link with `?ref=<code>` on any commonly.me page is counted:

- **The signup:** the first ref a browser arrives with is kept in the browser (`frontend/src/v2/utils/firstTouch.ts`). A new account made from that browser, by password or Google/GitHub, stores it once as `onboarding.signupRef`.
- **The visit:** that first arrival also adds one to a per-UTC-day count for the code (`attribution_visits`). Nothing about the visitor is stored.

A code is letters, digits, `-` and `_`, at most 32 characters, and is lower-cased. Anything else is dropped.

## Link format

`https://commonly.me/?ref=x`, or any path with the ref beside other params:
`https://commonly.me/v2/agents/byo?mode=hosted&ref=email`.

## What a visit means

A visit is the **first** ref a browser ever arrives with, not a click.

- A browser that first came with `?ref=x` and later with `?ref=email` counts once, for `x`, and its signup is attributed to `x`.
- A signed-in visitor counts as a visit, if it's their browser's first ref, but never as a signup.
- Crawlers that run no JavaScript never count.

## Add a campaign code BEFORE its links go out

Listed codes always get their own count. Unlisted codes share 50 new slots a UTC day, and past that they count as `~other`. Anyone sending made-up codes can fill those slots, so an unlisted code's visits can quietly land in `~other`.

The list is one `system_settings` row, `attribution.refs`. It takes effect within a minute, with no deploy:

```bash
# add a code (here: li); $addToSet is a no-op if it is already there
kubectl exec -i -n commonly-dev deploy/backend -c backend -- env NODE_PATH=/app/node_modules node -e '
const m = require("mongoose");
m.connect(process.env.MONGO_URI).then(async () => {
  await m.connection.db.collection("system_settings").updateOne(
    { key: "attribution.refs" },
    { $addToSet: { value: "li" }, $set: { updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } },
    { upsert: true });
  const row = await m.connection.db.collection("system_settings").findOne({ key: "attribution.refs" });
  console.log("campaign refs:", row.value.join(", ")); process.exit(0);
});'
```

If the row is missing, empty or unreadable, the list is `['x']`, never "allow all". An entry that isn't a valid code is ignored.

## Reading it

The operator daily pull prints an `XREF` line: signups with ref=x over 24h and 7d (outside vs. all), and ref=x visits today and over 7d. Signups from before the capture shipped (2026-10-16, #2281) have no ref.
