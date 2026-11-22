# ADR-036: Argument limits on connector grants

**Status:** Proposed 2026-11-19, open for comment. Nothing is built yet. Building waits until the
merge-queue support for the signed-review check (#791) lands, so the warrant shape is settled once
and nobody builds this twice. It moves to Accepted once the comment round closes, before anything
is built, so it never ships as an unratified decision. The Tenuo mapping is settled (D8). Acknowledged
unknowns: whether a later `each` form should reach nested arguments, and which derived arguments join
D3's list; see §5.

**Scope.** [ADR-025](ADR-025-connector-substrate.md) owns `RoomGrant` and the tool broker, and
[ADR-033](ADR-033-grant-record.md) owns the grant record. This ADR adds one optional field to a
grant and the rules for checking, narrowing and recording it. D7 amends ADR-033's record schema by
one optional field. Everything else about a grant stays as those ADRs define it.

## 1. Context

A grant says which agents may use one person's connection, and how
([model](../../backend/models/RoomGrant.ts)):

- `tools`: which broker tools;
- `writeMode`: `read`, `write` or `write-with-confirm`;
- `budget`: calls per window;
- `target`, `audience`: which pod or seat, and which agents in it;
- `binding`: the task the grant ends with;
- `expiresAt`, `prWrite`.

A child grant can only narrow these. `attenuateGrant`
([service](../../backend/services/roomGrantService.ts)) refuses with `grant_not_attenuated` when a
child's tools, audience, write mode, budget or `prWrite` is wider than its parent's. It clamps a
later expiry to the parent's, and the child inherits the parent's target and binding.

What a grant can't say is "this tool, but only with these arguments". Where we need that today, it
is code written for one tool:

- `github.push_branch`, `github.commit_files` and `github.create_pull_request` only accept branches
  in the calling seat's own namespace, `seat/<agentUserId>/...` (`parseSeatPushArgs`,
  `assertOwnedSeatBranch`).
- `github.merge_pull_request` reads the pull request's head SHA when the call is parked for
  approval (`prepareApproval`). If the head moves before the merge, GitHub refuses it with a 409,
  which the broker reports as `merge_head_mismatch`.

Each new limit of this kind means another per-tool rule. A grant should be able to carry such limits
as data that the owner or the minting code writes.

The signed-review prototype on #791 expresses limits as data. As we read it, its warrant maps a
tool to its arguments and each argument to a constraint (the merge tool's `repo`, `pr` and
`head_sha`). Its verifier checks arguments it reads from GitHub itself, never the ones the caller
presents. If grants use a similar shape, issuing a grant as a warrant later (D8) should need little
translation.

## 2. Decision

**D1. A grant gains optional `argLimits`.** The shape is `{ [tool]: { [argument]: Limit } }`. A tool
named in `argLimits` must also be in `tools`. A grant without `argLimits` behaves exactly as today.

Limits apply per tool, not per effect. If two tools in a grant reach the same thing, each needs its
own limit: a limit on `github.comment_on_pull_request`'s `pullNumber` doesn't cover
`github.review_pull_request_comment`.

**D2. Five kinds of limit, and no more.** Each kind was chosen so that "is this child limit within
its parent's?" is a direct comparison, with no search:

| Kind | Applies to | Passes when |
|---|---|---|
| `{ "exact": v }` | string, number, boolean | the argument equals `v` |
| `{ "oneOf": [v, ...] }` (1 to 50 values) | string, number | the argument is in the list |
| `{ "prefix": "s" }` (non-empty) | string | the argument starts with the literal `s` (no wildcards) |
| `{ "range": { "min": a, "max": b } }` (either end optional) | number | `a <= argument <= b` |
| `{ "subsetOf": [v, ...] }` (0 to 50 values) | array of strings | every element is in the list |

An empty `subsetOf` means the array must be empty, for example an issue with no labels.

