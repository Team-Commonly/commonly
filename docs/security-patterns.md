# Security patterns — what passes CodeQL, what doesn't

Reference doc for backend authors. Captures the patterns CodeQL's
`js/sql-injection` and `js/nosql-injection` queries accept as
sanitizers, plus the anti-patterns that look safe but fail review.

Updated when a CodeQL battle on a real PR uncovers a non-obvious
shape. Sources at the bottom.

---

## Quick reference

| Source                                         | Sink                                     | Use this              |
|------------------------------------------------|------------------------------------------|-----------------------|
| `req.body.x` / `req.query.x` (HTTP string)     | Mongoose filter scalar (`{ field: x }`)  | [String + replace + roundtrip](#string--replace--roundtrip-the-sanitizer-pattern-codeql-recognises) |
| `req.body.x` (HTTP string)                     | Mongoose `_id` filter                    | [ObjectId.isValid + cast](#objectidisvalid--cast-the-canonical-objectid-sanitizer) |
| Regex capture from message content             | Mongoose filter scalar OR `$in`          | [Avoid putting it in the query at all](#dont-put-user-tainted-strings-in-mongoose-filters-period) |
| `req.params.id` already validated by middleware| Mongoose `_id` filter                    | [Still cast](#objectidisvalid--cast-the-canonical-objectid-sanitizer) — CodeQL won't trust the middleware |

---

## String + replace + roundtrip (the sanitizer pattern CodeQL recognises)

Lives in `backend/routes/registry/install.ts:114-119`. The shape:

```ts
const safeAgentName: string = String(agentName)
  .toLowerCase()
  .replace(/[^a-z0-9@/-]/g, '');
if (!safeAgentName || safeAgentName !== agentName.toLowerCase()
    || !/^(@[a-z0-9-]+\/)?[a-z0-9-]+$/.test(safeAgentName)) {
  return res.status(400).json({ error: 'Invalid agentName: ...' });
}
// safeAgentName is now provably untainted — use directly in filters
```

The pieces CodeQL keys off:

1. `String(x)` coerce to definitely-string.
2. `.replace(/[^safe]/g, '')` strip everything not in an allow-list.
3. **A reject-branch** that exits early when the stripped value differs
   from the original. This is the load-bearing part — without an
   explicit early-exit, CodeQL doesn't trust the cleansing.
4. (optional, belt-and-suspenders) `.test()` final allow-list assertion.

If any of these is missing, CodeQL will still flag the use.

## ObjectId.isValid + cast (the canonical ObjectId sanitizer)

Lives in `backend/services/agentMessageService.ts:~870`. The shape:

```ts
if (mongoose.Types.ObjectId.isValid(podId)) {
  const safePodId = new mongoose.Types.ObjectId(String(podId));
  const podFiles = await File.find({ podId: safePodId }).lean();
  // ...
}
```

The gate (`isValid`) + cast (`new ObjectId(...)`) is the documented
SqlSanitizer for any Mongoose filter targeting an ObjectId field.
**Both halves are required** — `isValid` alone leaves a `string` in
the query and CodeQL still flags it. The `new ObjectId(...)` cast
produces a `Types.ObjectId` instance the analyzer treats as safe.

Don't trust route middleware to have validated the id. CodeQL doesn't
follow middleware-installed properties across the request lifecycle.
Re-validate at every use.

## Don't put user-tainted strings in Mongoose filters, period

The hardest CodeQL case is when the tainted value is a regex capture
from message content (e.g. `match[1]` from a `/\\[\\[upload:([^|\\]]+)/`
extraction). The analyzer doesn't trust regex captures even through
`String + replace + roundtrip + test` — the taint flow chain across
array-build (`referencedNames.push(...)`) + array.filter loses too
much information for the rule to track cleansing.

We hit this on PR #413 across 5 successive iterations of stricter
sanitization (`$in` → per-name `findOne` → 4-gate scalar → 5-gate
scalar). All failed.

**The refactor that worked**: pull the whole legitimate set into
memory in a single query keyed on a known-safe field (the
ObjectId-validated `podId`), then do the comparison in JS. The
user-tainted directive name never enters Mongo.

```ts
// User-tainted: `referencedNames` extracted from message body.
// Don't put them in the query.
const podFiles = await File.find({ podId: safePodId })  // safePodId from ObjectId.isValid
  .select('fileName originalName')
  .limit(FILE_DIRECTIVE_SCAN_LIMIT)
  .lean();
const knownNames = new Set<string>();
for (const f of podFiles) {
  if (f.fileName) knownNames.add(String(f.fileName));
  if (f.originalName) knownNames.add(String(f.originalName));
}
const phantoms = referencedNames.filter((n) => !knownNames.has(n));
```

Perf is acceptable as long as the scan-side dataset is bounded —
`.limit(N)` is the lever. For pod-scoped reads, N=500 covers typical
pod-file counts well above the 99th percentile.

## Anti-patterns

### Don't: `$in` with a user-tainted array

CodeQL flags it even when each element is `String()`-coerced.

```ts
// ❌ Will fail js/nosql-injection
const hit = await File.find({
  fileName: { $in: userTaintedArray },
});
```

### Don't: trust `req.params.x` after middleware

Even when an upstream middleware validated/cast it, CodeQL doesn't
follow request-object property writes. Re-cast at use.

### Don't: use raw `RegExp(userInput)` in queries

ReDoS in addition to NoSQL injection. Build literal regexes or
escape via `escape-string-regexp`.

### Don't: log the raw tainted value back to operators without sanitization

Even diagnostic `console.warn` with the raw value can ship to log
aggregators that interpret `${...}` as template syntax. Coerce
through `String()` and bound length when logging user content.

---

## Sources

- PR #408 — first `String + replace + roundtrip` shape in the
  install endpoint, set the pattern.
- PR #413 — the 5-iteration CodeQL battle that drove the
  in-memory-Set refactor (and revealed regex captures are
  untrackable in our setup).
- CodeQL JS query docs:
  https://codeql.github.com/codeql-query-help/javascript/js-nosql-injection/
