# Ref links: counting where signups come from

A link with `?ref=<code>` on any commonly.me page is counted:

- **The signup:** the first ref a browser arrives with is kept in the browser (`frontend/src/v2/utils/firstTouch.ts`). A new account made from that browser, by password or Google/GitHub, stores it once as `onboarding.signupRef`.
- **The visit:** that first arrival also adds one to a per-UTC-day count for the code (`attribution_visits`). Nothing about the visitor is stored.
- **Every landing, ref or not:** see [Landings by site and ref](#landings-by-site-and-ref) below.

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

## Landings by site and ref

`attribution_visits` counts only arrivals that carry a ref, so on its own it can't say whether a post on X or a directory listing sent anyone. `landing_visits` (F528) counts every landing on a public page, per UTC day, keyed by `(ref, referrer)`:

- **ref** is the `?ref` code on the landing URL, or `~none`.
- **referrer** is the referring site's hostname, lower-cased, with a leading `www.` dropped (`x.com`, `t.co`, `devhunt.org`), or `~none`. Only the hostname leaves the browser, never the path or query.
- A value that fails its rule counts as `~other`, and so does an IP address. Past 200 new pairs a UTC day, a new pair counts under `~other`/`~other`. Rows drop 180 days after they were first written.
- The sites a launch read asks about (X and t.co, HN, Product Hunt, GitHub, LinkedIn, Reddit, the main search and AI engines, and our directory listings: `KNOWN_REFERRERS` in `backend/routes/attribution.ts`) always keep their own row when the ref is `~none` or a listed campaign code, so junk that fills the cap can't push them into `~other`. Add a site there before a push that relies on it.
- Nothing about the visitor is stored: no IP, no user agent, no page path. A small site's hostname can still point at one person or company (`jane.substack.com` with a count of 1), so treat a referrer row as you would the signup it might lead to.

**What a landing means.** `public/signup-source.js` sends one per tab (`sessionStorage` is per tab), on static pages and the app alike. Someone who opens three X links to us in three tabs counts three landings.
- A page reached from one of our own pages isn't a landing, and neither is a referrer on `commonly.me`.
- A browser with no session storage isn't counted.
- Crawlers that run no JavaScript never count. Headless walks that do (our own walker included) and team members' own sessions do count, so read small numbers as small.

**Reading it.** One read per day range:

```js
db.landing_visits.aggregate([
  { $match: { day: { $gte: '2026-11-17' } } },
  { $group: { _id: { ref: '$ref', referrer: '$referrer' }, n: { $sum: '$count' } } },
  { $sort: { n: -1 } },
])
```