`prefix` is for identifiers such as branch names, never file paths: `docs/` is a literal prefix of
`docs/../.github/workflows/x.yml`. A limit on paths would be its own kind, one that resolves `..`
before comparing (Tenuo's `Subpath`), and is not in this ADR.

There is no regular expression or expression language. Neither has a cheap narrowing check, and a
regular expression run against agent-supplied text is a denial-of-service risk.

**D3. Validated when minted.** Otherwise minting fails with `invalid_grant` (400), so a typo can't
create a limit that silently never applies. Each limit must name either:

- an argument the tool declares limitable, with a kind that fits the argument's schema type.
  Limitable arguments are identifiers and choices, such as `pullNumber`, `issueNumber`, `base`,
  `head`, `ref`, `mergeMethod` and `labels`. Free text never is: `title`, `body`, `message` and file
  contents can't take a limit. Pinning free text to an exact value has no use, and a limit holding
  free text could carry a credential into the record (D7); or
- an argument the server derives itself, from a short per-tool list. Today the list has one entry,
  `github.merge_pull_request`'s `headSha`, which `prepareApproval` reads from GitHub.

The repository isn't on that list. A GitHub connection is already pinned to one repository, and the
GitHub tools' schemas don't let an agent name another.

Minting also refuses:

- a `range` with `min > max`, or a bound that isn't a finite number or is outside ±2^53, past which
  an integer bound stops being exact in a warrant's floating-point range (D8);
- an empty `oneOf` (remove the tool from `tools` instead);
- an empty `prefix`, which would pass everything;
- a `prefix` containing `*`, `?`, `[`, `]`, `{`, `}` or `\`. The broker compares a prefix literally,
  but a warrant carries it as a glob (D8), and glob syntax may read any of these differently. The
  refusal costs little: Git refs can't contain `*`, `?`, `[` or `\` at all.

**D4. Checked by the broker at all three points a call can reach a provider.** A new
`assertGrantArgsAllowed(grant, tool, args)` sits beside `assertGrantToolAllowed`. It checks the
grant and each ancestor in its lineage. D5 makes the leaf enough for new grants, but the lineage is
already loaded, and checking every ancestor also covers grants minted before this field existed.

The three points, in
[`toolBrokerService.ts`](../../backend/services/toolBrokerService.ts):

1. **A direct call**, which needs no confirmation. This covers read tools and writes on a `write`
   grant. The check runs after the arguments are parsed (and, for hosted tools, checked against the
   pinned schema) and before the budget reservation, against the arguments as sent.
2. **A call that needs confirmation.** The check runs after `prepareApproval` returns and before
   the approval card is parked, against the arguments `prepareApproval` returns, which include the
   derived values. So the owner is never asked to approve a call the grant forbids.
3. **Approved execution.** The check runs in the approved call's permission check, before the
   provider call. It uses the approved arguments, whose digest is already verified there, before
   the repository fields are stripped for the provider.

The rules at every point:

- An argument named in a limit but missing from the call fails. Otherwise an optional argument with
  a provider default would slip past: a merge without `mergeMethod` gets GitHub's default method.
- Values are compared strictly, with no type coercion: `4222` and `"4222"` are different.
- The values checked are the values sent. Where a tool normalizes an argument (trimming a branch
  name, for example), the check runs on the normalized value and the provider receives that same
  value, so nothing changes between the check and the call.
- It fails closed. This is an authorization limit, so an unreadable or unknown limit refuses the
  call.
- A refusal returns 403 `arg_not_allowed` with `{ tool, argument }`. It writes a `refused`
  `tool_calls` row with that reason, and the argument's value stays out of logs.
- Limits name top-level arguments only. A nested value, such as each `files[].path` in
  `github.commit_files`, can't be limited (open question 3). That tool keeps its own broker rule,
  as the seat-branch check does.

**D5. A child may only narrow.** When `attenuateGrant` mints a child:

- every limit the parent has on a tool the child keeps must also be on the child, and must be within
  the parent's;
- the child may add limits the parent doesn't have.

A limit is within another only in the cases below; any other pair is refused with
`grant_not_attenuated`. Types are strict here too.

| Child | Parent | Within when |
|---|---|---|
| `exact a` | `exact b` | `a == b` |
| `exact a` | `oneOf S` | `a` is in `S` |
| `oneOf T` | `oneOf S` | every element of `T` is in `S` |
| `exact s` (a string) or `prefix q` | `prefix p` | `s` or `q` starts with `p` |
| `exact n` (a number) | `range [a, b]` | `n` is inside `[a, b]` |
| `range [c, d]` | `range [a, b]` | `a <= c` and `d <= b` |
| `subsetOf T` | `subsetOf S` | every element of `T` is in `S` |

For `range`, a missing end means unbounded. A child may leave out `min` (or `max`) only if its
parent also leaves it out.

**D6. Agents see their limits.** `tools/list` for a grant adds each limited tool's limits to its
description in plain words, for example "pullNumber must be 4222; mergeMethod must be squash". An
agent learns the boundary from the tool list, not by being refused.

**D7. Recorded in full when issued.** The `grant.issued` record line (ADR-033) gains
`scope.argLimits`, holding the limits as minted. This amends ADR-033's record schema. The change is
additive: readers ignore unknown fields, so `v` stays 1 under ADR-033's own rule. Limits are policy
the granter wrote, not call arguments, so they are recorded as written. D3 keeps them to
identifiers and choices, and ADR-033's no-credential rule still binds: the writer applies the same
known-value redaction to `argLimits` as to any other text it records.

Call arguments stay out of the record. ADR-033 records at most an `argsDigest` of a call's
arguments, and its launch rule (its §8 question 9) omits even that from every server record line
and export, because a digest of a guessable argument can be reversed. Nothing here changes that
rule.

**D8. A grant may later be issued as a warrant.** Once agents hold their own keys (the #791 work),
a grant could be issued to an agent's key as a warrant. Roughly:

- `tools` plus `argLimits` become the warrant's allowed tools and constraints;
- `expiresAt` becomes the warrant's expiry;
- the agent's key becomes the holder;
- a child grant becomes a narrowed warrant.

Each kind has a direct Tenuo constraint (confirmed by the Tenuo maintainer on this ADR's PR,
2026-11-22):

| Kind | Tenuo constraint | Note |
|---|---|---|
| `exact` | `Exact` | Types are strict, as D4 wants: `4222` is not `"4222"`. |
| `oneOf` | `OneOf` | |
| `prefix` | `Pattern("<s>*")` | A trailing glob, hence D3's refusal of glob syntax in `s`. |
| `range` | `Range` | Inclusive, either end optional; bounds are floating-point (D3). |
| `subsetOf` | `Subset` | An empty list allows only an empty array. |

Every narrowing pair in D5 is one Tenuo already checks, so a warrant narrowed from a warrant answers
as `attenuateGrant` does. A warrant refuses a missing constrained argument (as D4 does) and any
argument a constrained tool doesn't name, so the conversion lists each argument without a limit as
a wildcard, or allows unknown arguments for that tool. The broker stays the enforcer for brokered
calls. The warrant lets a verifier outside the instance, such as a required check, check the same
limits.

## 3. Examples

A reviewer agent that may comment on one pull request and nothing else:

```json
{
  "tools": ["github.comment_on_pull_request"],
  "argLimits": {
    "github.comment_on_pull_request": { "pullNumber": { "exact": 4222 } }
  }
}
```

An agent that may merge one pull request, at the head it was reviewed at, by squash only:

```json
{
  "tools": ["github.merge_pull_request"],
  "argLimits": {
    "github.merge_pull_request": {
      "pullNumber": { "exact": 4222 },
      "headSha": { "exact": "0123456789abcdef0123456789abcdef01234567" },
      "mergeMethod": { "exact": "squash" }
    }
  }
}
```

An agent that may open pull requests into `main` only. A grant with pull-request access can hold no
other GitHub write, so this is a separate grant from the merge grant above:

```json
{
  "tools": ["github.create_pull_request"],
  "writeMode": "write-with-confirm",
  "prWrite": true,
  "argLimits": { "github.create_pull_request": { "base": { "exact": "main" } } }
}
```

An agent that may file issues carrying only these labels:

```json
{
  "tools": ["github.create_issue"],
  "argLimits": { "github.create_issue": { "labels": { "subsetOf": ["bug", "triage"] } } }
}
```

## 4. Not in this ADR

- A UI for setting limits. The first callers set them through the grant API.
- Deriving limits from a task binding automatically, such as a grant bound to a task about one
  pull request getting `pullNumber: exact`. This is a natural next step, but a separate decision.
- Limits on `commonly_*` kernel tools, which don't go through a connector grant.
- Keys and signatures, which belong to #791 and [ADR-030](ADR-030-agent-identity.md).

## 5. Open questions

1. *Answered.* How each kind maps onto Tenuo's constraints is in D8. `prefix` maps to a trailing
   glob and stays for identifiers (D2), and `subsetOf` maps to `Subset`.
2. Should a limit be able to name a default for a missing argument? Proposed: no. A missing argument
   fails (D4), and the agent passes it explicitly.
3. Should limits reach nested arguments? The case that matters is a path prefix on every
   `files[].path` in `github.commit_files`, which would keep an agent's commits inside one
   directory. Decided for the first build: top-level arguments only. Tenuo's constraints are
   top-level too, so an `each` form would change the warrant format and is a separate decision.
   A path limit inside it would need the path kind D2 describes, not `prefix`.
4. Which other derived arguments belong on D3's list as more tools are added?

## 6. Build plan, once #791's merge-queue support lands

One PR:

- the model field and its validation (D1–D3);
- the broker check at all three points (D4);
- the narrowing rules in `attenuateGrant` (D5);
- the `tools/list` cue (D6) and the record field (D7).

Tests:

- a unit table covering every pair in D5, both within and refused;
- one service test per D4 point:
  - a direct read call refused before any budget is spent;
  - a confirmation call refused before its card is parked;
  - the check running on approved execution, before the provider call;
- a test that a missing limited argument fails, and that `4222` and `"4222"` are different values;
- mint-time refusals for each D3 case.
